package credcache

import (
	"testing"
	"time"
)

func newRejectionsAt(clock *time.Time) *Rejections {
	r := NewRejections()
	r.now = func() time.Time { return *clock }
	return r
}

func TestRememberedRejectionIsSeen(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	r := newRejectionsAt(&now)
	s := sub(at("2026-09-02T10:00:00Z"))

	if r.Seen(s, "stale") {
		t.Fatal("an empty memory reported a refusal")
	}
	r.Remember(s, "stale", 15*time.Minute)
	if !r.Seen(s, "stale") {
		t.Fatal("a remembered refusal was not seen")
	}
	if r.Seen(s, "different") {
		t.Fatal("a different password was reported as refused")
	}
	other := s
	other.UserID = "user_2"
	if r.Seen(other, "stale") {
		t.Fatal("another user's refusal leaked")
	}
}

func TestRejectionExpiresWithItsWindow(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	r := newRejectionsAt(&now)
	s := sub(nil)
	r.Remember(s, "stale", 15*time.Minute)

	now = now.Add(15*time.Minute - time.Second)
	if !r.Seen(s, "stale") {
		t.Fatal("forgotten a second early")
	}
	now = now.Add(2 * time.Second)
	if r.Seen(s, "stale") {
		t.Fatal("a refusal outlived its window")
	}
	if r.Len() != 0 {
		t.Fatalf("expired record was not dropped, len=%d", r.Len())
	}
}

// ⚠ A password reset moves the epoch or clerk_updated_at. The old refusal says
// nothing about the new password, and must not be able to refuse it.
func TestEpochOrUpdatedAtClearsRejections(t *testing.T) {
	for name, change := range map[string]func(*Subject){
		"epoch":      func(s *Subject) { s.Epoch++ },
		"updated at": func(s *Subject) { s.ChangedAt = at("2026-09-02T11:00:00Z") },
	} {
		t.Run(name, func(t *testing.T) {
			now := time.Unix(1_000_000, 0)
			r := newRejectionsAt(&now)
			s := sub(at("2026-09-02T10:00:00Z"))
			r.Remember(s, "stale", 15*time.Minute)

			changed := s
			change(&changed)
			if r.Seen(changed, "stale") {
				t.Fatal("a refusal survived a change to the account")
			}
			// Gone for good, not only hidden from the changed view.
			if r.Seen(s, "stale") {
				t.Fatal("the cleared refusal came back")
			}
		})
	}
}

func TestRememberAfterAChangeStartsAFreshRecord(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	r := newRejectionsAt(&now)
	s := sub(nil)
	r.Remember(s, "old-stale", 15*time.Minute)

	s.Epoch = 1
	r.Remember(s, "new-stale", 15*time.Minute)
	if r.Seen(s, "old-stale") {
		t.Fatal("a refusal from before the change was kept")
	}
	if !r.Seen(s, "new-stale") {
		t.Fatal("the new refusal was lost")
	}
}

func TestRejectionIsBoundToTheVerifier(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	r := newRejectionsAt(&now)
	s := sub(nil)
	r.Remember(s, "stale", 15*time.Minute)

	other := s
	other.Verifier = "okta"
	if r.Seen(other, "stale") {
		t.Fatal("a refusal from one provider answered for another")
	}
}

func TestPerUserRejectionsAreBounded(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	r := newRejectionsAt(&now)
	s := sub(nil)

	for i := 0; i < perUserRejections+3; i++ {
		r.Remember(s, "pw-"+string(rune('a'+i)), 15*time.Minute)
	}
	// The oldest are dropped first.
	if r.Seen(s, "pw-a") {
		t.Fatal("the oldest refusal was kept past the bound")
	}
	last := "pw-" + string(rune('a'+perUserRejections+2))
	if !r.Seen(s, last) {
		t.Fatal("the newest refusal was lost")
	}
	if n := len(r.users[s.UserID].macs); n != perUserRejections {
		t.Fatalf("kept %d refusals for one user, want %d", n, perUserRejections)
	}
}

func TestRepeatedRememberDoesNotGrowTheList(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	r := newRejectionsAt(&now)
	s := sub(nil)
	for i := 0; i < 5; i++ {
		r.Remember(s, "stale", 15*time.Minute)
	}
	if n := len(r.users[s.UserID].macs); n != 1 {
		t.Fatalf("kept %d copies of one refusal", n)
	}
}

func TestRejectionsAreBoundedOverall(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	r := newRejectionsAt(&now)
	for i := 0; i < maxEntries; i++ {
		r.Remember(Subject{UserID: string(rune(i)) + "-user", Verifier: "okta"}, "pw", time.Minute)
	}
	if r.Len() != maxEntries {
		t.Fatalf("expected %d records, got %d", maxEntries, r.Len())
	}

	// Full of live records: the write is dropped, not made by evicting a
	// stranger.
	r.Remember(Subject{UserID: "extra", Verifier: "okta"}, "pw", time.Minute)
	if r.Len() != maxEntries {
		t.Fatalf("grew past the bound: %d", r.Len())
	}

	// Everything ages out and the next write sweeps.
	now = now.Add(2 * time.Minute)
	fresh := Subject{UserID: "fresh", Verifier: "okta"}
	r.Remember(fresh, "pw", time.Minute)
	if r.Len() != 1 || !r.Seen(fresh, "pw") {
		t.Fatalf("sweep left %d records", r.Len())
	}
}

func TestNilRejectionsIsSafe(t *testing.T) {
	var r *Rejections
	r.Remember(sub(nil), "pw", time.Minute)
	if r.Seen(sub(nil), "pw") || r.Len() != 0 {
		t.Fatal("a nil memory remembered something")
	}
}

func TestEmptyInputsAreNeverRemembered(t *testing.T) {
	r := NewRejections()
	r.Remember(sub(nil), "", time.Minute)
	r.Remember(Subject{Verifier: "okta"}, "pw", time.Minute)
	r.Remember(sub(nil), "pw", 0)
	if r.Len() != 0 {
		t.Fatalf("remembered an empty input, len=%d", r.Len())
	}
}
