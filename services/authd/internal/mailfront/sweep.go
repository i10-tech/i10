package mailfront

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/projection"
)

// Accounts is the projection as the front reads it: by login at sign-in, the
// access-change log and by id for the re-checks. *projection.Postgres is the
// production one.
type Accounts interface {
	AccountByLogin(ctx context.Context, login string) (*projection.Account, error)
	AccountsByUIDs(ctx context.Context, clerkUserIDs []string) ([]projection.Account, time.Duration, error)
	AccessChanges(ctx context.Context, since string, limit int) (projection.ChangeBatch, error)
}

// live is one authenticated connection the sweeper watches.
type live struct {
	// seq orders registrations, so a poll can tell which connections are new
	// since the last one (Sweeper.Poll).
	seq   uint64
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
	r.conns[id] = &live{seq: id, grant: g, close: closeFn}
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
// lock: a connection that ends meanwhile is closed twice, which is a no-op. upTo
// is the last seq handed out: every connection registered later has a higher one.
func (r *registry) snapshot() (conns []*live, upTo uint64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]*live, 0, len(r.conns))
	for _, l := range r.conns {
		out = append(out, l)
	}
	return out, r.next
}

// Defaults for the parts of a Sweeper that main does not configure.
const (
	// DefaultBackstop is how often every open connection is re-checked whatever
	// the access-change log says: the bound for a change the log missed.
	DefaultBackstop = time.Minute

	// DefaultMaxChanges is the most changes one poll reads. More, and it asks
	// for a full sweep instead.
	DefaultMaxChanges = 10000

	// maxPositionAge is how old the poll's position may be before the next
	// successful poll re-checks everything instead of reading from it. Far below
	// the hour the log keeps its rows (`authd.prune_access_changes`), so the rows
	// a poll reads from its position are never pruned under it.
	maxPositionAge = 10 * time.Minute
)

// Sweeper closes connections whose account has lost access since they signed
// in. See "The sweep" in the "Mail front" section of services/authd/README.md.
//
// It runs two loops (Run). Every Interval, Poll reads what changed since its
// last read (`authd.access_changes`) and re-checks the connections that names,
// plus every connection that signed in since. Every Backstop, and whenever a
// poll cannot tell whom its changes name, Sweep re-checks every connection.
// Both decide with the same code, Grant.revoked.
type Sweeper struct {
	Accounts   Accounts
	Interval   time.Duration
	Backstop   time.Duration
	Timeout    time.Duration
	MaxChanges int
	Log        *slog.Logger

	reg *registry

	// fullSweep is a poll's request for a full sweep now (requestSweep). One slot:
	// requests made before the sweep loop takes one are the same request, and
	// nothing queues behind it.
	fullSweep chan struct{}

	// The poll's position, read and written only by Poll: the snapshot and
	// server start time (`pg_postmaster_start_time()`) of its last successful
	// read ("" / zero for none), when that read began, and the last
	// registration it covered.
	since      string
	sinceStart time.Time
	sinceAt    time.Time
	seen       uint64

	pollReport, sweepReport failureLog
}

// SweepStats is what one poll or sweep did, for the log and the benchmark.
type SweepStats struct {
	Live, Accounts, Closed int
	// Changes is how many log rows the poll read. Full is set, with FullWhy, on
	// every sweep, and on a poll that asked for one instead of re-checking the
	// connections its changes name.
	Changes int
	Full    bool
	FullWhy string
	// Log is the log read and Query the accounts read, each the database's own
	// time without the wait for a pooled connection; Total is the whole pass.
	Log, Query, Total time.Duration
	Err               error
}

// Run polls every Interval and sweeps every Backstop until ctx ends, each less
// often when its queries are slow, and sweeps as soon as it may when a poll
// asks for it.
//
// ⚠ TWO LOOPS, NOT ONE. A full sweep over 50,000 accounts takes seconds; run in
// the poll's loop it would hold every revocation back by that long once a
// minute. Apart, the poll keeps its second and the sweep its minute. They share
// only the registry and the request channel, and a connection both close is
// closed twice, a no-op.
func (s *Sweeper) Run(ctx context.Context) {
	go s.loop(ctx, "sweep", s.backstop(), s.Sweep, &s.sweepReport, s.fullSweep)
	s.loop(ctx, "poll", s.Interval, s.Poll, &s.pollReport, nil)
}

func (s *Sweeper) backstop() time.Duration {
	if s.Backstop > 0 {
		return s.Backstop
	}
	return DefaultBackstop
}

func (s *Sweeper) maxChanges() int {
	if s.MaxChanges > 0 {
		return s.MaxChanges
	}
	return DefaultMaxChanges
}

// requestSweep asks the sweep loop for a full sweep as soon as it may run one,
// without waiting for it.
func (s *Sweeper) requestSweep() {
	select {
	case s.fullSweep <- struct{}{}:
	default: // one is already asked for and not yet started: it covers this one
	}
}

// loop runs pass every `every` (stretched by nextWait), and also when wake
// delivers a request (a nil wake never does).
//
// ⚠ A REQUESTED PASS STARTS AFTER THE REQUEST, NEVER BEFORE. The request is taken
// from the channel before the pass begins, so the pass reads its registry and its
// rows after whatever the requester did before asking. A request made while a
// pass is running stays in the channel and starts another pass after it: the
// running one may have read its rows before the requester's log read.
//
// ⚠ A REQUESTED PASS STILL KEEPS THE DUTY CYCLE, and never starts sooner than one
// poll Interval after the last pass ended, so a stream of requests, or a
// database that fails every pass, cannot run sweeps back to back. A requested
// pass that fails asks again, so the requester's coverage is retried at that
// pace rather than at the next Backstop.
func (s *Sweeper) loop(ctx context.Context, what string, every time.Duration, pass func(context.Context) SweepStats,
	rep *failureLog, wake chan struct{}) {
	wait, earliest := every, time.Time{}
	for {
		timer := time.NewTimer(wait)
		requested := false
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		case <-wake:
			timer.Stop()
			requested = true
			if !sleepUntil(ctx, earliest) {
				return
			}
		}
		st := pass(ctx)
		rep.report(s.Log, what, st)
		if requested && st.Err != nil {
			select {
			case wake <- struct{}{}:
			default:
			}
		}
		wait = nextWait(every, st)
		earliest = time.Now().Add(max(s.Interval, maxDutyCycle*(st.Log+st.Query)))
		if wait > every {
			s.Log.Warn(what+" is slow: waiting longer before the next, so open connections outlive a revocation longer",
				"log", st.Log.String(), "query", st.Query.String(), "accounts", st.Accounts, "nextIn", wait.String())
		}
	}
}

// sleepUntil waits until t, or returns false when ctx ends first.
func sleepUntil(ctx context.Context, t time.Time) bool {
	d := time.Until(t)
	if d <= 0 {
		return ctx.Err() == nil
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

// maxDutyCycle is how many times its last pass's query time each loop waits
// before the next pass.
const maxDutyCycle = 5

// nextWait is how long to wait before the next pass of a loop that runs every
// `every`.
//
// ⚠ A SLOW PASS STRETCHES THE INTERVAL; IT NEVER RUNS BACK TO BACK. At least
// maxDutyCycle times the last pass's queries go by before the next, so each loop
// holds a database backend at most a sixth of the time (T busy, then 5T idle),
// whatever the live set costs. The price is a longer window for a revocation to
// close an open connection, which is logged. The fix for that is a cheaper
// query, not a busier database (see the scale measurements in
// docs/research/mail-device-binding.md). The times are the database's own
// (projection.Postgres.queryTimed): a pool whose connections are all busy, as in
// a reconnect storm, does not stretch the interval while the database is idle.
func nextWait(every time.Duration, st SweepStats) time.Duration {
	return max(every, maxDutyCycle*(st.Log+st.Query))
}

// Sweep re-checks every live connection: the backstop, once a minute. With no
// live connection it does nothing, not even a query.
//
// ⚠ ONE QUERY FOR EVERY ACCOUNT, NOT ONE PER CONNECTION: distinct ids, `= ANY($1)`
// on the primary key (projection.SweepQuery).
//
// ⚠ THE MAXIMUM AGE NEEDS ONLY THE CLOCK, SO IT IS ENFORCED FIRST, WHATEVER THE
// QUERY DOES. A pass-through session past its Until is closed before the query
// runs, and the query is not asked about it. It is the one bound on a
// revocation in a company's directory, and an outage of ours must not lift it.
// Poll enforces it the same way, every second.
//
// ⚠ A FAILED QUERY CLOSES NOTHING ELSE. Closing every connection because the
// database blinked would disconnect every mail client at once, and each would
// reconnect into an authd that cannot verify it either. A revocation made during
// the outage still reaches the rows, and the first pass that can read them
// closes the connection. The cost is that an outage stretches the window, which
// is logged loudly (failureLog).
func (s *Sweeper) Sweep(ctx context.Context) SweepStats {
	start := time.Now()
	all, _ := s.reg.snapshot()
	st := SweepStats{Live: len(all), Full: true, FullWhy: "backstop"}
	conns := expire(all, &st)
	if len(conns) > 0 {
		qctx, cancel := context.WithTimeout(ctx, s.Timeout)
		st.Err = s.recheck(qctx, conns, &st)
		cancel()
	}
	st.Total = time.Since(start)
	return st
}

// Poll reads what changed since the last poll and re-checks the live
// connections it names, plus every connection that signed in since the last
// poll. With no live connection it does nothing, not even a query.
//
// A change names a connection by its account (`account`), by the domain of the
// address it signed in with (`domain`), or by the SSO connection that answers
// for it (`connection`). A truncated gate table (`all`), more changes than
// MaxChanges, an unknown kind, a position older than maxPositionAge,
// transaction ids that went back (projection.ChangeBatch.Rewound), or a changed
// database server start time (projection.ChangeBatch.ServerStart) make it ask
// the sweep loop for a full sweep instead (Full), which is logged.
//
// ⚠ A FULL POLL HANDS EVERYTHING TO THE SWEEP AND KEEPS ITS OWN SECOND. Re-checking
// 50,000 accounts takes seconds; done here, it would hold the next targeted
// revocation back by that long, and the duty cycle would stretch the poll's
// interval for the next 5x as long. So it asks for a sweep (requestSweep),
// advances its position as if it had re-checked everyone, and polls again at its
// interval. That is safe because the sweep it asked for re-checks every
// connection with a row read after this poll's log read: the request is made
// after the log read, and the sweep loop takes it before the pass that answers
// it begins, so that pass's registry snapshot and its row read both come later
// (Sweeper.loop). A connection in this poll's registry snapshot is either still
// registered then, and re-checked, or gone. One registered later has a seq above
// the position, and the next poll re-checks it as new.
// TestAFullPollIsAnsweredByASweepThatStartsAfterIt pins it.
//
// ⚠ EVERY CONNECTION THAT SIGNED IN SINCE THE LAST POLL IS RE-CHECKED, WHATEVER
// THE LOG SAYS. Its row was read at sign-in (admit), before it was registered
// here. A revocation that committed between that read and the registration can
// already have been read by a poll that ran in between, when the connection was
// not here to be matched, and no later poll returns it again. So: a connection
// registered after poll P(n-1) took its registry snapshot is re-checked by the
// first poll P(n) that sees it, with a read of the row taken after P(n)'s log
// read. A change committed before that row read is in the row; one committed
// after it was not visible to P(n)'s log read either (which came first), so a
// later poll returns it while the connection is registered. Either way it is
// seen. TestAPollRechecksAConnectionThatSignedInDuringAChange pins it.
//
// ⚠ THE POSITION MOVES ONLY AFTER THE RE-CHECK HAS READ THE ROWS, or after a full
// sweep is asked for. A failed read of the log or of the accounts leaves it, and
// the next poll reads the same changes again. Re-checks are idempotent.
//
// ⚠ WITH NOTHING LIVE THE POSITION IS DROPPED, NOT KEPT. The next connection to
// sign in is new, and new connections are re-checked whatever the log says, so
// no change before it matters; reading the log from an old position would only
// read changes nobody can be closed for.
func (s *Sweeper) Poll(ctx context.Context) SweepStats {
	start := time.Now()
	all, upTo := s.reg.snapshot()
	st := SweepStats{Live: len(all)}
	conns := expire(all, &st)
	if len(conns) == 0 {
		s.since, s.sinceStart, s.seen = "", time.Time{}, upTo
		st.Total = time.Since(start)
		return st
	}

	qctx, cancel := context.WithTimeout(ctx, s.Timeout)
	defer cancel()
	since := s.since
	if since != "" && start.Sub(s.sinceAt) > maxPositionAge {
		since, st.Full, st.FullWhy = "", true, "position too old"
	}
	readAt := time.Now()
	batch, err := s.Accounts.AccessChanges(qctx, since, s.maxChanges())
	st.Log = batch.QueryTime
	if err != nil {
		st.Err = err
		st.Total = time.Since(start)
		return st
	}
	st.Changes = len(batch.Changes)

	accounts, domains, connections := map[string]bool{}, map[string]bool{}, map[string]bool{}
	switch {
	case batch.Rewound:
		st.Full, st.FullWhy = true, "transaction ids went back (a restore, or a failover to a lagging replica)"
	case since != "" && !batch.ServerStart.Equal(s.sinceStart):
		st.Full, st.FullWhy = true, "database server start time changed (a restart, restore, or failover)"
	case batch.Truncated:
		st.Full, st.FullWhy = true, "more changes than one poll reads"
	}
	if !st.Full {
		for _, c := range batch.Changes {
			switch c.Kind {
			case projection.ChangeAccount:
				accounts[c.Key] = true
			case projection.ChangeDomain:
				domains[c.Key] = true
			case projection.ChangeConnection:
				connections[c.Key] = true
			default:
				// `all`, or a kind this front does not know: it cannot tell whom it
				// names, so it names everyone.
				st.Full, st.FullWhy = true, "a change for every account ("+string(c.Kind)+")"
			}
		}
	}
	if st.Full {
		s.Log.Warn("poll asked for a full sweep", "why", st.FullWhy, "changes", st.Changes, "live", len(conns))
		s.requestSweep()
		s.since, s.sinceStart, s.sinceAt, s.seen = batch.Snapshot, batch.ServerStart, readAt, upTo
		st.Total = time.Since(start)
		return st
	}
	var targets []*live
	for _, c := range conns {
		g := c.grant
		if c.seq > s.seen || accounts[g.AccountID] || domains[g.Domain] ||
			(g.Route.Connection != "" && connections[g.Route.Connection]) {
			targets = append(targets, c)
		}
	}
	if len(targets) > 0 {
		if err := s.recheck(qctx, targets, &st); err != nil {
			st.Err = err
			st.Total = time.Since(start)
			return st
		}
	}
	s.since, s.sinceStart, s.sinceAt, s.seen = batch.Snapshot, batch.ServerStart, readAt, upTo
	st.Total = time.Since(start)
	return st
}

// expire closes every pass-through session past its maximum age and returns
// the rest. It reads no row, so it holds while the projection cannot be read.
func expire(all []*live, st *SweepStats) []*live {
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
	return conns
}

// recheck reads the rows of conns' accounts in one query and closes every
// connection Grant.revoked turns away.
func (s *Sweeper) recheck(ctx context.Context, conns []*live, st *SweepStats) error {
	seen := make(map[string]struct{}, len(conns))
	ids := make([]string, 0, len(conns))
	for _, c := range conns {
		if _, ok := seen[c.grant.AccountID]; !ok {
			seen[c.grant.AccountID] = struct{}{}
			ids = append(ids, c.grant.AccountID)
		}
	}
	st.Accounts = len(ids)
	rows, took, err := s.Accounts.AccountsByUIDs(ctx, ids)
	st.Query = took
	if err != nil {
		return err
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
	return nil
}

// failureLog reports one loop's passes: loud on failure, but not once a second
// for an hour.
type failureLog struct {
	// failing is the start of the current streak of failed passes.
	failing    time.Time
	lastLogged time.Time
}

func (f *failureLog) report(log *slog.Logger, what string, st SweepStats) {
	now := time.Now()
	if st.Err != nil {
		if f.failing.IsZero() {
			f.failing = now
		}
		// The first failure, then once a minute while it lasts.
		if f.lastLogged.IsZero() || now.Sub(f.lastLogged) >= time.Minute {
			log.Error(what+" failed: NOT closing any connection until the projection answers",
				"live", st.Live, "failingFor", now.Sub(f.failing).Round(time.Second).String(), slog.Any("err", st.Err))
			f.lastLogged = now
		}
		return
	}
	if !f.failing.IsZero() {
		log.Warn(what+" recovered", "failedFor", now.Sub(f.failing).Round(time.Second).String())
		f.failing, f.lastLogged = time.Time{}, time.Time{}
	}
	if st.Live > 0 {
		log.Debug(what, "live", st.Live, "changes", st.Changes, "full", st.Full, "accounts", st.Accounts,
			"closed", st.Closed, "log", st.Log.String(), "query", st.Query.String(), "total", st.Total.String())
	}
}
