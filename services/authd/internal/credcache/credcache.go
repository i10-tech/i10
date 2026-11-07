// Package credcache remembers, for hours, that an identity provider said yes.
//
// Every LDAP bind is one HTTPS round trip to the provider - roughly a second for
// Clerk, one to seven for Okta - and mail clients do not bind once. Apple Mail
// opens several connections to set up an account and reconnects constantly
// thereafter, so a single user reading their mail spends that second over and
// over. This caches the answer for the configured TTL (two hours by default).
//
// ⚠ IT BREAKS A PROPERTY THIS SERVICE USED TO HAVE, AND THAT IS THE POINT OF
// THIS COMMENT. `clerkauth` states that authd holds no password material of any
// kind - not a hash, not a verifier. With this package it holds one HMAC per
// recently-authenticated user, under a key generated at startup and never
// written down. That is weak material and it dies with the process, but it is
// material, and anyone auditing this service should meet that fact here rather
// than discover it.
//
// ⚠ A TTL THAT LONG IS DEFENSIBLE ONLY BECAUSE REVOCATION DOES NOT WAIT FOR IT.
// Three things cut a cached password off at the next bind, none of them a timer:
//
//   - The projection lookup in handleBind runs BEFORE this cache is consulted,
//     so suspension, non-payment and deprovisioning take effect immediately.
//   - `clerk_updated_at` moves on any change to the person in Clerk, a password
//     change included, and a moved value deletes the entry.
//   - `credential_epoch` is the shared switch for everything else. It lives in
//     Postgres, so raising it from the API reaches both Stalwart pods at once.
//
// The TTL itself is only the backstop for a revocation nobody signalled.
package credcache

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"sync"
	"time"
)

// maxEntries bounds memory when many accounts authenticate inside one TTL.
// Reaching it sweeps expired entries first and only then evicts. At two hours it
// is a real limit rather than an implausible one, so the drop-the-write branch
// in Store is live code.
const maxEntries = 10_000

// Subject is everything about an account, other than the password, that a cached
// answer is only valid for. A change in any field makes the entry stop matching.
type Subject struct {
	UserID string

	// Verifier is the name of the provider that answered. It is part of the MAC,
	// so a workspace that switches provider can never be served an entry the
	// previous provider minted - the new provider has not agreed to this password.
	Verifier string

	// ChangedAt is the account's `clerk_updated_at`. See Cache.Lookup.
	ChangedAt *time.Time

	// Epoch is the account's `credential_epoch`. See Cache.Lookup.
	Epoch int64
}

type entry struct {
	mac []byte
	// changedAt is the account's `clerk_updated_at` as it stood when the
	// password was verified.
	changedAt time.Time
	hasTime   bool
	epoch     int64
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
	return &Cache{
		entries: make(map[string]entry),
		ttl:     ttl,
		key:     newKey(),
		now:     time.Now,
	}
}

// newKey generates a per-process HMAC key.
func newKey() []byte {
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		// crypto/rand failing is not survivable, and a cache keyed on
		// predictable bytes is worse than no cache.
		panic("credcache: no entropy for the hmac key: " + err.Error())
	}
	return key
}

// Lookup reports whether this exact password was verified for this subject
// recently.
//
// ⚠ THE TIMESTAMP AND THE EPOCH ARE THE INVALIDATION, AND THEY ARE WHY A
// MULTI-HOUR TTL IS DEFENSIBLE. Without them, rotating a password would leave the
// old one working for the whole TTL.
//
// `authd.accounts.clerk_updated_at` is Clerk's own `updated_at`, maintained by
// the webhook receiver in apps/api. Clerk publishes no password-specific
// timestamp, so it moves on ANY profile change - it invalidates more often than
// strictly necessary, never less, which is the direction an authentication cache
// must err in. The same reasoning governs what authd serves Stalwart as
// `pwdChangeTime`; see the column's comment in apps/api/src/db/schema.ts.
//
// `authd.accounts.credential_epoch` covers the revocations that do not touch
// Clerk's record: the API raises it, and every pod's next bind sees the new
// value because handleBind has already read the row. A mismatch on EITHER value
// deletes the entry. Both come from the row handleBind just read, so checking
// them costs no extra query.
//
// ⚠ ONE ENTRY PER USER, KEYED BY USER AND NOT BY PASSWORD. Keying the map by
// (user, password) would give every password its own slot, and a password
// retired an hour ago would keep answering from its own entry until it expired.
// With one slot the newest verification overwrites the previous, so a password
// that is no longer current can only be served until its own TTL runs out - and
// not at all once anything else has authenticated.
func (c *Cache) Lookup(s Subject, password string) bool {
	if c == nil || s.UserID == "" || password == "" {
		return false
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	e, ok := c.entries[s.UserID]
	if !ok {
		return false
	}
	if !c.now().Before(e.expires) {
		delete(c.entries, s.UserID)
		return false
	}
	if e.epoch != s.Epoch || !sameInstant(e.changedAt, e.hasTime, s.ChangedAt) {
		// The account was revoked or changed since this entry was minted. The
		// password may be one of the things that changed.
		delete(c.entries, s.UserID)
		return false
	}
	// hmac.Equal, not ==: the comparison is against attacker-supplied input and
	// must not leak how far it matched through timing.
	return hmac.Equal(e.mac, mac(c.key, s, password))
}

// Store records that a provider verified this password. Only ever called for a
// verified outcome - see handleBind, and the package comment in clerkauth for
// why a rejection must never be remembered.
func (c *Cache) Store(s Subject, password string) {
	if c == nil || s.UserID == "" || password == "" {
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
		mac:     mac(c.key, s, password),
		epoch:   s.Epoch,
		expires: c.now().Add(c.ttl),
	}
	if s.ChangedAt != nil {
		e.changedAt, e.hasTime = *s.ChangedAt, true
	}
	c.entries[s.UserID] = e
}

// Forget drops any entry for a user. Nothing calls it on the bind path - the
// epoch is what invalidates there - it exists so that a future in-process
// signal has somewhere to land.
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

func (c *Cache) sweepLocked() {
	now := c.now()
	for k, e := range c.entries {
		if !now.Before(e.expires) {
			delete(c.entries, k)
		}
	}
}

// mac binds a password to the account and the provider that verified it. The
// fields are separated by a NUL so that ("ab", "c") and ("a", "bc") cannot
// produce the same input; neither a Clerk user id nor a verifier name can
// contain one.
func mac(key []byte, s Subject, password string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(s.UserID))
	m.Write([]byte{0})
	m.Write([]byte(s.Verifier))
	m.Write([]byte{0})
	m.Write([]byte(password))
	return m.Sum(nil)
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
