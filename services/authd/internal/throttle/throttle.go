// Package throttle rate-limits password verification per identity.
//
// Its purpose is narrower than it looks. It is NOT protecting users from
// Clerk's account lockout — we measured that, and the Backend API
// verify_password endpoint does not feed the lockout counter, so a mail client
// hammering a stale password cannot lock anyone out of their dashboard.
//
// What it protects is the Clerk request budget: 1000 requests per 10 seconds
// across everything i10 does. One misconfigured IMAP client reconnecting in a
// tight loop could spend that budget and take authentication down for every
// other mailbox. This caps the blast radius of a single account.
package throttle

import (
	"sync"
	"time"
)

type bucket struct {
	tokens float64
	last   time.Time
}

// Limiter is a per-key token bucket. Keys are DNs, so one account cannot
// exhaust the budget for another.
type Limiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket

	rate  float64 // tokens per second
	burst float64
	now   func() time.Time // injectable for tests
}

// New builds a limiter allowing perMinute verifications per key, sustained,
// with a burst equal to one minute's worth.
//
// A burst that size is deliberate: Apple Mail opens several connections per
// account at once and each authenticates, so a legitimate client produces a
// small cluster of binds in the same second. A limiter without headroom would
// reject ordinary mail clients.
func New(perMinute int) *Limiter {
	if perMinute < 1 {
		perMinute = 1
	}
	return &Limiter{
		buckets: map[string]*bucket{},
		rate:    float64(perMinute) / 60.0,
		burst:   float64(perMinute),
		now:     time.Now,
	}
}

// Allow reports whether a verification may proceed for this key, consuming a
// token when it may.
func (l *Limiter) Allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := l.now()
	b, ok := l.buckets[key]
	if !ok {
		b = &bucket{tokens: l.burst, last: now}
		l.buckets[key] = b
	}

	if elapsed := now.Sub(b.last).Seconds(); elapsed > 0 {
		b.tokens = min(l.burst, b.tokens+elapsed*l.rate)
		b.last = now
	}
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// Sweep drops buckets that have been idle long enough to have fully refilled.
// Without it the map grows once per distinct DN ever seen, which for a mail
// server is unbounded — every address an attacker probes would be remembered.
func (l *Limiter) Sweep(idleFor time.Duration) int {
	l.mu.Lock()
	defer l.mu.Unlock()

	cutoff := l.now().Add(-idleFor)
	removed := 0
	for key, b := range l.buckets {
		if b.last.Before(cutoff) {
			delete(l.buckets, key)
			removed++
		}
	}
	return removed
}

// Len reports the number of tracked keys.
func (l *Limiter) Len() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.buckets)
}
