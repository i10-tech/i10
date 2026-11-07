// Package verify is the seam between a bind and whatever holds the password.
//
// Today that is always Clerk. It will not stay that way: a workspace that signs
// in through Okta or Entra keeps its password at that identity provider, and the
// bind has to ask the right one. handleBind therefore depends on this package's
// interfaces and never on a particular provider.
//
// Every verifier answers with the same tri-state Outcome, and the third state is
// the one that matters. "We could not find out" is not "wrong password", and
// collapsing them is the most damaging bug a verifier can ship: it makes every
// mail client in the fleet conclude the stored password is wrong during an
// outage. A verifier returns Unavailable for anything that is not a clear answer
// about the password - timeouts, 429s, 5xx, a misconfigured connection.
package verify

import (
	"context"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/projection"
)

// Outcome is the tri-state answer a bind needs.
type Outcome int

const (
	// Rejected means the provider answered, and the answer was no.
	Rejected Outcome = iota
	// Verified means the provider answered yes.
	Verified
	// Unavailable means the provider did not answer. The caller must NOT report
	// this to the client as invalid credentials.
	Unavailable
)

func (o Outcome) String() string {
	switch o {
	case Verified:
		return "verified"
	case Rejected:
		return "rejected"
	default:
		return "unavailable"
	}
}

// MaxTimeout is the longest any verifier is given, whatever it asks for.
//
// The numbers, because they have to agree across three files: Stalwart's LDAP
// Directory gives up on authd at 15s (`timeout` in
// infra/k8s/i10/stalwart/config/plan.ndjson). authd's own operation deadline is
// MaxTimeout plus two seconds - room for the projection lookup, the budget
// reserve and release - so it always answers, `unavailable`, before Stalwart
// stops listening. Okta's password grant measured one to seven seconds; twelve
// leaves it headroom without letting a stuck provider eat the whole window.
const MaxTimeout = 12 * time.Second

// Budget caps how many failed passwords may be forwarded to a provider for one
// account inside a window.
//
// It exists for providers that lock the REAL account after a few failures (Okta
// does, at about ten). i10 must never be what spends those failures, so the
// bind path counts the ones it forwards and stops forwarding while the budget is
// spent. See the failure-budget block in ldapsrv.handleBind.
type Budget struct {
	Max    int
	Window time.Duration
}

// Verifier checks one password against one provider.
type Verifier interface {
	// Name identifies the provider and is stable across releases: it is mixed
	// into every cached credential, so a workspace that later switches provider
	// can never be answered from an entry another provider minted.
	Name() string

	// Timeout bounds one Verify call. The bind path sizes its own deadline from
	// this, so it must be the real ceiling - a verifier that outlives it has its
	// answer thrown away.
	Timeout() time.Duration

	// Budget is the failure budget, or nil when the provider has none. Clerk has
	// none: its verify_password endpoint was measured not to feed lockout, so a
	// mail client retrying a stale password cannot lock anyone out.
	Budget() *Budget

	// Verify checks the password for this account. The password is never logged,
	// never wrapped into an error, and never returned; errors are safe to log
	// verbatim.
	Verify(ctx context.Context, account *projection.Account, password string) (Outcome, error)
}

// Resolver picks the verifier for an account. A bind asks it once, after the
// account is known to be active and before anything is cached, so which
// provider answers is decided in exactly one place.
//
// An error means "could not decide" - a workspace lookup that failed, say - and
// the bind reports it as unavailable. It is never evidence about the password.
type Resolver interface {
	Resolve(ctx context.Context, account *projection.Account) (Verifier, error)
}

// Fixed resolves every account to the same verifier.
func Fixed(v Verifier) Resolver { return fixed{v} }

type fixed struct{ v Verifier }

func (f fixed) Resolve(context.Context, *projection.Account) (Verifier, error) { return f.v, nil }

// Slot is one reserved forward against a Budget. Release hands back exactly the
// slot Reserve gave, in exactly the window it came from.
type Slot struct{ Window time.Time }

// BudgetStore counts forwarded failures across every authd, because both
// Stalwart pods run one and a count kept per pod would let each forward its own
// share.
type BudgetStore interface {
	// Reserve takes a slot if the budget has one. ok=false with a nil error
	// means the budget is spent. An error means the store could not be reached,
	// and the caller must not forward.
	Reserve(ctx context.Context, userID string, b Budget) (slot Slot, ok bool, err error)

	// Release gives a slot back. A slot from a window that has since rolled over
	// is a no-op: the new window never counted it.
	Release(ctx context.Context, userID string, slot Slot) error
}
