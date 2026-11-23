package mailfront

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/projection"
)

// Accounts is the projection as the front reads it: by login at sign-in, and by
// id for the sweep. *projection.Postgres is the production one.
type Accounts interface {
	AccountByLogin(ctx context.Context, login string) (*projection.Account, error)
	AccountsByUIDs(ctx context.Context, clerkUserIDs []string) ([]projection.Account, error)
}

// live is one authenticated connection the sweeper watches.
type live struct {
	grant Grant
	close func(reason string)
}

// registry holds every authenticated connection on this front.
type registry struct {
	mu    sync.Mutex
	next  uint64
	conns map[uint64]*live
}

func newRegistry() *registry { return &registry{conns: map[uint64]*live{}} }

// add starts watching a connection and returns the function that stops it.
func (r *registry) add(g Grant, closeFn func(reason string)) (remove func()) {
	r.mu.Lock()
	r.next++
	id := r.next
	r.conns[id] = &live{grant: g, close: closeFn}
	r.mu.Unlock()
	return func() {
		r.mu.Lock()
		delete(r.conns, id)
		r.mu.Unlock()
	}
}

func (r *registry) len() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.conns)
}

// snapshot copies the live set, so the query and the closing run without the
// lock: a connection that ends meanwhile is closed twice, which is a no-op.
func (r *registry) snapshot() []*live {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]*live, 0, len(r.conns))
	for _, l := range r.conns {
		out = append(out, l)
	}
	return out
}

// Sweeper closes connections whose account has lost access since they signed
// in. See the "Mail front" section of services/authd/README.md.
type Sweeper struct {
	Accounts Accounts
	Interval time.Duration
	Timeout  time.Duration
	Log      *slog.Logger

	reg *registry

	// failing is the start of the current streak of failed sweeps, for the log.
	failing    time.Time
	lastLogged time.Time
}

// SweepStats is what one sweep did, for the log and the benchmark.
type SweepStats struct {
	Live, Accounts, Closed int
	Query, Total           time.Duration
	Err                    error
}

// Run sweeps every Interval until ctx ends, or less often when sweeps are slow.
func (s *Sweeper) Run(ctx context.Context) {
	wait := s.Interval
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		st := s.Sweep(ctx)
		s.report(st)
		wait = s.nextWait(st)
		if wait > s.Interval {
			s.Log.Warn("sweep is slow: waiting longer before the next, so open connections outlive a revocation longer",
				"query", st.Query.String(), "accounts", st.Accounts, "nextIn", wait.String())
		}
	}
}

// maxDutyCycle is the share of one database backend a front's sweeps may hold.
const maxDutyCycle = 5

// nextWait is how long to wait before the next sweep.
//
// ⚠ A SLOW SWEEP STRETCHES THE INTERVAL; IT NEVER RUNS BACK TO BACK. At least
// maxDutyCycle times the last query passes between two, so one front holds a
// database backend at most a fifth of the time, whatever the live set costs.
// The price is a longer window for a revocation to close an open connection,
// which is logged. The fix for that is a cheaper query, not a busier database
// (see the scale measurements in docs/research/mail-device-binding.md).
func (s *Sweeper) nextWait(st SweepStats) time.Duration {
	return max(s.Interval, maxDutyCycle*st.Query)
}

// Sweep runs one pass. With no live connection it does nothing, not even a
// query.
//
// ⚠ ONE QUERY FOR EVERY ACCOUNT, NOT ONE PER CONNECTION: distinct ids, `= ANY($1)`
// on the primary key (projection.SweepQuery).
//
// ⚠ THE MAXIMUM AGE NEEDS ONLY THE CLOCK, SO IT IS ENFORCED FIRST, WHATEVER THE
// QUERY DOES. A pass-through session past its Until is closed before the query
// runs, and the query is not asked about it. It is the one bound on a
// revocation in a company's directory, and an outage of ours must not lift it.
//
// ⚠ A FAILED QUERY CLOSES NOTHING ELSE. Closing every connection because the
// database blinked would disconnect every mail client at once, and each would
// reconnect into an authd that cannot verify it either. A revocation made during
// the outage still reaches the rows, and the first sweep that can read them
// closes the connection. The cost is that an outage stretches the window, which
// is logged loudly (report).
func (s *Sweeper) Sweep(ctx context.Context) SweepStats {
	start := time.Now()
	all := s.reg.snapshot()
	st := SweepStats{Live: len(all)}
	at := time.Now()
	conns := all[:0:0]
	for _, c := range all {
		if c.grant.expired(at) {
			c.close(ReasonMaxAge)
			st.Closed++
			continue
		}
		conns = append(conns, c)
	}
	if len(conns) == 0 {
		st.Total = time.Since(start)
		return st
	}
	seen := make(map[string]struct{}, len(conns))
	ids := make([]string, 0, len(conns))
	for _, c := range conns {
		if _, ok := seen[c.grant.AccountID]; !ok {
			seen[c.grant.AccountID] = struct{}{}
			ids = append(ids, c.grant.AccountID)
		}
	}
	st.Accounts = len(ids)

	qctx, cancel := context.WithTimeout(ctx, s.Timeout)
	qstart := time.Now()
	rows, err := s.Accounts.AccountsByUIDs(qctx, ids)
	st.Query = time.Since(qstart)
	cancel()
	if err != nil {
		st.Err = err
		st.Total = time.Since(start)
		return st
	}
	byID := make(map[string]*projection.Account, len(rows))
	for i := range rows {
		byID[rows[i].ClerkUserID] = &rows[i]
	}
	for _, c := range conns {
		if reason := c.grant.revoked(byID[c.grant.AccountID]); reason != "" {
			c.close(reason)
			st.Closed++
		}
	}
	st.Total = time.Since(start)
	return st
}

func (s *Sweeper) report(st SweepStats) {
	now := time.Now()
	if st.Err != nil {
		if s.failing.IsZero() {
			s.failing = now
		}
		// Loud, but not once a second for an hour: the first failure, then once
		// a minute while it lasts.
		if s.lastLogged.IsZero() || now.Sub(s.lastLogged) >= time.Minute {
			s.Log.Error("sweep failed: NOT closing any connection until the projection answers",
				"live", st.Live, "failingFor", now.Sub(s.failing).Round(time.Second).String(), slog.Any("err", st.Err))
			s.lastLogged = now
		}
		return
	}
	if !s.failing.IsZero() {
		s.Log.Warn("sweep recovered", "failedFor", now.Sub(s.failing).Round(time.Second).String())
		s.failing, s.lastLogged = time.Time{}, time.Time{}
	}
	if st.Live > 0 {
		s.Log.Debug("sweep", "live", st.Live, "accounts", st.Accounts, "closed", st.Closed,
			"query", st.Query.String(), "total", st.Total.String())
	}
}
