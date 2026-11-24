package mailfront

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/projection"
)

// pollRig is a Sweeper over a fake projection, with connections registered
// directly: what the poll decides needs no socket.
type pollRig struct {
	t        *testing.T
	accounts *fakeAccounts
	srv      *Server
	sw       *Sweeper

	mu     sync.Mutex
	closed map[string]string // account id -> reason
}

func newPollRig(t *testing.T, accts ...projection.Account) *pollRig {
	t.Helper()
	f := newFakeAccounts(accts...)
	srv := NewServer(f, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	return &pollRig{t: t, accounts: f, srv: srv, sw: srv.Sweeper(time.Second, time.Second), closed: map[string]string{}}
}

// signIn reads the account's row as a sign-in does and returns the grant,
// without registering it yet.
func (r *pollRig) signIn(email string) Grant {
	r.t.Helper()
	acct, err := r.accounts.AccountByLogin(context.Background(), email)
	g, reason := admit(acct, err, time.Now().Add(time.Hour))
	if reason != "" {
		r.t.Fatalf("sign-in refused: %s", reason)
	}
	return g
}

func (r *pollRig) register(g Grant) {
	r.srv.reg.add(g, func(reason string) {
		r.mu.Lock()
		r.closed[g.AccountID] = reason
		r.mu.Unlock()
	})
}

func (r *pollRig) isClosed(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	_, ok := r.closed[id]
	return ok
}

func (r *pollRig) poll() SweepStats {
	r.t.Helper()
	st := r.sw.Poll(context.Background())
	if st.Err != nil {
		r.t.Fatalf("poll: %v", st.Err)
	}
	return st
}

// ⚠ THE REGISTRATION RACE (Sweeper.Poll). Alice's row is read at sign-in, then
// she is suspended, then a poll reads that change while her connection is not
// registered yet, so it matches nobody. Nothing in the log names her again. The
// poll after she registers must re-check her anyway, because she is new.
func TestAPollRechecksAConnectionThatSignedInDuringAChange(t *testing.T) {
	r := newPollRig(t, account("user_alice", "alice@i10.test"), account("user_bob", "bob@i10.test"))
	r.register(r.signIn("bob@i10.test"))
	r.poll() // Bob is new: the position is set.

	grant := r.signIn("alice@i10.test")
	r.accounts.update("alice@i10.test", func(a *projection.Account) { a.Suspended = true })
	if st := r.poll(); st.Changes != 1 || st.Closed != 0 {
		t.Fatalf("poll %+v, want the change read and nobody closed", st)
	}
	r.register(grant)
	st := r.poll()
	if st.Changes != 0 || st.Closed != 1 || st.Full {
		t.Fatalf("poll %+v, want no change read and the new connection closed", st)
	}
	if !r.isClosed("user_alice") {
		t.Fatal("alice's connection outlived her suspension")
	}
	// Once re-checked she is not new any more: a quiet poll reads no account.
	r.register(r.signIn("bob@i10.test"))
	r.poll()
	before := r.accounts.sweeps
	if st := r.poll(); st.Accounts != 0 || r.accounts.sweeps != before {
		t.Fatalf("a poll with nothing new and nothing changed read %d accounts", st.Accounts)
	}
}

func TestAPollRechecksOnlyTheAccountsThatChanged(t *testing.T) {
	r := newPollRig(t, account("user_alice", "alice@i10.test"), account("user_bob", "bob@i10.test"),
		account("user_carol", "carol@other.test"))
	for _, e := range []string{"alice@i10.test", "bob@i10.test", "carol@other.test"} {
		r.register(r.signIn(e))
	}
	if st := r.poll(); st.Accounts != 3 {
		t.Fatalf("the first poll read %d accounts, want the three new ones", st.Accounts)
	}
	r.accounts.update("bob@i10.test", func(a *projection.Account) { a.Banned = true })
	st := r.poll()
	if st.Accounts != 1 || st.Closed != 1 || st.Full || !r.isClosed("user_bob") {
		t.Fatalf("poll %+v, want only bob read and closed", st)
	}
}

// A change logged for a domain or a connection reaches the connections on it,
// and nobody else.
func TestAPollFindsConnectionsByDomainAndByConnection(t *testing.T) {
	managed := account("user_carol", "carol@acme.test")
	managed.Managed, managed.ManagedConnection = true, "conn-1"
	r := newPollRig(t, account("user_alice", "alice@i10.test"), account("user_bob", "bob@i10.test"), managed,
		account("user_dan", "dan@acme.test"))
	for _, e := range []string{"alice@i10.test", "bob@i10.test", "carol@acme.test", "dan@acme.test"} {
		r.register(r.signIn(e))
	}
	r.poll()

	// The domain's hosting went off: the row says so, and the log says only the domain moved.
	for _, e := range []string{"alice@i10.test", "bob@i10.test"} {
		r.accounts.silently(e, func(a *projection.Account) { a.DomainNotHosted = true })
	}
	r.accounts.logChange(projection.ChangeDomain, "i10.test")
	if st := r.poll(); st.Accounts != 2 || st.Closed != 2 || !r.isClosed("user_alice") || !r.isClosed("user_bob") {
		t.Fatalf("poll %+v, want both i10.test connections read and closed", st)
	}

	r.accounts.silently("carol@acme.test", func(a *projection.Account) { a.CredentialEpoch++ })
	r.accounts.logChange(projection.ChangeConnection, "conn-1")
	if st := r.poll(); st.Accounts != 1 || st.Closed != 1 || !r.isClosed("user_carol") || r.isClosed("user_dan") {
		t.Fatalf("poll %+v, want only the connection's managed account read and closed", st)
	}
}

// A write the log never saw is the backstop's: the poll cannot know, the sweep
// re-reads everybody.
func TestAWriteTheLogMissedIsClosedByTheBackstop(t *testing.T) {
	r := newPollRig(t, account("user_alice", "alice@i10.test"))
	r.register(r.signIn("alice@i10.test"))
	r.poll()
	r.accounts.silently("alice@i10.test", func(a *projection.Account) { a.Suspended = true })
	if st := r.poll(); st.Closed != 0 {
		t.Fatalf("the poll closed %d without a logged change", st.Closed)
	}
	if st := r.sw.Sweep(context.Background()); st.Closed != 1 || !r.isClosed("user_alice") {
		t.Fatalf("sweep %+v, want the missed revocation closed", st)
	}
}

// When the poll cannot tell whom a change names, or did not read all of them,
// it re-checks nobody itself: it asks for a full sweep, moves on, and the sweep
// closes the revoked connection.
func TestAPollAsksForAFullSweepWhenItCannotTellWhom(t *testing.T) {
	cases := []struct {
		name string
		log  func(*pollRig)
	}{
		{"a truncated table", func(r *pollRig) { r.accounts.logChange(projection.ChangeAll, "") }},
		{"a kind it does not know", func(r *pollRig) { r.accounts.logChange("tenant", "t1") }},
		{"more changes than one poll reads", func(r *pollRig) {
			for range 4 {
				r.accounts.logChange(projection.ChangeAccount, "user_nobody")
			}
		}},
		{"a position older than it may be", func(r *pollRig) { r.sw.sinceAt = time.Now().Add(-maxPositionAge - time.Second) }},
		{"transaction ids that went back", func(r *pollRig) {
			r.accounts.mu.Lock()
			r.accounts.changes = nil
			r.accounts.mu.Unlock()
		}},
		{"database server start time changed after failover past old xmax", func(r *pollRig) {
			r.accounts.mu.Lock()
			// Simulate a promoted lagging replica whose new commits have already
			// moved its position past the old xmax, so Rewound is false, but its
			// pg_postmaster_start_time() differs from the previous poll's.
			r.accounts.serverStart = r.accounts.serverStart.Add(time.Minute)
			r.accounts.changes = append(r.accounts.changes, projection.Change{Kind: projection.ChangeAccount, Key: "user_nobody"})
			r.accounts.mu.Unlock()
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := newPollRig(t, account("user_alice", "alice@i10.test"), account("user_bob", "bob@i10.test"))
			r.sw.MaxChanges = 3
			r.register(r.signIn("alice@i10.test"))
			r.register(r.signIn("bob@i10.test"))
			r.poll()
			r.accounts.logChange(projection.ChangeAccount, "user_nobody") // so the log has a position to go back from
			r.poll()
			r.accounts.silently("alice@i10.test", func(a *projection.Account) { a.Suspended = true })
			tc.log(r)
			before := r.accounts.sweeps
			st := r.poll()
			if !st.Full || st.Accounts != 0 || r.accounts.sweeps != before || len(r.sw.fullSweep) != 1 {
				t.Fatalf("poll %+v (%d requests), want a full sweep asked for and no account read by the poll",
					st, len(r.sw.fullSweep))
			}
			if st := r.poll(); st.Full || st.Accounts != 0 {
				t.Fatalf("the poll after it %+v, want it back to reading changes from its new position", st)
			}
			if st := r.sw.Sweep(context.Background()); st.Closed != 1 || !r.isClosed("user_alice") {
				t.Fatalf("sweep %+v, want alice closed", st)
			}
		})
	}
}

// Exactly MaxChanges changes is a complete read, not a truncated one.
func TestAPollOfExactlyMaxChangesIsNotFull(t *testing.T) {
	r := newPollRig(t, account("user_alice", "alice@i10.test"))
	r.sw.MaxChanges = 3
	r.register(r.signIn("alice@i10.test"))
	r.poll()
	r.accounts.update("alice@i10.test", func(a *projection.Account) { a.Banned = true })
	r.accounts.logChange(projection.ChangeAccount, "user_nobody")
	r.accounts.logChange(projection.ChangeAccount, "user_nobody_2")
	if st := r.poll(); st.Full || st.Changes != 3 || st.Closed != 1 {
		t.Fatalf("poll %+v, want the three changes read and alice closed by the poll", st)
	}
}

// ⚠ THE SWEEP THAT ANSWERS A FULL POLL STARTS AFTER IT (Sweeper.Poll). A sweep
// already running when the poll asks may have read its rows before the poll's
// log read, so it does not count: another one runs after it. Here the running
// sweep is held inside its row read while the poll asks.
func TestAFullPollIsAnsweredByASweepThatStartsAfterIt(t *testing.T) {
	r := newPollRig(t, account("user_alice", "alice@i10.test"))
	r.sw.Interval, r.sw.MaxChanges = 10*time.Millisecond, 1
	r.register(r.signIn("alice@i10.test"))
	r.poll()

	var passes []time.Time
	release := make(chan struct{})
	entered := make(chan struct{}, 4)
	pass := func(ctx context.Context) SweepStats {
		passes = append(passes, time.Now())
		entered <- struct{}{}
		if len(passes) == 1 {
			<-release // the first pass is mid-read when the poll asks
		}
		return r.sw.Sweep(ctx)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		defer close(done)
		r.sw.loop(ctx, "sweep", time.Hour, pass, &r.sw.sweepReport, r.sw.fullSweep)
	}()

	r.sw.requestSweep() // something earlier asked for one: it starts and blocks
	<-entered
	r.accounts.silently("alice@i10.test", func(a *projection.Account) { a.Suspended = true })
	r.accounts.logChange(projection.ChangeAll, "")
	asked := time.Now()
	if st := r.poll(); !st.Full {
		t.Fatalf("poll %+v, want it to ask for a full sweep", st)
	}
	close(release)
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("no sweep ran after the full poll asked for one")
	}
	waitFor(t, "alice closed by the sweep the poll asked for", func() bool { return r.isClosed("user_alice") })
	cancel()
	<-done
	if len(passes) != 2 || !passes[1].After(asked) {
		t.Fatalf("passes at %v, the poll asked at %v: want a second pass after the request", passes, asked)
	}
}

// ⚠ A FULL POLL KEEPS THE POLL'S SECOND. With a backstop an hour away, a burst
// that makes one poll Full is answered by a sweep at once, and the poll right
// after still closes a targeted revocation within its interval.
func TestRunAnswersAFullPollAtOnceAndKeepsPolling(t *testing.T) {
	r := newPollRig(t, account("user_alice", "alice@i10.test"), account("user_bob", "bob@i10.test"))
	r.sw.Interval, r.sw.Backstop, r.sw.MaxChanges = 20*time.Millisecond, time.Hour, 2
	r.register(r.signIn("alice@i10.test"))
	r.register(r.signIn("bob@i10.test"))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go r.sw.Run(ctx)
	time.Sleep(100 * time.Millisecond)

	r.accounts.silently("alice@i10.test", func(a *projection.Account) { a.Suspended = true })
	for range 3 {
		r.accounts.logChange(projection.ChangeAccount, "user_nobody")
	}
	waitFor(t, "alice closed by the sweep the burst asked for", func() bool { return r.isClosed("user_alice") })
	r.accounts.update("bob@i10.test", func(a *projection.Account) { a.Banned = true })
	waitFor(t, "bob closed by the next poll", func() bool { return r.isClosed("user_bob") })
}

// A requested sweep that fails asks again, at the poll's pace, rather than
// leaving the coverage the poll gave away to the next backstop.
func TestAFailedRequestedSweepIsRetried(t *testing.T) {
	r := newPollRig(t, account("user_alice", "alice@i10.test"))
	r.sw.Interval = 10 * time.Millisecond
	r.register(r.signIn("alice@i10.test"))
	r.poll()
	var calls int
	pass := func(ctx context.Context) SweepStats {
		calls++
		if calls == 1 {
			return SweepStats{Err: errors.New("projection unreachable")}
		}
		return r.sw.Sweep(ctx)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go r.sw.loop(ctx, "sweep", time.Hour, pass, &r.sw.sweepReport, r.sw.fullSweep)
	r.accounts.silently("alice@i10.test", func(a *projection.Account) { a.Locked = true })
	r.sw.requestSweep()
	waitFor(t, "alice closed by the retried sweep", func() bool { return r.isClosed("user_alice") })
}

// ⚠ THE POSITION MOVES ONLY AFTER THE RE-CHECK. A revocation read while the
// accounts could not be is read again by the next poll that can.
func TestAFailedPollReadsTheSameChangesAgain(t *testing.T) {
	r := newPollRig(t, account("user_alice", "alice@i10.test"))
	r.register(r.signIn("alice@i10.test"))
	r.poll()
	r.accounts.update("alice@i10.test", func(a *projection.Account) { a.PaymentHold = true })
	r.accounts.mu.Lock()
	r.accounts.failAll = true
	r.accounts.mu.Unlock()
	if st := r.sw.Poll(context.Background()); st.Err == nil || st.Closed != 0 {
		t.Fatalf("poll %+v, want an error and nothing closed", st)
	}
	r.accounts.mu.Lock()
	r.accounts.failAll = false
	r.accounts.mu.Unlock()
	if st := r.poll(); st.Changes != 1 || st.Closed != 1 {
		t.Fatalf("poll %+v, want the change read again and alice closed", st)
	}
}

// With nothing live a poll asks nothing, and the next connection is re-checked
// as new, whatever the log held meanwhile.
func TestAPollWithNothingLiveAsksNothing(t *testing.T) {
	r := newPollRig(t, account("user_alice", "alice@i10.test"))
	r.poll()
	r.accounts.update("alice@i10.test", func(a *projection.Account) { a.Locked = true })
	r.poll()
	if r.accounts.polls != 0 || r.accounts.sweeps != 0 {
		t.Fatalf("%d log reads and %d account reads with nothing live", r.accounts.polls, r.accounts.sweeps)
	}
	acct := account("user_alice", "alice@i10.test")
	g, _ := admit(&acct, nil, time.Time{}) // as signed in before the lock
	r.register(g)
	if st := r.poll(); st.Closed != 1 {
		t.Fatalf("poll %+v, want the new connection re-checked and closed", st)
	}
}

// ⚠ RUN'S POLL IS NOT HELD BACK BY ITS BACKSTOP. With a backstop far away, a
// revocation still closes within the poll interval.
func TestRunClosesWithinThePollInterval(t *testing.T) {
	r := newPollRig(t, account("user_alice", "alice@i10.test"))
	r.sw.Interval, r.sw.Backstop = 20*time.Millisecond, time.Hour
	r.register(r.signIn("alice@i10.test"))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go r.sw.Run(ctx)
	time.Sleep(100 * time.Millisecond)
	r.accounts.update("alice@i10.test", func(a *projection.Account) { a.Deleting = true })
	waitFor(t, "alice closed by the poll", func() bool { return r.isClosed("user_alice") })
}
