package ldapsrv_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	goldapclient "github.com/go-ldap/ldap/v3"

	"github.com/i10-tech/i10/services/authd/internal/credcache"
	"github.com/i10-tech/i10/services/authd/internal/projection"
	"github.com/i10-tech/i10/services/authd/internal/verify"
)

// These exercise the bind path with a credential cache attached. The unit tests
// in internal/credcache cover the cache itself; what matters here is where it
// sits in handleBind, because the ordering is the security property.

func TestCacheCollapsesRepeatedBindsToOneClerkCall(t *testing.T) {
	v := &fakeVerifier{outcome: verify.Verified}
	addr := newFixtureWith(t, defaultStore(), v, 60, credcache.New(time.Minute))

	// What Apple Mail does on setup: several connections, each authenticating.
	for i := 0; i < 5; i++ {
		if err := dial(t, addr).Bind(aliceDN, alicePass); err != nil {
			t.Fatalf("bind %d: %v", i, err)
		}
	}
	if v.callCount() != 1 {
		t.Fatalf("verifier called %d times, want 1", v.callCount())
	}
}

// ⚠ THE ORDERING PROPERTY. The limiter protects the Clerk request budget, so a
// bind that spends none of that budget must spend none of its tokens either -
// otherwise a mail client opening six connections at once is throttled for
// calls it never made.
func TestCacheHitDoesNotSpendThrottleTokens(t *testing.T) {
	v := &fakeVerifier{outcome: verify.Verified}
	addr := newFixtureWith(t, defaultStore(), v, 1, credcache.New(time.Minute)) // burst of 1

	for i := 0; i < 4; i++ {
		if err := dial(t, addr).Bind(aliceDN, alicePass); err != nil {
			t.Fatalf("bind %d was refused with a burst of 1: %v", i, err)
		}
	}
	if v.callCount() != 1 {
		t.Fatalf("verifier called %d times, want 1", v.callCount())
	}
}

// ⚠ THE PROPERTY THE CACHE MUST NOT WEAKEN. Deactivation is checked by the
// projection lookup, which runs BEFORE the cache - so suspending an account
// takes effect on the very next bind, cached password or not.
func TestDeactivationBeatsAWarmCache(t *testing.T) {
	store := defaultStore()
	v := &fakeVerifier{outcome: verify.Verified}
	addr := newFixtureWith(t, store, v, 60, credcache.New(time.Minute))

	if err := dial(t, addr).Bind(aliceDN, alicePass); err != nil {
		t.Fatalf("first bind: %v", err)
	}

	// Suspended, unpaid, or deprovisioned.
	store.accounts[0].Active = false

	err := dial(t, addr).Bind(aliceDN, alicePass)
	if got := resultCode(err); got != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("result = %d, want invalidCredentials for a deactivated account", got)
	}
}

// ⚠ THE INVALIDATION. A password change moves Clerk's updated_at, the webhook
// writes it to the projection, and the cached entry stops matching. Without
// this the old password would keep working for the rest of the TTL.
func TestClerkUpdatedAtChangeForcesRevalidation(t *testing.T) {
	store := defaultStore()
	v := &fakeVerifier{outcome: verify.Verified}
	addr := newFixtureWith(t, store, v, 60, credcache.New(time.Minute))

	if err := dial(t, addr).Bind(aliceDN, alicePass); err != nil {
		t.Fatalf("first bind: %v", err)
	}
	if v.callCount() != 1 {
		t.Fatalf("verifier called %d times, want 1", v.callCount())
	}

	// The user changed something in Clerk - possibly the password.
	moved := time.Date(2026, 9, 2, 11, 0, 0, 0, time.UTC)
	store.accounts[0].ClerkUpdatedAt = &moved

	if err := dial(t, addr).Bind(aliceDN, alicePass); err != nil {
		t.Fatalf("second bind: %v", err)
	}
	if v.callCount() != 2 {
		t.Fatalf("verifier called %d times, want 2 - the cache did not revalidate", v.callCount())
	}
}

// A rejection must never be remembered: the user corrects their password and
// the next attempt has to reach Clerk.
func TestRejectionIsNeverCached(t *testing.T) {
	v := &fakeVerifier{outcome: verify.Rejected}
	addr := newFixtureWith(t, defaultStore(), v, 60, credcache.New(time.Minute))

	for i := 0; i < 3; i++ {
		if got := resultCode(dial(t, addr).Bind(aliceDN, "wrong")); got != goldapclient.LDAPResultInvalidCredentials {
			t.Fatalf("bind %d: result = %d, want invalidCredentials", i, got)
		}
	}
	if v.callCount() != 3 {
		t.Fatalf("verifier called %d times, want 3 - a rejection was cached", v.callCount())
	}
}

// Nor an unavailable answer, which is the absence of an answer rather than one.
func TestUnavailableIsNeverCached(t *testing.T) {
	v := &fakeVerifier{outcome: verify.Unavailable}
	addr := newFixtureWith(t, defaultStore(), v, 60, credcache.New(time.Minute))

	for i := 0; i < 2; i++ {
		if got := resultCode(dial(t, addr).Bind(aliceDN, alicePass)); got != goldapclient.LDAPResultUnavailable {
			t.Fatalf("bind %d: result = %d, want unavailable (52)", i, got)
		}
	}
	if v.callCount() != 2 {
		t.Fatalf("verifier called %d times, want 2", v.callCount())
	}
}

// A wrong password must miss even while a correct one is cached for the same
// account - the cache keys on the credential, not merely on the user.
func TestWrongPasswordMissesAWarmEntry(t *testing.T) {
	v := &fakeVerifier{outcome: verify.Verified}
	addr := newFixtureWith(t, defaultStore(), v, 60, credcache.New(time.Minute))

	if err := dial(t, addr).Bind(aliceDN, alicePass); err != nil {
		t.Fatalf("priming bind: %v", err)
	}

	v.setOutcome(verify.Rejected)
	if got := resultCode(dial(t, addr).Bind(aliceDN, "not-the-password")); got != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("result = %d, want invalidCredentials", got)
	}
	if v.callCount() != 2 {
		t.Fatalf("verifier called %d times, want 2 - the wrong password was served from cache", v.callCount())
	}
}

// The service bind is not a directory account and must not interact with the
// cache at all.
func TestServiceBindIsUnaffected(t *testing.T) {
	v := &fakeVerifier{outcome: verify.Verified}
	addr := newFixtureWith(t, defaultStore(), v, 60, credcache.New(time.Minute))

	for i := 0; i < 3; i++ {
		if err := dial(t, addr).Bind(svcDN, svcSecret); err != nil {
			t.Fatalf("service bind %d: %v", i, err)
		}
	}
	if got := resultCode(dial(t, addr).Bind(svcDN, "wrong-secret")); got != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("result = %d, want invalidCredentials", got)
	}
	if v.callCount() != 0 {
		t.Fatalf("verifier called %d times for service binds, want 0", v.callCount())
	}
}

// ⚠ THE SHARED SWITCH. The API raises credential_epoch for a revocation that
// leaves the row active and does not touch Clerk's record - and with a cache
// measured in hours, the next bind has to ask again.
func TestCredentialEpochRaiseForcesRevalidation(t *testing.T) {
	store := defaultStore()
	v := &fakeVerifier{outcome: verify.Verified}
	addr := newFixtureWith(t, store, v, 60, credcache.New(2*time.Hour))

	if err := dial(t, addr).Bind(aliceDN, alicePass); err != nil {
		t.Fatalf("first bind: %v", err)
	}
	if err := dial(t, addr).Bind(aliceDN, alicePass); err != nil {
		t.Fatalf("cached bind: %v", err)
	}
	if v.callCount() != 1 {
		t.Fatalf("verifier called %d times, want 1 before the epoch moves", v.callCount())
	}

	store.accounts[0].CredentialEpoch++

	if err := dial(t, addr).Bind(aliceDN, alicePass); err != nil {
		t.Fatalf("bind after the epoch moved: %v", err)
	}
	if v.callCount() != 2 {
		t.Fatalf("verifier called %d times, want 2 - the epoch did not invalidate the cache", v.callCount())
	}

	// And a revocation that makes the provider say no must now actually bite.
	store.accounts[0].CredentialEpoch++
	v.setOutcome(verify.Rejected)
	if got := resultCode(dial(t, addr).Bind(aliceDN, alicePass)); got != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("result = %d, want invalidCredentials once the epoch moved and the provider refuses", got)
	}
}

// A workspace that switches identity provider must never be answered from an
// entry the previous provider minted.
func TestVerifierNameMismatchMissesTheCache(t *testing.T) {
	clerk := &fakeVerifier{outcome: verify.Verified}
	okta := &fakeVerifier{name: "okta", outcome: verify.Rejected}
	current := &switchable{v: clerk}

	addr := newFixtureOpts(t, fixtureOptions{
		store:     defaultStore(),
		resolver:  current,
		perMinute: 60,
		cache:     credcache.New(2 * time.Hour),
	})

	if err := dial(t, addr).Bind(aliceDN, alicePass); err != nil {
		t.Fatalf("clerk bind: %v", err)
	}

	// The workspace moves to Okta, which has not agreed to this password.
	current.set(okta)
	if got := resultCode(dial(t, addr).Bind(aliceDN, alicePass)); got != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("result = %d, want invalidCredentials from the new provider", got)
	}
	if okta.callCount() != 1 {
		t.Fatalf("the new provider was called %d times, want 1 - it was answered from the old provider's cache", okta.callCount())
	}
}

// A resolver that cannot decide is not evidence about the password.
func TestResolverErrorIsUnavailableNotInvalidCredentials(t *testing.T) {
	addr := newFixtureOpts(t, fixtureOptions{
		store:     defaultStore(),
		resolver:  failingResolver{},
		perMinute: 60,
	})
	if got := resultCode(dial(t, addr).Bind(aliceDN, alicePass)); got != goldapclient.LDAPResultUnavailable {
		t.Fatalf("result = %d, want unavailable (52)", got)
	}
}

// ⚠ CLERK'S BEHAVIOUR, UNCHANGED: no budget means the budget code never runs and
// a rejection is never remembered. The store is wired and must stay untouched.
func TestVerifierWithoutABudgetNeverTouchesTheBudgetStore(t *testing.T) {
	store := newFakeBudgetStore()
	v := &fakeVerifier{outcome: verify.Rejected} // Budget() == nil, as Clerk's is
	addr := newFixtureOpts(t, fixtureOptions{
		store:     defaultStore(),
		resolver:  verify.Fixed(v),
		perMinute: 60,
		budget:    store,
	})

	// The same wrong password, three times: with no budget there is no
	// identical-retry shortcut, so each one has to reach the provider.
	for i := 0; i < 3; i++ {
		if got := resultCode(dial(t, addr).Bind(aliceDN, "wrong")); got != goldapclient.LDAPResultInvalidCredentials {
			t.Fatalf("bind %d: result = %d, want invalidCredentials", i, got)
		}
	}
	if v.callCount() != 3 {
		t.Fatalf("verifier called %d times, want 3 - a rejection was remembered", v.callCount())
	}
	if reserves, releases := store.counts(); reserves != 0 || releases != 0 {
		t.Fatalf("budget store touched (%d reserves, %d releases) for a verifier with no budget", reserves, releases)
	}
}

// switchable resolves to whichever verifier the test last selected.
type switchable struct {
	mu sync.Mutex
	v  verify.Verifier
}

func (s *switchable) Resolve(context.Context, *projection.Account) (verify.Verifier, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.v, nil
}

func (s *switchable) set(v verify.Verifier) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.v = v
}

type failingResolver struct{}

func (failingResolver) Resolve(context.Context, *projection.Account) (verify.Verifier, error) {
	return nil, errors.New("workspace lookup failed")
}
