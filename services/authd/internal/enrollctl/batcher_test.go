package enrollctl

import (
	"bytes"
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/gate"
	"github.com/i10-tech/i10/services/authd/internal/projection"
	"github.com/jackc/pgx/v5/pgconn"
)

func testLane(exec func(context.Context, []job[int, MintResult]) ([]MintResult, error)) *lane[int, MintResult] {
	return &lane[int, MintResult]{
		kind:     "test",
		exec:     exec,
		failed:   func(err error) MintResult { return MintResult{Err: err} },
		refused:  func(code string) MintResult { return MintResult{RefusalCode: code} },
		maxBatch: 10,
		maxWait:  time.Millisecond,
		deadline: time.Second,
	}
}

func testJobs(n int) []job[int, MintResult] {
	jobs := make([]job[int, MintResult], n)
	for i := range jobs {
		jobs[i] = newJob[int, MintResult](context.Background(), i)
	}
	return jobs
}

// answers reads exactly one answer per waiter and fails if any waiter has none.
func answers(t *testing.T, jobs []job[int, MintResult]) []MintResult {
	t.Helper()
	out := make([]MintResult, len(jobs))
	for i, j := range jobs {
		select {
		case out[i] = <-j.resp:
		default:
			t.Fatalf("waiter %d got no answer", i)
		}
		select {
		case extra := <-j.resp:
			t.Fatalf("waiter %d got a second answer %+v", i, extra)
		default:
		}
	}
	return out
}

func TestRecoveryAnswersEveryWaiterWhenAConstraintMeetsAnExpiredDeadline(t *testing.T) {
	uniqueViolation := &pgconn.PgError{Code: "23505", ConstraintName: "mail_devices_cert_key_sha256_unique"}
	l := testLane(func(context.Context, []job[int, MintResult]) ([]MintResult, error) {
		return nil, uniqueViolation
	})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	got := l.runWithRecovery(ctx, testJobs(5), false)
	if len(got) != 5 {
		t.Fatalf("got %d results for 5 jobs", len(got))
	}
	for i, r := range got {
		if !errors.Is(r.Err, ErrUnavailable) || r.RefusalCode != "" {
			t.Fatalf("result %d = %+v, want ErrUnavailable (only a lone row may be refused)", i, r)
		}
	}

	// A single job is the one row the constraint names: it alone is refused.
	if got := l.runWithRecovery(ctx, testJobs(1), false); len(got) != 1 || got[0].RefusalCode != "key_in_use" {
		t.Fatalf("lone row = %+v, want key_in_use", got)
	}
}

func TestDispatchAnswersEveryWaiterOnAWrongLengthResultOrAPanic(t *testing.T) {
	short := testLane(func(_ context.Context, jobs []job[int, MintResult]) ([]MintResult, error) {
		return make([]MintResult, len(jobs)-1), nil
	})
	jobs := testJobs(3)
	short.dispatch(jobs)
	for i, r := range answers(t, jobs) {
		if !errors.Is(r.Err, ErrUnavailable) {
			t.Fatalf("wrong-length batch: waiter %d = %+v, want ErrUnavailable", i, r)
		}
	}

	panicky := testLane(func(context.Context, []job[int, MintResult]) ([]MintResult, error) {
		panic("boom")
	})
	jobs = testJobs(4)
	panicky.dispatch(jobs)
	for i, r := range answers(t, jobs) {
		if !errors.Is(r.Err, ErrUnavailable) {
			t.Fatalf("panicking batch: waiter %d = %+v, want ErrUnavailable", i, r)
		}
	}
}

// TestHoldAndRouteRefusalsComeFromTheGate pins that enrollctl refuses with
// exactly gate.Refusal's code, after its own mint- and bind-specific checks.
func TestHoldAndRouteRefusalsComeFromTheGate(t *testing.T) {
	tenant := "11111111-1111-1111-1111-111111111111"
	base := projection.Account{ClerkUserID: "user_a", Email: "a@x.test", Active: true, TenantID: tenant, CredentialEpoch: 3}
	with := func(f func(*projection.Account)) *projection.Account { a := base; f(&a); return &a }
	rows := []*projection.Account{
		&base,
		with(func(a *projection.Account) { a.Suspended = true }),
		with(func(a *projection.Account) { a.Suspended, a.Deleting = true, true }),
		with(func(a *projection.Account) { a.Deleting = true }),
		with(func(a *projection.Account) { a.PaymentHold = true }),
		with(func(a *projection.Account) { a.DomainNotHosted = true }),
		with(func(a *projection.Account) { a.Banned = true }),
		with(func(a *projection.Account) { a.Locked = true }),
		with(func(a *projection.Account) { a.SSORequired = true }),
		with(func(a *projection.Account) { a.SSORequired, a.SSOExempt = true, true }),
		with(func(a *projection.Account) { a.Managed = true }),
		with(func(a *projection.Account) { a.Managed, a.ManagedConnection = true, "c" }),
		with(func(a *projection.Account) { a.Managed, a.ManagedConnection, a.ConnectionInactive = true, "c", true }),
	}
	req := MintRequest{ClerkUserID: "user_a", Email: "A@x.test", TenantID: &tenant, ExpectedEpoch: 3}
	for _, a := range rows {
		want := gate.Refusal(a)
		if got := mintRefusal(a, req); got != want {
			t.Errorf("mintRefusal(%+v) = %q, gate says %q", a, got, want)
		}
		if got := bindRefusal(a, tenant); got != want {
			t.Errorf("bindRefusal(%+v) = %q, gate says %q", a, got, want)
		}
	}

	suspended := with(func(a *projection.Account) { a.Suspended = true })
	other := "22222222-2222-2222-2222-222222222222"
	for _, tc := range []struct {
		name string
		acct *projection.Account
		req  MintRequest
		want string
	}{
		{"no account", nil, req, "account_not_found"},
		{"another workspace, before the hold", suspended, MintRequest{ClerkUserID: "user_a", TenantID: &other, ExpectedEpoch: 3}, "tenant_mismatch"},
		{"null workspace against a tenant", &base, MintRequest{ClerkUserID: "user_a", ExpectedEpoch: 3}, "tenant_mismatch"},
		{"inactive", with(func(a *projection.Account) { a.Active, a.Suspended = false, true }), req, "account_inactive"},
		{"epoch moved", suspended, MintRequest{ClerkUserID: "user_a", TenantID: &tenant, ExpectedEpoch: 4}, "epoch_mismatch"},
		{"address changed", suspended, MintRequest{ClerkUserID: "user_a", Email: "b@x.test", TenantID: &tenant, ExpectedEpoch: 3}, "email_mismatch"},
	} {
		if got := mintRefusal(tc.acct, tc.req); got != tc.want {
			t.Errorf("%s: mintRefusal = %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestPlanBindsRunsEachJobsOwnChecksBeforeTheConflictRule(t *testing.T) {
	tenant := "11111111-1111-1111-1111-111111111111"
	acct := &projection.Account{ClerkUserID: "user_a", Email: "a@x.test", Active: true, TenantID: tenant}
	accounts := map[string]*projection.Account{"user_a": acct}
	serial := "C02MAC"
	k1, k2, k3 := bytes.Repeat([]byte{1}, 32), bytes.Repeat([]byte{2}, 32), bytes.Repeat([]byte{3}, 32)
	mac := func(key []byte, boundAt *time.Time) *lockedDevice {
		s := serial
		return &lockedDevice{ID: "dev", ClerkUserID: "user_a", Email: "a@x.test", TenantID: tenant, Platform: "macos", Serial: &s, CertKeySha256: key, ACMEBoundAt: boundAt, Alive: true}
	}
	jobsOf := func(reqs ...BindMacRequest) []bindJob {
		out := make([]bindJob, len(reqs))
		for i, r := range reqs {
			out[i] = bindJob{req: r}
		}
		return out
	}
	codes := func(p bindPlan) []string {
		out := make([]string, len(p.results))
		for i, r := range p.results {
			if r.OK {
				out[i] = "ok"
			} else {
				out[i] = r.RefusalCode
			}
		}
		return out
	}
	equal := func(a, b []string) bool {
		if len(a) != len(b) {
			return false
		}
		for i := range a {
			if a[i] != b[i] {
				return false
			}
		}
		return true
	}

	t.Run("a refused sibling with another key does not wipe a valid first bind", func(t *testing.T) {
		devices := map[string]*lockedDevice{"dev": mac(nil, nil)}
		p := planBinds(jobsOf(
			BindMacRequest{DeviceID: "dev", Serial: serial, KeySha256: k1},
			BindMacRequest{DeviceID: "dev", Serial: "OTHER", KeySha256: k2},
		), devices, accounts)
		if got := codes(p); !equal(got, []string{"ok", "serial_mismatch"}) {
			t.Fatalf("results = %v", got)
		}
		if len(p.cleared) != 0 || len(p.setIDs) != 1 || !bytes.Equal(p.setKeys[0], k1) {
			t.Fatalf("plan = %+v, want only k1 set and nothing cleared", p)
		}
	})

	t.Run("a gate-refused sibling does not count toward a conflict", func(t *testing.T) {
		boundAt := time.Now()
		devices := map[string]*lockedDevice{"dev": mac(k1, &boundAt), "theirs": {ID: "theirs", ClerkUserID: "user_b"}}
		p := planBinds(jobsOf(
			BindMacRequest{DeviceID: "dev", Serial: serial, KeySha256: k1},
			BindMacRequest{DeviceID: "missing", Serial: serial, KeySha256: k2},
			BindMacRequest{DeviceID: "theirs", Serial: serial, KeySha256: k3},
		), devices, accounts)
		if got := codes(p); !equal(got, []string{"ok", "device_not_found", "account_not_found"}) {
			t.Fatalf("results = %v", got)
		}
		if len(p.cleared) != 0 {
			t.Fatalf("cleared %v, want nothing", p.cleared)
		}
	})

	t.Run("two conflicting requests leave an operator pre-bound key alone", func(t *testing.T) {
		devices := map[string]*lockedDevice{"dev": mac(k3, nil)}
		p := planBinds(jobsOf(
			BindMacRequest{DeviceID: "dev", Serial: serial, KeySha256: k1},
			BindMacRequest{DeviceID: "dev", Serial: serial, KeySha256: k2},
		), devices, accounts)
		if got := codes(p); !equal(got, []string{"device_key_bound", "device_key_bound"}) {
			t.Fatalf("results = %v", got)
		}
		if len(p.cleared) != 0 || len(p.setIDs) != 0 {
			t.Fatalf("plan = %+v, want no write", p)
		}
	})

	t.Run("two valid requests with different keys trip #536", func(t *testing.T) {
		devices := map[string]*lockedDevice{"dev": mac(nil, nil)}
		p := planBinds(jobsOf(
			BindMacRequest{DeviceID: "dev", Serial: serial, KeySha256: k1},
			BindMacRequest{DeviceID: "dev", Serial: serial, KeySha256: k2},
		), devices, accounts)
		if got := codes(p); !equal(got, []string{"acme_key_conflict", "acme_key_conflict"}) {
			t.Fatalf("results = %v", got)
		}
		if len(p.cleared) != 1 || len(p.setIDs) != 0 {
			t.Fatalf("plan = %+v, want the device cleared once", p)
		}
	})
}

// runningLane starts a lane whose transaction is exec, stopped at test end.
func runningLane(t *testing.T, exec func(context.Context, []job[int, MintResult]) ([]MintResult, error)) *lane[int, MintResult] {
	t.Helper()
	l := testLane(exec)
	l.ch = make(chan job[int, MintResult], 8)
	stop := make(chan struct{})
	l.stopCh = stop
	done := make(chan struct{})
	go func() { defer close(done); l.run() }()
	t.Cleanup(func() { close(stop); <-done })
	return l
}

// TestACallerThatLeavesWhileQueuedIsNeverMinted: job 2 waits behind a running
// batch; its caller leaves. It is answered unavailable at once, and no
// transaction ever runs it. A queued job whose context is already done when
// its batch starts is dropped the same way.
func TestACallerThatLeavesWhileQueuedIsNeverMinted(t *testing.T) {
	release := make(chan struct{})
	var mu sync.Mutex
	var ran []int
	l := runningLane(t, func(_ context.Context, jobs []job[int, MintResult]) ([]MintResult, error) {
		mu.Lock()
		for _, j := range jobs {
			ran = append(ran, j.req)
		}
		mu.Unlock()
		if jobs[0].req == 1 {
			<-release
		}
		return make([]MintResult, len(jobs)), nil
	})
	first := make(chan MintResult, 1)
	go func() { first <- l.submit(context.Background(), 1) }()
	for {
		mu.Lock()
		n := len(ran)
		mu.Unlock()
		if n == 1 {
			break
		}
		time.Sleep(time.Millisecond)
	}

	ctx, cancel := context.WithCancel(context.Background())
	second := make(chan MintResult, 1)
	go func() { second <- l.submit(ctx, 2) }()
	time.Sleep(10 * time.Millisecond) // job 2 is queued behind job 1
	cancel()
	select {
	case r := <-second:
		if !errors.Is(r.Err, ErrUnavailable) {
			t.Fatalf("a caller that left while queued = %+v, want ErrUnavailable", r)
		}
	case <-time.After(time.Second):
		t.Fatal("a caller that left while queued was not answered")
	}
	close(release)
	<-first
	time.Sleep(20 * time.Millisecond) // let the lane reach the abandoned job
	ranJobs := func() []int {
		mu.Lock()
		defer mu.Unlock()
		return append([]int{}, ran...)
	}
	if got := ranJobs(); len(got) != 1 {
		t.Fatalf("transactions ran jobs %v, want only job 1", got)
	}

	// dispatch itself drops a job whose caller's context is already done.
	gone, cancelGone := context.WithCancel(context.Background())
	cancelGone()
	jobs := []job[int, MintResult]{newJob[int, MintResult](gone, 7), newJob[int, MintResult](context.Background(), 8)}
	l.dispatch(jobs)
	if got := ranJobs(); len(got) != 2 || got[1] != 8 {
		t.Fatalf("transactions ran %v, want job 1 and then only the live job 8", got)
	}
	if r := <-jobs[0].resp; !errors.Is(r.Err, ErrUnavailable) {
		t.Fatalf("the dropped job = %+v, want ErrUnavailable", r)
	}
}

// TestACallerThatLeavesDuringTheTransactionGetsTheCommit: once its job is in
// a transaction, submit returns that transaction's answer whatever the
// caller's context does.
func TestACallerThatLeavesDuringTheTransactionGetsTheCommit(t *testing.T) {
	inTx := make(chan struct{})
	release := make(chan struct{})
	l := runningLane(t, func(_ context.Context, jobs []job[int, MintResult]) ([]MintResult, error) {
		close(inTx)
		<-release
		return []MintResult{{OK: true}}, nil
	})
	ctx, cancel := context.WithCancel(context.Background())
	got := make(chan MintResult, 1)
	go func() { got <- l.submit(ctx, 1) }()
	<-inTx
	cancel()
	time.Sleep(10 * time.Millisecond)
	close(release)
	select {
	case r := <-got:
		if !r.OK || r.Err != nil {
			t.Fatalf("a caller that left mid-transaction = %+v, want the commit", r)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("submit did not return the transaction's answer")
	}
}
