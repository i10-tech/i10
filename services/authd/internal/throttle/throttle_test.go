package throttle

import (
	"testing"
	"time"
)

// clock lets the tests advance time without sleeping.
func (l *Limiter) setClock(t *time.Time) { l.now = func() time.Time { return *t } }

func TestAllowsBurstThenRefills(t *testing.T) {
	now := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	l := New(60) // one per second, burst of 60
	l.setClock(&now)

	// A legitimate mail client opens several connections at once; the whole
	// burst must go through without a rejection.
	for i := range 60 {
		if !l.Allow("uid=a") {
			t.Fatalf("attempt %d rejected inside the burst", i+1)
		}
	}
	if l.Allow("uid=a") {
		t.Fatal("61st attempt allowed; burst is not capped")
	}

	now = now.Add(2 * time.Second)
	if !l.Allow("uid=a") || !l.Allow("uid=a") {
		t.Fatal("bucket did not refill after 2s")
	}
	if l.Allow("uid=a") {
		t.Fatal("refilled beyond the elapsed time")
	}
}

func TestKeysAreIndependent(t *testing.T) {
	now := time.Now()
	l := New(1)
	l.setClock(&now)

	if !l.Allow("uid=a") {
		t.Fatal("first key rejected")
	}
	if l.Allow("uid=a") {
		t.Fatal("first key not throttled")
	}
	// One account exhausting its budget must not affect another.
	if !l.Allow("uid=b") {
		t.Fatal("second key throttled by the first")
	}
}

func TestSweepDropsIdleBuckets(t *testing.T) {
	now := time.Now()
	l := New(10)
	l.setClock(&now)

	l.Allow("uid=probe-1")
	l.Allow("uid=probe-2")
	if got := l.Len(); got != 2 {
		t.Fatalf("Len = %d, want 2", got)
	}

	now = now.Add(time.Minute)
	l.Allow("uid=recent")

	if removed := l.Sweep(30 * time.Second); removed != 2 {
		t.Fatalf("Sweep removed %d, want 2", removed)
	}
	if got := l.Len(); got != 1 {
		t.Fatalf("Len after sweep = %d, want 1 (the recent key)", got)
	}
}

func TestPerMinuteFloorsAtOne(t *testing.T) {
	// A misconfigured zero must not mean "deny everything".
	l := New(0)
	if !l.Allow("uid=a") {
		t.Fatal("New(0) denied the first attempt")
	}
}
