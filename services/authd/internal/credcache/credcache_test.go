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

func TestStoreThenLookup(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	c := newAt(time.Minute, &now)
	ts := at("2026-09-02T10:00:00Z")

	if c.Lookup("user_1", "hunter2", ts) {
		t.Fatal("empty cache reported a hit")
	}

	c.Store("user_1", "hunter2", ts)

	if !c.Lookup("user_1", "hunter2", ts) {
		t.Fatal("stored credential did not hit")
	}
	if c.Lookup("user_1", "hunter3", ts) {
		t.Fatal("a different password hit")
	}
	if c.Lookup("user_2", "hunter2", ts) {
		t.Fatal("a different user hit")
	}
}

func TestExpiry(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	c := newAt(60*time.Second, &now)
	ts := at("2026-09-02T10:00:00Z")
	c.Store("user_1", "hunter2", ts)

	now = now.Add(59 * time.Second)
	if !c.Lookup("user_1", "hunter2", ts) {
		t.Fatal("expired one second early")
	}

	now = now.Add(2 * time.Second)
	if c.Lookup("user_1", "hunter2", ts) {
		t.Fatal("served an entry past its TTL")
	}
	if c.Len() != 0 {
		t.Fatalf("expired entry was not dropped on read, len=%d", c.Len())
	}
}

// ⚠ THE ONE THAT MAKES THE FEATURE DEFENSIBLE. Rotating a password moves
// Clerk's updated_at, the webhook writes it to the projection, and handleBind
// hands the new value here. Without this the old password would keep working
// for the rest of the TTL.
func TestClerkUpdatedAtInvalidates(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	c := newAt(time.Minute, &now)

	c.Store("user_1", "hunter2", at("2026-09-02T10:00:00Z"))

	if c.Lookup("user_1", "hunter2", at("2026-09-02T10:05:00Z")) {
		t.Fatal("a changed account still served the cached password")
	}
	// And the stale entry is gone, so it cannot come back if the timestamp
	// somehow reverts.
	if c.Lookup("user_1", "hunter2", at("2026-09-02T10:00:00Z")) {
		t.Fatal("invalidated entry was still present")
	}
}

func TestNullTimestampsAreDistinctFromValues(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	c := newAt(time.Minute, &now)

	c.Store("user_1", "hunter2", nil)
	if !c.Lookup("user_1", "hunter2", nil) {
		t.Fatal("null-to-null did not match")
	}
	if c.Lookup("user_1", "hunter2", at("2026-09-02T10:00:00Z")) {
		t.Fatal("null stored matched a real timestamp")
	}

	c.Store("user_2", "hunter2", at("2026-09-02T10:00:00Z"))
	if c.Lookup("user_2", "hunter2", nil) {
		t.Fatal("a real timestamp matched null")
	}
}

// ⚠ One slot per user, not one per password. Two passwords each keeping their
// own entry is how a retired credential outlives its rotation.
func TestNewVerificationReplacesTheOldPassword(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	c := newAt(time.Minute, &now)
	ts := at("2026-09-02T10:00:00Z")

	c.Store("user_1", "old", ts)
	c.Store("user_1", "new", ts)

	if c.Lookup("user_1", "old", ts) {
		t.Fatal("the previous password survived a newer verification")
	}
	if !c.Lookup("user_1", "new", ts) {
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
	c.Store("user_1", "hunter2", ts)
	c.Forget("user_1")
	if c.Lookup("user_1", "hunter2", ts) {
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
	c.Store("user_1", "hunter2", nil)
	c.Forget("user_1")
	if c.Lookup("user_1", "hunter2", nil) {
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
	// handleBind rejects it before reaching here — but a cache that could be
	// primed with one would be a bypass, so it refuses independently.
	c.Store("user_1", "", nil)
	c.Store("", "hunter2", nil)
	if c.Len() != 0 {
		t.Fatalf("cached an empty credential, len=%d", c.Len())
	}
	if c.Lookup("user_1", "", nil) || c.Lookup("", "hunter2", nil) {
		t.Fatal("an empty credential hit")
	}
}

// The MAC key is generated per process, so two caches never agree — a restart
// invalidates everything, which is the correct failure mode for this data.
func TestKeysAreNotShared(t *testing.T) {
	a, b := New(time.Minute), New(time.Minute)
	if string(a.key) == string(b.key) {
		t.Fatal("two caches were built with the same hmac key")
	}
	if string(a.mac("user_1", "hunter2")) == string(b.mac("user_1", "hunter2")) {
		t.Fatal("two caches produced the same mac")
	}
}

// The separator stops ("ab","c") and ("a","bc") colliding, which would let one
// account's cached entry answer for another.
func TestUserAndPasswordCannotCollide(t *testing.T) {
	c := New(time.Minute)
	if string(c.mac("ab", "c")) == string(c.mac("a", "bc")) {
		t.Fatal("user id and password are concatenated without a separator")
	}
}

func TestSweepBoundsMemory(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	c := newAt(time.Minute, &now)

	for i := 0; i < maxEntries; i++ {
		c.Store(string(rune(i))+"-user", "hunter2", nil)
	}
	if c.Len() != maxEntries {
		t.Fatalf("expected %d entries, got %d", maxEntries, c.Len())
	}

	// Everything ages out; the next write sweeps rather than refusing.
	now = now.Add(2 * time.Minute)
	c.Store("fresh", "hunter2", nil)
	if c.Len() != 1 {
		t.Fatalf("sweep left %d entries, expected 1", c.Len())
	}
	if !c.Lookup("fresh", "hunter2", nil) {
		t.Fatal("the write that triggered the sweep was lost")
	}
}
