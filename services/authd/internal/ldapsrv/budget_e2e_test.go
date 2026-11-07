package ldapsrv_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	goldapclient "github.com/go-ldap/ldap/v3"

	"github.com/i10-tech/i10/services/authd/internal/credcache"
	"github.com/i10-tech/i10/services/authd/internal/ldapsrv"
	"github.com/i10-tech/i10/services/authd/internal/verify"
)

// These exercise the failure budget through the bind handler, with a fake
// verifier that carries a budget. Clerk has none, so in production none of this
// runs yet; it is built for the first provider that can lock a real account.
//
// The fake store reproduces the SQL's semantics in memory (internal/budgetstore
// has the real statement and its own concurrency test). What is under test here
// is the HANDLER: where it reserves, what it releases and what it keeps.

const aliceUID = "user_alice"

// fakeBudgetStore is verify.BudgetStore over a map, with a clock the test drives.
type fakeBudgetStore struct {
	mu       sync.Mutex
	now      time.Time
	rows     map[string]*fakeBudgetRow
	err      error
	reserves int
	releases int
}

type fakeBudgetRow struct {
	window time.Time
	count  int
}

func newFakeBudgetStore() *fakeBudgetStore {
	return &fakeBudgetStore{
		now:  time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC),
		rows: map[string]*fakeBudgetRow{},
	}
}

func (f *fakeBudgetStore) Reserve(_ context.Context, userID string, b verify.Budget) (verify.Slot, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reserves++
	if f.err != nil {
		return verify.Slot{}, false, f.err
	}
	row, ok := f.rows[userID]
	switch {
	case !ok:
		row = &fakeBudgetRow{window: f.now, count: 1}
		f.rows[userID] = row
	case !f.now.Before(row.window.Add(b.Window)):
		row.window, row.count = f.now, 1
	case row.count < b.Max:
		row.count++
	default:
		return verify.Slot{}, false, nil
	}
	return verify.Slot{Window: row.window}, true, nil
}

func (f *fakeBudgetStore) Release(_ context.Context, userID string, s verify.Slot) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.releases++
	if row, ok := f.rows[userID]; ok && row.window.Equal(s.Window) && row.count > 0 {
		row.count--
	}
	return nil
}

func (f *fakeBudgetStore) count(userID string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	if row, ok := f.rows[userID]; ok {
		return row.count
	}
	return 0
}

func (f *fakeBudgetStore) counts() (reserves, releases int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.reserves, f.releases
}

func (f *fakeBudgetStore) advance(d time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.now = f.now.Add(d)
}

func (f *fakeBudgetStore) setErr(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.err = err
}

// budgeted is a verifier that accepts alicePass and refuses everything else, and
// carries the Okta-shaped default budget: 3 forwards per 15 minutes.
func budgeted() *fakeVerifier {
	return &fakeVerifier{
		name:   "okta",
		budget: &verify.Budget{Max: 3, Window: 15 * time.Minute},
		answer: func(pw string) (verify.Outcome, error) {
			if pw == alicePass {
				return verify.Verified, nil
			}
			return verify.Rejected, nil
		},
	}
}

func budgetFixture(t *testing.T, v *fakeVerifier, store *fakeBudgetStore, cache *credcache.Cache) (string, *fakeStore) {
	t.Helper()
	accounts := defaultStore()
	return newFixtureOpts(t, fixtureOptions{
		store:     accounts,
		resolver:  verify.Fixed(v),
		perMinute: 600,
		cache:     cache,
		budget:    store,
	}), accounts
}

func bindCode(t *testing.T, addr, password string) uint16 {
	t.Helper()
	err := dial(t, addr).Bind(aliceDN, password)
	if err == nil {
		return goldapclient.LDAPResultSuccess
	}
	return resultCode(err)
}

func bindErr(t *testing.T, addr, password string) error {
	t.Helper()
	return dial(t, addr).Bind(aliceDN, password)
}

func wrong(i int) string { return fmt.Sprintf("wrong-%d", i) }

// ⚠ THE POINT OF THE WHOLE FEATURE. Max distinct failures reach the provider,
// the next is refused here, and the provider is never asked.
func TestBudgetForwardsMaxFailuresThenRefusesLocally(t *testing.T) {
	v := budgeted()
	store := newFakeBudgetStore()
	addr, _ := budgetFixture(t, v, store, nil)

	for i := 1; i <= 3; i++ {
		if got := bindCode(t, addr, wrong(i)); got != goldapclient.LDAPResultInvalidCredentials {
			t.Fatalf("failure %d: result = %d, want invalidCredentials", i, got)
		}
	}
	if v.callCount() != 3 {
		t.Fatalf("provider called %d times for 3 failures, want 3", v.callCount())
	}

	err := bindErr(t, addr, wrong(4))
	if got := resultCode(err); got != goldapclient.LDAPResultBusy {
		t.Fatalf("the failure past the budget gave %d, want busy (51): %v", got, err)
	}
	if !strings.Contains(err.Error(), "budget") {
		t.Errorf("the diagnostic does not say why: %v", err)
	}
	if v.callCount() != 3 {
		t.Fatalf("provider called %d times after the budget was spent, want it to stay 3", v.callCount())
	}
}

// A person whose budget is spent can still read mail with the password that
// already works: the cache answers before the budget is consulted.
func TestCacheHitStillSucceedsWhileTheBudgetIsSpent(t *testing.T) {
	v := budgeted()
	store := newFakeBudgetStore()
	addr, _ := budgetFixture(t, v, store, credcache.New(2*time.Hour))

	if got := bindCode(t, addr, alicePass); got != goldapclient.LDAPResultSuccess {
		t.Fatalf("priming bind: result = %d", got)
	}
	for i := 1; i <= 3; i++ {
		bindCode(t, addr, wrong(i))
	}
	if got := bindCode(t, addr, wrong(4)); got != goldapclient.LDAPResultBusy {
		t.Fatalf("budget not spent: result = %d", got)
	}

	calls := v.callCount()
	if got := bindCode(t, addr, alicePass); got != goldapclient.LDAPResultSuccess {
		t.Fatalf("a cached password was refused while the budget was spent: result = %d", got)
	}
	if v.callCount() != calls {
		t.Fatal("the cache hit called the provider")
	}
}

func TestBudgetWindowResets(t *testing.T) {
	v := budgeted()
	store := newFakeBudgetStore()
	addr, _ := budgetFixture(t, v, store, nil)

	for i := 1; i <= 3; i++ {
		bindCode(t, addr, wrong(i))
	}
	if got := bindCode(t, addr, wrong(4)); got != goldapclient.LDAPResultBusy {
		t.Fatalf("budget not spent: result = %d", got)
	}

	store.advance(15*time.Minute - time.Second)
	if got := bindCode(t, addr, wrong(5)); got != goldapclient.LDAPResultBusy {
		t.Fatalf("window reopened a second early: result = %d", got)
	}

	store.advance(2 * time.Second)
	before := v.callCount()
	if got := bindCode(t, addr, wrong(6)); got != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("after the window: result = %d, want the provider's answer", got)
	}
	if v.callCount() != before+1 {
		t.Fatal("the new window did not forward")
	}
}

// Neither a success nor an outage is a failure the provider counted, so neither
// may spend the budget. A rejection IS one, and keeps its slot.
func TestVerifiedAndUnavailableReleaseTheSlotRejectedKeepsIt(t *testing.T) {
	v := budgeted()
	v.budget.Max = 1
	store := newFakeBudgetStore()
	addr, _ := budgetFixture(t, v, store, nil)

	// Unavailable: the slot comes back, so the next attempt is forwarded too.
	v.answer = func(string) (verify.Outcome, error) { return verify.Unavailable, errors.New("idp down") }
	for i := 0; i < 2; i++ {
		if got := bindCode(t, addr, wrong(i)); got != goldapclient.LDAPResultUnavailable {
			t.Fatalf("outage %d: result = %d, want unavailable (52)", i, got)
		}
		if n := store.count(aliceUID); n != 0 {
			t.Fatalf("outage %d left count = %d, want 0", i, n)
		}
	}
	if v.callCount() != 2 {
		t.Fatalf("provider called %d times, want 2 - an outage spent the budget", v.callCount())
	}

	// Verified: likewise.
	v.answer = func(string) (verify.Outcome, error) { return verify.Verified, nil }
	if got := bindCode(t, addr, alicePass); got != goldapclient.LDAPResultSuccess {
		t.Fatalf("verified: result = %d", got)
	}
	if n := store.count(aliceUID); n != 0 {
		t.Fatalf("a success left count = %d, want 0", n)
	}

	// Rejected: the slot stays, and with Max 1 the next distinct failure is refused.
	v.answer = func(string) (verify.Outcome, error) { return verify.Rejected, nil }
	if got := bindCode(t, addr, wrong(10)); got != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("rejected: result = %d", got)
	}
	if n := store.count(aliceUID); n != 1 {
		t.Fatalf("a rejection left count = %d, want 1", n)
	}
	if got := bindCode(t, addr, wrong(11)); got != goldapclient.LDAPResultBusy {
		t.Fatalf("second failure with Max 1: result = %d, want busy", got)
	}
}

// ⚠ FAIL CLOSED. If we cannot count, we do not know there is room, and guessing
// "yes" is how a database blip locks someone's real company account.
func TestBudgetStoreErrorMeansNoForwardAndUnavailable(t *testing.T) {
	v := budgeted()
	store := newFakeBudgetStore()
	store.setErr(errors.New("pgbouncer: connection refused"))
	addr, _ := budgetFixture(t, v, store, nil)

	if got := bindCode(t, addr, alicePass); got != goldapclient.LDAPResultUnavailable {
		t.Fatalf("result = %d, want unavailable (52) - never invalidCredentials for our own outage", got)
	}
	if v.callCount() != 0 {
		t.Fatalf("provider called %d times with the budget store down, want 0", v.callCount())
	}
}

func TestBudgetedVerifierWithoutAStoreIsNeverForwarded(t *testing.T) {
	v := budgeted()
	addr := newFixtureOpts(t, fixtureOptions{
		store: defaultStore(), resolver: verify.Fixed(v), perMinute: 60, // no budget store
	})
	if got := bindCode(t, addr, alicePass); got != goldapclient.LDAPResultUnavailable {
		t.Fatalf("result = %d, want unavailable (52)", got)
	}
	if v.callCount() != 0 {
		t.Fatal("a budgeted verifier was forwarded with nowhere to count")
	}
}

// A phone retrying its stale saved password must not burn the budget.
func TestIdenticalRetryIsAnsweredLocally(t *testing.T) {
	v := budgeted()
	store := newFakeBudgetStore()
	addr, _ := budgetFixture(t, v, store, nil)

	for i := 0; i < 5; i++ {
		if got := bindCode(t, addr, "stale-saved-password"); got != goldapclient.LDAPResultInvalidCredentials {
			t.Fatalf("retry %d: result = %d, want invalidCredentials", i, got)
		}
	}
	if v.callCount() != 1 {
		t.Fatalf("provider called %d times for one repeated password, want 1", v.callCount())
	}
	if n := store.count(aliceUID); n != 1 {
		t.Fatalf("budget count = %d, want 1 - retries spent slots", n)
	}
}

// Even with the budget spent, the password that was already refused is still
// answered as a plain wrong password rather than as "try later".
func TestIdenticalRetryStillAnswers49WhenTheBudgetIsSpent(t *testing.T) {
	v := budgeted()
	store := newFakeBudgetStore()
	addr, _ := budgetFixture(t, v, store, nil)

	for i := 1; i <= 3; i++ {
		bindCode(t, addr, wrong(i))
	}
	if got := bindCode(t, addr, wrong(1)); got != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("result = %d, want invalidCredentials for a password already refused", got)
	}
}

// A password reset moves the epoch (or clerk_updated_at). What was refused before
// says nothing about the new password.
func TestAnEpochOrUpdatedAtChangeClearsIdenticalFailures(t *testing.T) {
	for name, change := range map[string]func(*fakeStore){
		"epoch": func(s *fakeStore) { s.accounts[0].CredentialEpoch++ },
		"clerk_updated_at": func(s *fakeStore) {
			moved := time.Date(2026, 11, 7, 9, 0, 0, 0, time.UTC)
			s.accounts[0].ClerkUpdatedAt = &moved
		},
	} {
		t.Run(name, func(t *testing.T) {
			v := budgeted()
			store := newFakeBudgetStore()
			addr, accounts := budgetFixture(t, v, store, nil)

			bindCode(t, addr, "was-wrong")
			bindCode(t, addr, "was-wrong")
			if v.callCount() != 1 {
				t.Fatalf("setup: provider called %d times, want 1", v.callCount())
			}

			change(accounts)
			bindCode(t, addr, "was-wrong")
			if v.callCount() != 2 {
				t.Fatalf("provider called %d times, want 2 - the old refusal survived the change", v.callCount())
			}
		})
	}
}

// The per-DN throttle sits in front of the budget, so a request it turns away
// spends no slot.
func TestThrottleRunsBeforeTheBudgetReserve(t *testing.T) {
	v := budgeted()
	store := newFakeBudgetStore()
	addr := newFixtureOpts(t, fixtureOptions{
		store: defaultStore(), resolver: verify.Fixed(v), perMinute: 1, budget: store, // burst of 1
	})

	bindCode(t, addr, wrong(1))
	if got := bindCode(t, addr, wrong(2)); got != goldapclient.LDAPResultBusy {
		t.Fatalf("result = %d, want busy from the throttle", got)
	}
	if n := store.count(aliceUID); n != 1 {
		t.Fatalf("budget count = %d, want 1 - a throttled bind spent a slot", n)
	}
	if v.callCount() != 1 {
		t.Fatalf("provider called %d times, want 1", v.callCount())
	}
}

// Many clients, many connections, many wrong passwords at once, two pods' worth
// of them: the provider must still see no more than Max.
func TestConcurrentDistinctFailuresNeverExceedTheBudget(t *testing.T) {
	v := budgeted()
	v.delay = 50 * time.Millisecond
	store := newFakeBudgetStore()
	addr, _ := budgetFixture(t, v, store, nil)

	const attempts = 16
	var wg sync.WaitGroup
	for i := 0; i < attempts; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = bindCodeNoT(addr, wrong(i))
		}()
	}
	wg.Wait()

	if v.callCount() != 3 {
		t.Fatalf("provider saw %d failures at once, want exactly the budget of 3", v.callCount())
	}
}

// ⚠ MAIL CLIENTS OPEN SEVERAL CONNECTIONS AT ONCE, ALL WITH THE SAME PASSWORD.
// They share one verification - for Clerk too, since it changes no outcome.
func TestConcurrentIdenticalBindsMakeOneVerifierCall(t *testing.T) {
	v := &fakeVerifier{outcome: verify.Verified, delay: 200 * time.Millisecond}
	// No cache, so only the flight can be what collapses them.
	addr := newFixtureWith(t, defaultStore(), v, 600, nil)

	const clients = 10
	codes := make(chan uint16, clients)
	var wg sync.WaitGroup
	for i := 0; i < clients; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			codes <- bindCodeNoT(addr, alicePass)
		}()
	}
	wg.Wait()
	close(codes)

	for c := range codes {
		if c != goldapclient.LDAPResultSuccess {
			t.Fatalf("a collapsed bind got %d, want success", c)
		}
	}
	if v.callCount() != 1 {
		t.Fatalf("verifier called %d times for %d identical concurrent binds, want 1", v.callCount(), clients)
	}
}

// A flight is keyed by the password, so a different one must not ride along.
func TestConcurrentDifferentPasswordsDoNotShareAVerification(t *testing.T) {
	v := &fakeVerifier{
		delay: 100 * time.Millisecond,
		answer: func(pw string) (verify.Outcome, error) {
			if pw == alicePass {
				return verify.Verified, nil
			}
			return verify.Rejected, nil
		},
	}
	addr := newFixtureWith(t, defaultStore(), v, 600, nil)

	results := make(chan [2]uint16, 2)
	for _, pw := range []string{alicePass, "not-it"} {
		go func() { results <- [2]uint16{uint16(len(pw)), bindCodeNoT(addr, pw)} }()
	}
	got := map[uint16]uint16{}
	for i := 0; i < 2; i++ {
		r := <-results
		got[r[0]] = r[1]
	}
	if got[uint16(len(alicePass))] != goldapclient.LDAPResultSuccess ||
		got[uint16(len("not-it"))] != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("a wrong password shared the right one's verification: %v", got)
	}
	if v.callCount() != 2 {
		t.Fatalf("verifier called %d times, want 2", v.callCount())
	}
}

// ⚠ THE OPERATION DEADLINE ANSWERS UNAVAILABLE, AND THE WORK STILL FINISHES. A
// slow provider must not leave Stalwart waiting, and the verification has to run
// to its end anyway - or the slot it reserved would never come back.
func TestSlowVerificationAnswersUnavailableAndStillReleasesItsSlot(t *testing.T) {
	v := budgeted()
	v.budget.Max = 1
	v.delay = 400 * time.Millisecond
	store := newFakeBudgetStore()
	addr := newFixtureOpts(t, fixtureOptions{
		store: defaultStore(), resolver: verify.Fixed(v), perMinute: 60,
		budget: store, opTimeout: 100 * time.Millisecond,
	})

	if got := bindCode(t, addr, alicePass); got != goldapclient.LDAPResultUnavailable {
		t.Fatalf("result = %d, want unavailable (52) from the operation deadline", got)
	}

	deadline := time.Now().Add(3 * time.Second)
	for {
		_, releases := store.counts()
		if releases == 1 && store.count(aliceUID) == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("the slot was never released after the bind timed out (count=%d)", store.count(aliceUID))
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// bindCodeNoT is bindCode for goroutines, where t.Fatal is not allowed.
func bindCodeNoT(addr, password string) uint16 {
	c, err := goldapclient.Dial("tcp", addr)
	if err != nil {
		return 0
	}
	defer c.Close()
	if err := c.Bind(aliceDN, password); err != nil {
		return resultCode(err)
	}
	return goldapclient.LDAPResultSuccess
}

// The arithmetic in verify.MaxTimeout's comment: Stalwart's directory timeout is
// 15s (plan.ndjson), the longest verifier gets 12s, and authd's own operation
// deadline has to sit between them so it answers before Stalwart stops listening
// while still leaving room for the lookups around the verifier.
func TestOperationDeadlineSitsBetweenTheVerifierAndStalwart(t *testing.T) {
	const stalwartDirectoryTimeout = 15 * time.Second
	if ldapsrv.DefaultOpTimeout >= stalwartDirectoryTimeout {
		t.Fatalf("DefaultOpTimeout %s is not below Stalwart's %s", ldapsrv.DefaultOpTimeout, stalwartDirectoryTimeout)
	}
	if ldapsrv.DefaultOpTimeout < verify.MaxTimeout+2*time.Second {
		t.Fatalf("DefaultOpTimeout %s leaves under 2s above the %s verifier ceiling", ldapsrv.DefaultOpTimeout, verify.MaxTimeout)
	}
}
