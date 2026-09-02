package ldapsrv_test

import (
	"testing"
	"time"

	goldapclient "github.com/go-ldap/ldap/v3"

	"github.com/i10-tech/i10/services/authd/internal/clerkauth"
	"github.com/i10-tech/i10/services/authd/internal/credcache"
)

// These exercise the bind path with a credential cache attached. The unit tests
// in internal/credcache cover the cache itself; what matters here is where it
// sits in handleBind, because the ordering is the security property.

func TestCacheCollapsesRepeatedBindsToOneClerkCall(t *testing.T) {
	v := &fakeVerifier{outcome: clerkauth.Verified}
	addr := newFixtureWith(t, defaultStore(), v, 60, credcache.New(time.Minute))

	// What Apple Mail does on setup: several connections, each authenticating.
	for i := 0; i < 5; i++ {
		if err := dial(t, addr).Bind(aliceDN, alicePass); err != nil {
			t.Fatalf("bind %d: %v", i, err)
		}
	}
	if v.calls != 1 {
		t.Fatalf("verifier called %d times, want 1", v.calls)
	}
}

// ⚠ THE ORDERING PROPERTY. The limiter protects the Clerk request budget, so a
// bind that spends none of that budget must spend none of its tokens either —
// otherwise a mail client opening six connections at once is throttled for
// calls it never made.
func TestCacheHitDoesNotSpendThrottleTokens(t *testing.T) {
	v := &fakeVerifier{outcome: clerkauth.Verified}
	addr := newFixtureWith(t, defaultStore(), v, 1, credcache.New(time.Minute)) // burst of 1

	for i := 0; i < 4; i++ {
		if err := dial(t, addr).Bind(aliceDN, alicePass); err != nil {
			t.Fatalf("bind %d was refused with a burst of 1: %v", i, err)
		}
	}
	if v.calls != 1 {
		t.Fatalf("verifier called %d times, want 1", v.calls)
	}
}

// ⚠ THE PROPERTY THE CACHE MUST NOT WEAKEN. Deactivation is checked by the
// projection lookup, which runs BEFORE the cache — so suspending an account
// takes effect on the very next bind, cached password or not.
func TestDeactivationBeatsAWarmCache(t *testing.T) {
	store := defaultStore()
	v := &fakeVerifier{outcome: clerkauth.Verified}
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
	v := &fakeVerifier{outcome: clerkauth.Verified}
	addr := newFixtureWith(t, store, v, 60, credcache.New(time.Minute))

	if err := dial(t, addr).Bind(aliceDN, alicePass); err != nil {
		t.Fatalf("first bind: %v", err)
	}
	if v.calls != 1 {
		t.Fatalf("verifier called %d times, want 1", v.calls)
	}

	// The user changed something in Clerk — possibly the password.
	moved := time.Date(2026, 9, 2, 11, 0, 0, 0, time.UTC)
	store.accounts[0].ClerkUpdatedAt = &moved

	if err := dial(t, addr).Bind(aliceDN, alicePass); err != nil {
		t.Fatalf("second bind: %v", err)
	}
	if v.calls != 2 {
		t.Fatalf("verifier called %d times, want 2 — the cache did not revalidate", v.calls)
	}
}

// A rejection must never be remembered: the user corrects their password and
// the next attempt has to reach Clerk.
func TestRejectionIsNeverCached(t *testing.T) {
	v := &fakeVerifier{outcome: clerkauth.Rejected}
	addr := newFixtureWith(t, defaultStore(), v, 60, credcache.New(time.Minute))

	for i := 0; i < 3; i++ {
		if got := resultCode(dial(t, addr).Bind(aliceDN, "wrong")); got != goldapclient.LDAPResultInvalidCredentials {
			t.Fatalf("bind %d: result = %d, want invalidCredentials", i, got)
		}
	}
	if v.calls != 3 {
		t.Fatalf("verifier called %d times, want 3 — a rejection was cached", v.calls)
	}
}

// Nor an unavailable answer, which is the absence of an answer rather than one.
func TestUnavailableIsNeverCached(t *testing.T) {
	v := &fakeVerifier{outcome: clerkauth.Unavailable}
	addr := newFixtureWith(t, defaultStore(), v, 60, credcache.New(time.Minute))

	for i := 0; i < 2; i++ {
		if got := resultCode(dial(t, addr).Bind(aliceDN, alicePass)); got != goldapclient.LDAPResultUnavailable {
			t.Fatalf("bind %d: result = %d, want unavailable (52)", i, got)
		}
	}
	if v.calls != 2 {
		t.Fatalf("verifier called %d times, want 2", v.calls)
	}
}

// A wrong password must miss even while a correct one is cached for the same
// account — the cache keys on the credential, not merely on the user.
func TestWrongPasswordMissesAWarmEntry(t *testing.T) {
	v := &fakeVerifier{outcome: clerkauth.Verified}
	addr := newFixtureWith(t, defaultStore(), v, 60, credcache.New(time.Minute))

	if err := dial(t, addr).Bind(aliceDN, alicePass); err != nil {
		t.Fatalf("priming bind: %v", err)
	}

	v.outcome = clerkauth.Rejected
	if got := resultCode(dial(t, addr).Bind(aliceDN, "not-the-password")); got != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("result = %d, want invalidCredentials", got)
	}
	if v.calls != 2 {
		t.Fatalf("verifier called %d times, want 2 — the wrong password was served from cache", v.calls)
	}
}

// The service bind is not a directory account and must not interact with the
// cache at all.
func TestServiceBindIsUnaffected(t *testing.T) {
	v := &fakeVerifier{outcome: clerkauth.Verified}
	addr := newFixtureWith(t, defaultStore(), v, 60, credcache.New(time.Minute))

	for i := 0; i < 3; i++ {
		if err := dial(t, addr).Bind(svcDN, svcSecret); err != nil {
			t.Fatalf("service bind %d: %v", i, err)
		}
	}
	if got := resultCode(dial(t, addr).Bind(svcDN, "wrong-secret")); got != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("result = %d, want invalidCredentials", got)
	}
	if v.calls != 0 {
		t.Fatalf("verifier called %d times for service binds, want 0", v.calls)
	}
}
