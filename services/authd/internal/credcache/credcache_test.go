package credcache

import (
	"testing"
	"time"
)

func at(s string) *time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return &t
}

// newAt builds a cache whose clock the test drives.
func newAt(ttl time.Duration, clock *time.Time) *Cache {
	c := New(ttl)
	c.now = func() time.Time { return *clock }
	return c
}

// sub is the subject most tests use: user_1, verified by Clerk, at one instant
// and epoch.
func sub(ts *time.Time) Subject {
	return Subject{UserID: "user_1", Verifier: "clerk", ChangedAt: ts}
}

func TestStoreThenLookup(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	c := newAt(time.Minute, &now)
	ts := at("2026-09-02T10:00:00Z")

	if c.Lookup(sub(ts), "hunter2") {
		t.Fatal("empty cache reported a hit")
	}

	c.Store(sub(ts), "hunter2")

	if !c.Lookup(sub(ts), "hunter2") {
		t.Fatal("stored credential did not hit")
	}
	if c.Lookup(sub(ts), "hunter3") {
		t.Fatal("a different password hit")
	}
	other := sub(ts)
	other.UserID = "user_2"
	if c.Lookup(other, "hunter2") {
		t.Fatal("a different user hit")
	}
}

func TestExpiry(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	c := newAt(60*time.Second, &now)
	ts := at("2026-09-02T10:00:00Z")
	c.Store(sub(ts), "hunter2")

	now = now.Add(59 * time.Second)
	if !c.Lookup(sub(ts), "hunter2") {
		t.Fatal("expired one second early")
	}

	now = now.Add(2 * time.Second)
	if c.Lookup(sub(ts), "hunter2") {
		t.Fatal("served an entry past its TTL")
	}
	if c.Len() != 0 {
		t.Fatalf("expired entry was not dropped on read, len=%d", c.Len())
	}
}

// The production default. Nothing about the cache is special at this length, and
// that is the point: the clock arithmetic must hold across hours, not minutes.
func TestTwoHourTTLExpiresOnTheDot(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	c := newAt(2*time.Hour, &now)
	ts := at("2026-09-02T10:00:00Z")
	c.Store(sub(ts), "hunter2")

	now = now.Add(2*time.Hour - time.Second)
	if !c.Lookup(sub(ts), "hunter2") {
		t.Fatal("a two hour entry expired a second early")
	}

	now = now.Add(2 * time.Second)
	if c.Lookup(sub(ts), "hunter2") {
		t.Fatal("a two hour entry outlived its TTL")
	}
}

// ⚠ THE ONE THAT MAKES THE FEATURE DEFENSIBLE. Rotating a password moves
// Clerk's updated_at, the webhook writes it to the projection, and handleBind
// hands the new value here. Without this the old password would keep working
// for the rest of the TTL.
// A verifier can shorten its entries (verify.CacheLimit) or refuse them, but
// never outlive the cache's own TTL.
func TestStoreForShortensButNeverLengthens(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	c := newAt(time.Hour, &now)
	ts := at("2026-09-02T10:00:00Z")

	c.StoreFor(sub(ts), "hunter2", 0)
	if c.Lookup(sub(ts), "hunter2") {
		t.Fatal("a zero lifetime was cached")
	}

	c.StoreFor(sub(ts), "hunter2", 30*time.Minute)
	now = now.Add(31 * time.Minute)
	if c.Lookup(sub(ts), "hunter2") {
		t.Fatal("a 30 minute entry answered after 31 minutes")
	}

	c.StoreFor(sub(ts), "hunter2", 5*time.Hour)
	now = now.Add(61 * time.Minute)
	if c.Lookup(sub(ts), "hunter2") {
		t.Fatal("an entry outlived the cache's own one hour TTL")
	}
}

func TestClerkUpdatedAtInvalidates(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	c := newAt(time.Minute, &now)

	c.Store(sub(at("2026-09-02T10:00:00Z")), "hunter2")

	if c.Lookup(sub(at("2026-09-02T10:05:00Z")), "hunter2") {
		t.Fatal("a changed account still served the cached password")
	}
	// And the stale entry is gone, so it cannot come back if the timestamp
	// somehow reverts.
	if c.Lookup(sub(at("2026-09-02T10:00:00Z")), "hunter2") {
		t.Fatal("invalidated entry was still present")
	}
}

// ⚠ THE SHARED SWITCH. The API raises credential_epoch for a revocation that
// does not touch Clerk's record, and the entry must die at once.
func TestEpochInvalidates(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	c := newAt(2*time.Hour, &now)
	ts := at("2026-09-02T10:00:00Z")

	s := sub(ts)
	c.Store(s, "hunter2")
	if !c.Lookup(s, "hunter2") {
		t.Fatal("stored credential did not hit")
	}

	s.Epoch = 1
	if c.Lookup(s, "hunter2") {
		t.Fatal("a raised epoch still served the cached password")
	}
	// Gone, not merely skipped: an epoch that somehow went back must not
	// resurrect it.
	s.Epoch = 0
	if c.Lookup(s, "hunter2") {
		t.Fatal("an epoch-invalidated entry came back")
	}
	if c.Len() != 0 {
		t.Fatalf("invalidated entry was not dropped, len=%d", c.Len())
	}
}

// A workspace that switches identity provider must never be answered from an
// entry the previous provider minted: the new one has not agreed to the password.
func TestVerifierNameIsPartOfTheEntry(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	c := newAt(time.Minute, &now)
	ts := at("2026-09-02T10:00:00Z")

	c.Store(sub(ts), "hunter2")

	okta := sub(ts)
	okta.Verifier = "okta"
	if c.Lookup(okta, "hunter2") {
		t.Fatal("an entry minted by clerk answered for okta")
	}
	if !c.Lookup(sub(ts), "hunter2") {
		t.Fatal("the original verifier no longer hits")
	}
}

func TestNullTimestampsAreDistinctFromValues(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	c := newAt(time.Minute, &now)

	c.Store(sub(nil), "hunter2")
	if !c.Lookup(sub(nil), "hunter2") {
		t.Fatal("null-to-null did not match")
	}
	if c.Lookup(sub(at("2026-09-02T10:00:00Z")), "hunter2") {
		t.Fatal("null stored matched a real timestamp")
	}

	two := sub(at("2026-09-02T10:00:00Z"))
	two.UserID = "user_2"
	c.Store(two, "hunter2")
	two.ChangedAt = nil
	if c.Lookup(two, "hunter2") {
		t.Fatal("a real timestamp matched null")
	}
}

// ⚠ One slot per user, not one per password. Two passwords each keeping their
// own entry is how a retired credential outlives its rotation.
func TestNewVerificationReplacesTheOldPassword(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	c := newAt(time.Minute, &now)
	ts := at("2026-09-02T10:00:00Z")

	c.Store(sub(ts), "old")
	c.Store(sub(ts), "new")

	if c.Lookup(sub(ts), "old") {
		t.Fatal("the previous password survived a newer verification")
	}
	if !c.Lookup(sub(ts), "new") {
		t.Fatal("the newest password did not hit")
	}
	if c.Len() != 1 {
		t.Fatalf("expected one entry per user, got %d", c.Len())
	}
}

func TestForget(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	c := newAt(time.Minute, &now)
	ts := at("2026-09-02T10:00:00Z")
	c.Store(sub(ts), "hunter2")
	c.Forget("user_1")
	if c.Lookup(sub(ts), "hunter2") {
		t.Fatal("Forget did not drop the entry")
	}
}

// A nil cache is how the feature is switched off, so every method has to
// tolerate it rather than each call site testing for it.
func TestDisabledCacheIsSafe(t *testing.T) {
	var c *Cache
	if New(0) != nil {
		t.Fatal("a non-positive TTL should disable the cache")
	}
	if New(-time.Second) != nil {
		t.Fatal("a negative TTL should disable the cache")
	}
	c.Store(sub(nil), "hunter2")
	c.Forget("user_1")
	if c.Lookup(sub(nil), "hunter2") {
		t.Fatal("a nil cache reported a hit")
	}
	if c.Len() != 0 {
		t.Fatal("a nil cache reported entries")
	}
}

func TestEmptyInputsNeverCache(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	c := newAt(time.Minute, &now)

	// RFC 4513 §5.1.2 makes an empty password an unauthenticated bind, and
	// handleBind rejects it before reaching here - but a cache that could be
	// primed with one would be a bypass, so it refuses independently.
	c.Store(sub(nil), "")
	c.Store(Subject{Verifier: "clerk"}, "hunter2")
	if c.Len() != 0 {
		t.Fatalf("cached an empty credential, len=%d", c.Len())
	}
	if c.Lookup(sub(nil), "") || c.Lookup(Subject{Verifier: "clerk"}, "hunter2") {
		t.Fatal("an empty credential hit")
	}
}

// The MAC key is generated per process, so two caches never agree - a restart
// invalidates everything, which is the correct failure mode for this data.
func TestKeysAreNotShared(t *testing.T) {
	a, b := New(time.Minute), New(time.Minute)
	if string(a.key) == string(b.key) {
		t.Fatal("two caches were built with the same hmac key")
	}
	if string(mac(a.key, sub(nil), "hunter2")) == string(mac(b.key, sub(nil), "hunter2")) {
		t.Fatal("two caches produced the same mac")
	}
}

// The separator stops ("ab","c") and ("a","bc") colliding, which would let one
// account's cached entry answer for another - or one provider's for another's.
func TestFieldsCannotCollide(t *testing.T) {
	c := New(time.Minute)
	if string(mac(c.key, Subject{UserID: "ab", Verifier: "x"}, "c")) ==
		string(mac(c.key, Subject{UserID: "a", Verifier: "x"}, "bc")) {
		t.Fatal("user id and password are concatenated without a separator")
	}
	if string(mac(c.key, Subject{UserID: "u", Verifier: "ab"}, "c")) ==
		string(mac(c.key, Subject{UserID: "u", Verifier: "a"}, "bc")) {
		t.Fatal("verifier name and password are concatenated without a separator")
	}
}

func TestSweepBoundsMemory(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	c := newAt(time.Minute, &now)

	for i := 0; i < maxEntries; i++ {
		c.Store(Subject{UserID: string(rune(i)) + "-user", Verifier: "clerk"}, "hunter2")
	}
	if c.Len() != maxEntries {
		t.Fatalf("expected %d entries, got %d", maxEntries, c.Len())
	}

	// Everything ages out; the next write sweeps rather than refusing.
	now = now.Add(2 * time.Minute)
	fresh := Subject{UserID: "fresh", Verifier: "clerk"}
	c.Store(fresh, "hunter2")
	if c.Len() != 1 {
		t.Fatalf("sweep left %d entries, expected 1", c.Len())
	}
	if !c.Lookup(fresh, "hunter2") {
		t.Fatal("the write that triggered the sweep was lost")
	}
}
