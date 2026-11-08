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

// OIDCMaxCacheTTL is how long an OIDC-lane success may stand in for asking the
// provider again. It is the ONE constant for every preset.
//
// ⚠ FIFTEEN MINUTES IS A STOPGAP, NOT A DESIGN. The long credential cache is safe
// only where a password change reaches authd (verify.CacheLimit), and no OIDC
// provider here sends one: for Okta that would be an event hook raising
// `credential_epoch` on a password change, a suspension, a lock or a deprovision
// (issue #383, B9 step 2b), and nothing generic exists for the others. Until a
// connection's hook is built and verified, nothing tells authd, so this caps how
// long a changed or revoked password keeps opening mail. 2b's verified hook is
// what may lift it for an Okta connection, and only for one.
const OIDCMaxCacheTTL = 15 * time.Minute

// FailureBudget is how many wrong passwords authd forwards to a company's
// identity provider for one account in one window.
//
// ⚠ A COMPANY'S DIRECTORY LOCKS THE REAL ACCOUNT, and so does its identity
// provider. Active Directory's default is a handful of failures, Okta's is ten,
// and a locked account answers exactly like a wrong password (Okta, Keycloak and
// PingFederate all do). A mail client retrying a stale saved password every few
// seconds would lock the person out of their own SSO, so authd counts what it
// forwards (internal/budgetstore) and answers busy once the budget is spent.
// Three in fifteen minutes leaves room for a person's own typos, and well under
// any of those thresholds.
var FailureBudget = verify.Budget{Max: 3, Window: 15 * time.Minute}

// Directory answers one managed account's bind through its connection's lane.
// *Service is the production one; tests put a script in its place.
type Directory interface {
	Bind(ctx context.Context, connectionID, email, password string) Result
}

var _ Directory = (*Service)(nil)

// Verifier checks a managed account's password against its company's identity
// provider: its LDAP directory or its OIDC provider, whichever its connection
// runs. It is the "passthrough:<connection>" verify.Verifier.
//
// ⚠ THE LANE IS LEARNED INSIDE Verify, not by the resolver. Which lane a
// connection runs is the API's answer, and the resolver may do no I/O, so the
// name cannot carry it. What keeps the lanes apart in the credential cache
// instead: the LDAP lane never stores a success (MaxCacheTTL is 0 for it), so
// no entry it minted can answer for an OIDC account; and an OIDC success is
// cached for OIDCMaxCacheTTL at most.
//
// ⚠ ONE VERIFIER PER BIND, never shared: `lane` is written by Verify and read by
// MaxCacheTTL straight after it, on the same goroutine. ManagedResolver.Resolve
// builds a new one every time.
//
// ⚠ THE TWO ANSWERS THAT ARE NOT "WRONG PASSWORD". The provider not answering,
// the path to it being blocked or its TLS failing, our service account or the
// org's setup being refused and the settings API being down are all Unavailable,
// and the bind reports them as such. Only the provider's own no is Rejected. See
// Service.Bind for the walk, and Result for the reason codes.
type Verifier struct {
	svc        Directory
	connection string
	log        *slog.Logger
	lane       string
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

// MaxCacheTTL implements verify.CacheLimit, for the lane Verify just used.
//
// ⚠ NOTHING TELLS authd THAT A COMPANY'S DIRECTORY CHANGED A PASSWORD. There is
// no event hook into Active Directory, so a cached success would keep the old
// password opening mail for the whole credential-cache TTL. Every LDAP bind asks
// the directory; the flight still collapses a client's simultaneous connections
// into one bind, and a directory bind costs milliseconds, not Okta's seconds.
//
// An OIDC provider's passwords can be cached, briefly: see OIDCMaxCacheTTL. A
// provider's call takes one to seven seconds and a mail client reconnects all
// day. Anything else, including a lane that was never reached, is not cached.
func (v *Verifier) MaxCacheTTL() time.Duration {
	if v.lane == LaneOIDC {
		return OIDCMaxCacheTTL
	}
	return 0
}

var _ verify.CacheLimit = (*Verifier)(nil)

// Verify implements verify.Verifier. The password reaches nothing but the
// provider's own check; the error is a reason code, never the password, a
// secret, a token or a DN.
func (v *Verifier) Verify(ctx context.Context, account *projection.Account, password string) (verify.Outcome, error) {
	res := v.svc.Bind(ctx, v.connection, account.Email, password)
	v.lane = res.Lane
	switch res.Outcome {
	case Verified:
		return verify.Verified, nil
	case Rejected:
		// The reason is what tells a wrong password from an address the
		// directory does not know, or from a provider that still wants a second
		// factor (oidc_mfa_required), so it is logged here; the bind logs only
		// that the verifier rejected.
		v.log.Info("pass-through rejected", "reason", res.Reason, "lane", res.Lane, "preset", res.Preset, "uid", account.ClerkUserID, "connection", v.connection)
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
	// ReasonSSORequired is an account that is NOT managed but whose address is on a
	// domain an active connection requires SSO for: its Clerk password is not
	// accepted any more, and it becomes managed (and gets its company's password)
	// by signing in through SSO. Not the people the SSO layer exempts (owners and
	// admins while the owner exemption is on, a connection's bypass list).
	ReasonSSORequired = "sso_required"
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
// ⚠ NOR IS AN ACCOUNT THAT SSO IS REQUIRED FOR, WHILE IT IS NOT MANAGED YET. The
// owner turned "required" on for its domain, so a Clerk password may no longer
// open its mail. It is refused here, ahead of the credential cache: the refusal's
// name is mixed into the cache key, so a password cached under Unmanaged's name
// can never match it. That is what makes the switch take effect on the next bind
// on every pod, not after the cache's two hours.
//
// ⚠ EXCEPT THE PEOPLE SSO ITSELF EXEMPTS (`SSOExempt`): owners and admins while
// the owner exemption is on, and whoever the connection's bypass list names. They
// keep their Clerk password for mail, as they keep their way into the console,
// and are answered by Unmanaged like an account nothing is required of. Taking
// somebody out of the exemption is a revocation and works the same way as turning
// "required" on: the next bind resolves them to the refusal, whose name differs
// from Unmanaged's, so the password Unmanaged cached for them stops matching with
// no query of its own.
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
	case !account.Managed && account.SSORequired && !account.SSOExempt:
		return refusal{ReasonSSORequired}, nil
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
