package mailfront

import (
	"time"

	"github.com/i10-tech/i10/services/authd/internal/gate"
	"github.com/i10-tech/i10/services/authd/internal/projection"
)

// Grant is what one connection's sign-in was accepted under: the account, and
// the values authd's credential cache is keyed on. When any of them moves, a
// bind made now would not be answered from the cache that admitted this one,
// so the connection is closed.
type Grant struct {
	AccountID string
	// Email is the primary address the row had at sign-in, and Domain its mail
	// domain as the gate's SQL derived it (projection.Account.MailDomain): the key
	// a `domain` change in the access-change log names this connection by.
	Email     string
	Domain    string
	Epoch     int64
	UpdatedAt *time.Time
	Route     gate.Route

	// Until is when a session on a pass-through lane is closed whatever the row
	// says (PassthroughMaxAge); zero for Clerk, whose changes reach the row.
	Until time.Time
}

// DefaultPassthroughMaxAge is how long a session signed in through a company's
// own directory or identity provider stays open before the front closes it and
// the client signs in again.
//
// ⚠ THE BOUND FOR A REVOCATION i10 CANNOT SEE. A person disabled or given a new
// password in the company's Active Directory, or at an OIDC provider that sends
// neither Universal Logout nor SCIM, never reaches the row, so nothing in the
// sweep can close their open session. Closed at this age, the client reconnects
// with the password it saved, and the directory is asked again. Fifteen minutes
// is the OIDC lane's success cache (passthrough.OIDCMaxCacheTTL), so the two
// lanes have one bound. A Clerk-routed session is not affected: a Clerk change
// moves clerk_updated_at, which the sweep already watches.
const DefaultPassthroughMaxAge = 15 * time.Minute

// Reasons a connection is closed. Stable log reason codes.
const (
	ReasonLookupFailed   = "lookup_failed"
	ReasonUnattributed   = "unattributed"
	ReasonAccountGone    = "account_gone"
	ReasonEpochMoved     = "credential_epoch_moved"
	ReasonClerkMoved     = "clerk_updated_at_moved"
	ReasonRouteChanged   = "verifier_changed"
	ReasonAddressChanged = "address_changed"
	ReasonSecondSignIn   = "second_sign_in"
	ReasonUnattribAuth   = "unattributed_sign_in"
	ReasonUnexpectedTag  = "unexpected_tagged_answer"
	ReasonAmbiguous      = "ambiguous_command"
	ReasonShutdown       = "shutdown"
	ReasonPreAuthLimits  = "preauth_limit"
	ReasonMaxAge         = "passthrough_max_age"
)

// admit decides whether an authenticated session may continue, from the row
// read BEFORE the sign-in reached Stalwart.
//
// ⚠ THE ROW IS READ BEFORE THE CREDENTIALS ARE FORWARDED, NOT AFTER THE OK. A
// revocation that lands before the read is seen by authd too and the sign-in
// fails; one that lands after it changes the row away from this Grant, and the
// next sweep closes the connection. Reading after the OK would record the new
// values and miss exactly that revocation.
//
// ⚠ NO ROW, NO SESSION. A login the projection does not know (Stalwart's own
// recovery admin, an address that is not an account) or a lookup that failed
// cannot be attributed, and an authenticated session the front cannot attribute
// is one it could never close on a revocation. It is closed now. A failed lookup
// also means authd's own lookup is failing, so the sign-in is refused anyway.
//
// until is when the session must end if it signed in through a pass-through
// lane; it is ignored for a Clerk-routed one.
func admit(acct *projection.Account, lookupErr error, until time.Time) (Grant, string) {
	switch {
	case lookupErr != nil:
		return Grant{}, ReasonLookupFailed
	case acct == nil:
		return Grant{}, ReasonUnattributed
	}
	if reason := gate.Refusal(acct); reason != "" {
		return Grant{}, reason
	}
	g := Grant{
		AccountID: acct.ClerkUserID,
		Email:     acct.Email,
		Domain:    acct.MailDomain,
		Epoch:     acct.CredentialEpoch,
		UpdatedAt: acct.ClerkUpdatedAt,
		Route:     gate.RouteOf(acct),
	}
	if !g.Route.Clerk() {
		g.Until = until
	}
	return g, ""
}

// revoked names why the account as it is NOW no longer supports this grant,
// or "". now is nil when the projection has no active row for the account.
//
// ⚠ THE SAME GATE AS A BIND (internal/gate), so whatever authd would refuse at
// the next sign-in closes the connection that is already open. On top of it,
// the three things the credential cache keys on, because a bind would no longer
// be answered from the entry that admitted this session:
//
//   - credential_epoch: the API's general revocation (Okta Universal Logout, a
//     connection's OIDC settings changing, and from later PRs a device revoked);
//   - clerk_updated_at: any change in Clerk, a password change included. It fires
//     on every profile change, so a renamed person reconnects once; the client
//     does that with the password it already has;
//   - the route: Clerk, or which company directory, answers for the password.
//
// And the primary address: it is the login the session signed in with, and its
// domain is how a `domain` change finds this connection (Sweeper.Poll), so a
// session whose address moved is closed rather than watched under a domain it
// is no longer on. The client's saved login is the old address, which no longer
// signs in either, so this only brings forward what its next sign-in would meet.
func (g Grant) revoked(now *projection.Account) string {
	if now == nil {
		return ReasonAccountGone
	}
	if reason := gate.Refusal(now); reason != "" {
		return reason
	}
	switch {
	case now.CredentialEpoch != g.Epoch:
		return ReasonEpochMoved
	case !sameInstant(now.ClerkUpdatedAt, g.UpdatedAt):
		return ReasonClerkMoved
	case gate.RouteOf(now) != g.Route:
		return ReasonRouteChanged
	case now.Email != g.Email:
		return ReasonAddressChanged
	}
	return ""
}

// expired reports whether a pass-through session is past its Until at the
// sweep's clock: for what the row can never show (DefaultPassthroughMaxAge). It
// reads no row, so it holds while the projection cannot be read.
func (g Grant) expired(at time.Time) bool {
	return !g.Until.IsZero() && !at.Before(g.Until)
}

func sameInstant(a, b *time.Time) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return a.Equal(*b)
}
