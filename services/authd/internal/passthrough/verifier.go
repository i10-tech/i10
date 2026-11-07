package passthrough

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/projection"
	"github.com/i10-tech/i10/services/authd/internal/verify"
)

// NamePrefix starts every pass-through verifier's name. The connection id
// follows it, so the name says WHICH directory vouched for a password.
//
// ⚠ THE NAME IS MIXED INTO EVERY CACHED CREDENTIAL (internal/credcache), and
// that is what keeps the cache honest here. An account that moves to another
// connection, or is released back to Clerk, stops matching what the old
// directory vouched for, with no query of its own.
const NamePrefix = "passthrough:"

// VerifyTimeout is the longest one verification may take: the settings fetch
// and the whole walk of the company's directory share it. It is below
// verify.MaxTimeout, so the bind is answered before Stalwart gives up, and the
// Binder's own TotalTimeout is set from it in main.
const VerifyTimeout = 10 * time.Second

// FailureBudget is how many wrong passwords authd forwards to a company's
// directory for one account in one window.
//
// ⚠ A COMPANY'S DIRECTORY LOCKS THE REAL ACCOUNT. Active Directory's default is
// a handful of failures, and a locked account answers exactly like a wrong
// password. A mail client retrying a stale saved password every few seconds
// would lock the person out of their own SSO, so authd counts what it forwards
// (internal/budgetstore) and answers busy once the budget is spent. Three in
// fifteen minutes leaves room for a person's own typos.
var FailureBudget = verify.Budget{Max: 3, Window: 15 * time.Minute}

// Directory answers one managed account's bind through its connection's
// directory. *Service is the production one; tests put a script in its place.
type Directory interface {
	Bind(ctx context.Context, connectionID, email, password string) Result
}

var _ Directory = (*Service)(nil)

// Verifier checks a managed account's password against its company's directory.
// It is the "passthrough:<connection>" verify.Verifier.
//
// ⚠ THE TWO ANSWERS THAT ARE NOT "WRONG PASSWORD". The directory not answering,
// the path to it being blocked or its TLS failing, our service account being
// refused and the settings API being down are all Unavailable, and the bind
// reports them as such. Only the directory's own no is Rejected. See Service.Bind
// for the walk, and Result for the reason codes.
type Verifier struct {
	svc        Directory
	connection string
	log        *slog.Logger
}

// Name implements verify.Verifier.
func (v *Verifier) Name() string { return NamePrefix + v.connection }

// Timeout implements verify.Verifier.
func (v *Verifier) Timeout() time.Duration { return VerifyTimeout }

// Budget implements verify.Verifier.
func (v *Verifier) Budget() *verify.Budget {
	b := FailureBudget
	return &b
}

// MaxCacheTTL implements verify.CacheLimit: a directory's answer is never
// cached.
//
// ⚠ NOTHING TELLS authd THAT A COMPANY'S DIRECTORY CHANGED A PASSWORD. There is
// no event hook into Active Directory, so a cached success would keep the old
// password opening mail for the whole credential-cache TTL. Every bind asks the
// directory; the flight still collapses a client's simultaneous connections
// into one bind, and a directory bind costs milliseconds, not Okta's seconds.
func (*Verifier) MaxCacheTTL() time.Duration { return 0 }

var _ verify.CacheLimit = (*Verifier)(nil)

// Verify implements verify.Verifier. The password reaches nothing but the
// directory's own bind; the error is a reason code, never the password, a
// secret or a DN.
func (v *Verifier) Verify(ctx context.Context, account *projection.Account, password string) (verify.Outcome, error) {
	res := v.svc.Bind(ctx, v.connection, account.Email, password)
	switch res.Outcome {
	case Verified:
		return verify.Verified, nil
	case Rejected:
		// The reason is what tells a wrong password from an address the
		// directory does not know, so it is logged here; the bind logs only that
		// the verifier rejected.
		v.log.Info("pass-through rejected", "reason", res.Reason, "uid", account.ClerkUserID, "connection", v.connection)
		return verify.Rejected, nil
	default:
		return verify.Unavailable, fmt.Errorf("passthrough: %s", res.Reason)
	}
}

var _ verify.Verifier = (*Verifier)(nil)

// Reasons a managed account has nowhere to be asked, and is refused.
const (
	ReasonManagedNoConnection = "managed_no_connection"
	ReasonNotConfigured       = "passthrough_not_configured"
)

// refusal is the verifier of a managed account that has no directory to ask. It
// answers Rejected without asking anyone, which is the whole point: the
// alternative to a directory is not Clerk.
type refusal struct{ reason string }

func (r refusal) Name() string         { return r.reason }
func (refusal) Timeout() time.Duration { return VerifyTimeout }
func (refusal) Budget() *verify.Budget { return nil }
func (refusal) Verify(context.Context, *projection.Account, string) (verify.Outcome, error) {
	return verify.Rejected, nil
}

var _ verify.Verifier = refusal{}

// ManagedResolver picks the verifier for an account: the company's directory for an
// account an SSO connection manages, and Unmanaged (Clerk) for the rest.
//
// ⚠ A MANAGED ACCOUNT IS NEVER ASKED OF UNMANAGED. Its password belongs to the
// company, so Clerk would answer for a credential nobody keeps there. An
// account managed by a connection that is gone, or with pass-through not
// configured on this authd, is refused (49), as an account whose connection has
// pass-through switched off is (that is learned from the settings API, in
// Verify). None of it falls back.
//
// The resolver does no I/O. Whether the connection has pass-through settings,
// and what they are, is fetched inside Verify, where the verifier's own timeout
// bounds it.
type ManagedResolver struct {
	// Unmanaged answers every account no connection manages.
	Unmanaged verify.Verifier
	// Directory is nil when pass-through is not configured.
	//
	// ⚠ A TYPED NIL IS NOT A NIL INTERFACE: leave this a true nil (do not assign a
	// nil *Service to it), or managed accounts are not refused but panic the bind.
	Directory Directory
	Log       *slog.Logger
}

// Resolve implements verify.Resolver.
func (r *ManagedResolver) Resolve(_ context.Context, account *projection.Account) (verify.Verifier, error) {
	switch {
	case !account.Managed:
		return r.Unmanaged, nil
	case account.ManagedConnection == "":
		return refusal{ReasonManagedNoConnection}, nil
	case r.Directory == nil:
		return refusal{ReasonNotConfigured}, nil
	}
	log := r.Log
	if log == nil {
		log = slog.Default()
	}
	return &Verifier{svc: r.Directory, connection: account.ManagedConnection, log: log}, nil
}

var _ verify.Resolver = (*ManagedResolver)(nil)
