// Package credcache remembers, briefly, that Clerk said yes.
//
// Every LDAP bind is one HTTPS round trip to Clerk — measured at roughly a
// second — and mail clients do not bind once. Apple Mail opens several
// connections to set up an account and reconnects constantly thereafter, so a
// single user reading their mail spends that second over and over. This caches
// the answer for sixty seconds.
//
// ⚠ IT BREAKS A PROPERTY THIS SERVICE USED TO HAVE, AND THAT IS THE POINT OF
// THIS COMMENT. `clerkauth` states that authd holds no password material of any
// kind — not a hash, not a verifier. With this package it holds one HMAC per
// recently-authenticated user, under a key generated at startup and never
// written down. That is weak material and it dies with the process, but it is
// material, and anyone auditing this service should meet that fact here rather
// than discover it.
//
// What has NOT changed: a deactivated account is still cut off instantly. The
// projection lookup in handleBind runs BEFORE this cache is consulted, so
// suspension, non-payment and deprovisioning take effect on the next bind. This
// only ever short-circuits the password check.
package credcache

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"sync"
	"time"
)

// maxEntries bounds memory when many accounts authenticate inside one TTL.
// Reaching it sweeps expired entries first and only then evicts; at sixty
// seconds it would take an implausible number of distinct users to get there.
const maxEntries = 10_000

type entry struct {
	mac []byte
	// changedAt is the account's `clerk_updated_at` as it stood when the
	// password was verified. See Lookup for why it is compared.
	changedAt time.Time
	hasTime   bool
	expires   time.Time
}

type Cache struct {
	mu      sync.Mutex
	entries map[string]entry

	ttl time.Duration
	// key never leaves this process and is never persisted. A restart makes
	// every stored MAC unverifiable, which is the correct failure mode.
	key []byte
	now func() time.Time
}

// New returns a cache holding verified credentials for ttl, or nil if ttl is
// not positive. A nil *Cache is safe to call every method on, so disabling the
// feature is a config value rather than a branch at each call site.
func New(ttl time.Duration) *Cache {
	if ttl <= 0 {
		return nil
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		// crypto/rand failing is not survivable, and a cache keyed on
		// predictable bytes is worse than no cache.
		panic("credcache: no entropy for the hmac key: " + err.Error())
	}
	return &Cache{
		entries: make(map[string]entry),
		ttl:     ttl,
		key:     key,
		now:     time.Now,
	}
}

// Lookup reports whether this exact password was verified for this user
// recently, under this value of clerkUpdatedAt.
//
// ⚠ THE TIMESTAMP IS THE INVALIDATION, AND IT IS WHY THIS IS DEFENSIBLE.
// Without it, rotating a password would leave the old one working for the whole
// TTL. `authd.accounts.clerk_updated_at` is Clerk's own `updated_at`, maintained
// by the webhook receiver in apps/api; handleBind has already read the row, so
// the current value costs nothing extra here. Clerk publishes no
// password-specific timestamp, so this moves on ANY profile change — it
// invalidates more often than strictly necessary, never less, which is the
// direction an authentication cache must err in. The same reasoning already
// governs what authd serves Stalwart as `pwdChangeTime`; see the column's
// comment in apps/api/src/db/schema.ts.
//
// ⚠ ONE ENTRY PER USER, KEYED BY USER AND NOT BY PASSWORD. Keying the map by
// (user, password) would give every password its own slot, and a password
// retired an hour ago would keep answering from its own entry until it expired.
// With one slot the newest verification overwrites the previous, so a password
// that is no longer current can only be served until its own TTL runs out — and
// not at all once anything else has authenticated.
func (c *Cache) Lookup(userID, password string, clerkUpdatedAt *time.Time) bool {
	if c == nil || userID == "" || password == "" {
		return false
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	e, ok := c.entries[userID]
	if !ok {
		return false
	}
	if !c.now().Before(e.expires) {
		delete(c.entries, userID)
		return false
	}
	if !sameInstant(e.changedAt, e.hasTime, clerkUpdatedAt) {
		// The account changed in Clerk since this entry was minted. The
		// password may be one of the things that changed.
		delete(c.entries, userID)
		return false
	}
	// hmac.Equal, not ==: the comparison is against attacker-supplied input and
	// must not leak how far it matched through timing.
	return hmac.Equal(e.mac, c.mac(userID, password))
}

// Store records that Clerk verified this password. Only ever called for a
// verified outcome — see handleBind, and the package comment in clerkauth for
// why a rejection must never be remembered.
func (c *Cache) Store(userID, password string, clerkUpdatedAt *time.Time) {
	if c == nil || userID == "" || password == "" {
		return
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	if len(c.entries) >= maxEntries {
		c.sweepLocked()
		if len(c.entries) >= maxEntries {
			// Still full of live entries. Dropping the write is right: the
			// cache is an optimisation, and evicting somebody else's valid
			// entry to make room would just move the cost around.
			return
		}
	}

	e := entry{
		mac:     c.mac(userID, password),
		expires: c.now().Add(c.ttl),
	}
	if clerkUpdatedAt != nil {
		e.changedAt, e.hasTime = *clerkUpdatedAt, true
	}
	c.entries[userID] = e
}

// Forget drops any entry for a user. Nothing calls it on the bind path — it
// exists so that a future invalidation signal has somewhere to land.
func (c *Cache) Forget(userID string) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.entries, userID)
}

// Len reports how many entries are held, expired ones included. For tests and
// for anything that later wants to report it.
func (c *Cache) Len() int {
	if c == nil {
		return 0
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.entries)
}

func (c *Cache) mac(userID, password string) []byte {
	m := hmac.New(sha256.New, c.key)
	// The user id is written with a length-prefixed separator so that
	// ("ab", "c") and ("a", "bc") cannot produce the same input.
	m.Write([]byte(userID))
	m.Write([]byte{0})
	m.Write([]byte(password))
	return m.Sum(nil)
}

func (c *Cache) sweepLocked() {
	now := c.now()
	for k, e := range c.entries {
		if !now.Before(e.expires) {
			delete(c.entries, k)
		}
	}
}

// sameInstant compares a stored timestamp against the one on the account row.
// Null and non-null are different, so an account whose timestamp appears or
// disappears invalidates rather than silently matching.
func sameInstant(stored time.Time, hasStored bool, incoming *time.Time) bool {
	if hasStored != (incoming != nil) {
		return false
	}
	if !hasStored {
		return true
	}
	return stored.Equal(*incoming)
}
