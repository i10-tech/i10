package credcache

import (
	"crypto/hmac"
	"sync"
	"time"
)

// perUserRejections bounds how many distinct wrong passwords are remembered for
// one person. The failure budget stops forwarding after a handful, so a longer
// list would only remember passwords nobody is going to be asked about.
const perUserRejections = 8

// Rejections remembers, briefly, which passwords an identity provider has
// already refused for an account, so that an identical retry is answered
// locally instead of being forwarded again.
//
// ⚠ THIS IS THE ONE PLACE A REJECTION IS EVER REMEMBERED, AND IT IS NOT THE
// CACHE ABOVE. Cache holds verified passwords only, because remembering a
// rejection there would leave a corrected password broken for the rest of a
// multi-hour TTL. This is different in three ways that make it safe:
//
//   - It exists only for providers with a failure budget, where the alternative
//     to remembering is spending a slot of someone's real account lockout on a
//     phone that retries the same stale password every few seconds.
//   - Its lifetime is the budget window, minutes rather than hours.
//   - Each record is bound to the account's `credential_epoch` and
//     `clerk_updated_at`. A password reset moves them, and every remembered
//     refusal for that account disappears with it.
//
// Like Cache it holds only HMACs under a per-process key that is never written
// anywhere, and it dies with the process. A nil *Rejections is safe to use and
// remembers nothing.
type Rejections struct {
	mu    sync.Mutex
	users map[string]*rejected

	key []byte
	now func() time.Time
}

type rejected struct {
	changedAt time.Time
	hasTime   bool
	epoch     int64
	macs      []rejection
}

type rejection struct {
	mac     []byte
	expires time.Time
}

func NewRejections() *Rejections {
	return &Rejections{
		users: make(map[string]*rejected),
		key:   newKey(),
		now:   time.Now,
	}
}

// Seen reports whether this exact password was refused for this subject and the
// refusal is still current.
func (r *Rejections) Seen(s Subject, password string) bool {
	if r == nil || s.UserID == "" || password == "" {
		return false
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	rec, ok := r.users[s.UserID]
	if !ok {
		return false
	}
	if rec.epoch != s.Epoch || !sameInstant(rec.changedAt, rec.hasTime, s.ChangedAt) {
		// The account changed, possibly its password. Nothing remembered about
		// the old state says anything about the new one.
		delete(r.users, s.UserID)
		return false
	}

	rec.pruneLocked(r.now())
	if len(rec.macs) == 0 {
		delete(r.users, s.UserID)
		return false
	}

	want := mac(r.key, s, password)
	for _, m := range rec.macs {
		if hmac.Equal(m.mac, want) {
			return true
		}
	}
	return false
}

// Remember records that the provider refused this password, for ttl. It is
// called only for a Rejected outcome that was actually forwarded.
func (r *Rejections) Remember(s Subject, password string, ttl time.Duration) {
	if r == nil || s.UserID == "" || password == "" || ttl <= 0 {
		return
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	now := r.now()
	rec, ok := r.users[s.UserID]
	if ok && (rec.epoch != s.Epoch || !sameInstant(rec.changedAt, rec.hasTime, s.ChangedAt)) {
		ok = false
	}
	if !ok {
		if len(r.users) >= maxEntries {
			r.sweepLocked(now)
			if len(r.users) >= maxEntries {
				// Full of live records. Dropping the write costs one extra
				// forward, which the budget still bounds.
				return
			}
		}
		rec = &rejected{epoch: s.Epoch}
		if s.ChangedAt != nil {
			rec.changedAt, rec.hasTime = *s.ChangedAt, true
		}
		r.users[s.UserID] = rec
	}

	rec.pruneLocked(now)
	m := mac(r.key, s, password)
	for i := range rec.macs {
		if hmac.Equal(rec.macs[i].mac, m) {
			rec.macs[i].expires = now.Add(ttl)
			return
		}
	}
	if len(rec.macs) >= perUserRejections {
		rec.macs = rec.macs[1:]
	}
	rec.macs = append(rec.macs, rejection{mac: m, expires: now.Add(ttl)})
}

// Len reports how many accounts have remembered refusals, for tests.
func (r *Rejections) Len() int {
	if r == nil {
		return 0
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.users)
}

func (rec *rejected) pruneLocked(now time.Time) {
	kept := rec.macs[:0]
	for _, m := range rec.macs {
		if now.Before(m.expires) {
			kept = append(kept, m)
		}
	}
	rec.macs = kept
}

func (r *Rejections) sweepLocked(now time.Time) {
	for id, rec := range r.users {
		rec.pruneLocked(now)
		if len(rec.macs) == 0 {
			delete(r.users, id)
		}
	}
}
