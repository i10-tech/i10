package verify

import (
	"context"
	"testing"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/projection"
)

type stub struct{ name string }

func (s stub) Name() string           { return s.name }
func (s stub) Timeout() time.Duration { return time.Second }
func (s stub) Budget() *Budget        { return nil }
func (s stub) Verify(context.Context, *projection.Account, string) (Outcome, error) {
	return Verified, nil
}

func TestFixedResolvesEveryAccountToTheSameVerifier(t *testing.T) {
	r := Fixed(stub{name: "clerk"})
	for _, id := range []string{"user_a", "user_b"} {
		v, err := r.Resolve(context.Background(), &projection.Account{ClerkUserID: id})
		if err != nil || v.Name() != "clerk" {
			t.Fatalf("Resolve(%s) = (%v, %v)", id, v, err)
		}
	}
}

// The zero value is the safe one: a verifier that forgets to set an outcome
// rejects rather than admits.
func TestZeroOutcomeIsRejected(t *testing.T) {
	var o Outcome
	if o != Rejected {
		t.Fatalf("zero Outcome = %v, want Rejected", o)
	}
}

func TestOutcomeStrings(t *testing.T) {
	for o, want := range map[Outcome]string{
		Verified: "verified", Rejected: "rejected", Unavailable: "unavailable",
	} {
		if o.String() != want {
			t.Errorf("%d.String() = %q, want %q", o, o.String(), want)
		}
	}
}
