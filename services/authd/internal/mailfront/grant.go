package mailfront

import (
	"bytes"
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

	// DeviceID is the mail device the session signed in with (#383), "" for a
	// password session: the device the bind token covered, read from the
	// forwarded password with devicecode.DeviceID, the same parser authd uses,
	// or resolved by certificate key for AUTHENTICATE EXTERNAL.
	// The re-check closes the session when that device's row is gone or no
	// longer matches (gate.DeviceRefusal).
	DeviceID string

	// CertKey is SHA-256 of the SubjectPublicKeyInfo that a Mac session stands
	// on (#383 PR 3): the verified client certificate's key for IMAP (external
	// or a Mac's device_code with a certificate), or the row's key at admission
	// for a Mac's SMTP session and for a Mac code-only install-grace session
	// (IMAP or SMTP). Nil for password sessions and iPhone/iPad sessions.
	CertKey []byte

	// Until is when the session is closed whatever the row says: a Mac
	// certificate session at CertSessionMaxAge (or the time remaining in the
	// 10-minute install grace for a Mac code-only grace session), an iPhone/iPad
	// device session at DeviceMaxAge, a session on a pass-through lane at
	// PassthroughMaxAge; zero for a Clerk password session, whose changes reach
	// the row.
	Until time.Time
}

// sessionEnds is when a session that signs in now ends whatever its row says,
// by kind (Grant.Until).
type sessionEnds struct {
	passthrough, device, cert time.Time
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

// DeviceMaxAge and DeviceMaxAgeJitter bound a device session: it is closed
// between DeviceMaxAge and DeviceMaxAge plus DeviceMaxAgeJitter after sign-in,
// at random, and the client signs in again with the code it holds.
//
// ⚠ SO A DEVICE IN USE IS NEVER PRUNED AS IDLE. A device's `last_used_at` moves
// only at a bind (at most once a day), and the prune deletes a used code 90 days
// after it. An iPhone in push holds one IMAP session for as long as the network
// lets it; without a maximum age it could hold one past 90 days, and its device
// would be deleted under it. Re-binding daily keeps the stamp fresh. Not the
// revocation bound: a revoke is a DELETE, which the next poll sees.
const (
	DeviceMaxAge       = 24 * time.Hour
	DeviceMaxAgeJitter = time.Hour

	// CertSessionMaxAge and CertSessionMaxAgeJitter bound a Mac session (both
	// IMAP with a certificate and SMTP under a Mac's code): 60 minutes plus up
	// to 5 minutes of jitter, so an open certificate session always re-binds
	// inside authd's 75-minute liveness window, and a Mac SMTP session never
	// relies on Stalwart's maxDuration. A Mac code-only install-grace session
	// (IMAP or SMTP) reuses ReasonCertMaxAge with a shorter cap equal to the
	// time remaining in the 10-minute grace window (graceDeadline).
	CertSessionMaxAge       = 60 * time.Minute
	CertSessionMaxAgeJitter = 5 * time.Minute
)

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
	ReasonDeviceMaxAge   = "device_max_age"
	ReasonCertMaxAge     = "cert_session_max_age"
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
// deviceID is the device the forwarded password named ("" for none), and ends
// is when the session must end if it is a device session or one on a
// pass-through lane; neither applies to a Clerk password session.
func admit(acct *projection.Account, deviceID string, certKey []byte, lookupErr error, ends sessionEnds) (Grant, string) {
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
		DeviceID:  deviceID,
		CertKey:   bytes.Clone(certKey),
	}
	switch {
	case len(g.CertKey) > 0:
		g.Until = ends.cert
	case deviceID != "":
		// Not a pass-through session even on a managed account: the code is
		// i10's, checked by authd, and its revocations reach the row.
		g.Until = ends.device
	case !g.Route.Clerk():
		g.Until = ends.passthrough
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
//     connection's OIDC settings changing);
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
//
// And for a device session, the device's row (gate.DeviceRefusal, the bind's
// own rule): deleted, or minted for another person, address or workspace than
// the account has now. A device session closed for the epoch or clerk_updated_at
// reconnects with the code it holds.
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
	if g.DeviceID != "" {
		return gate.DeviceRefusal(deviceIn(now, g.DeviceID), now, g.CertKey)
	}
	return ""
}

// deviceIn is the device id among the rows read with a, or nil when it is not
// there (deleted, or now another account's).
func deviceIn(a *projection.Account, id string) *projection.Device {
	for i := range a.Devices {
		if a.Devices[i].ID == id {
			return &a.Devices[i]
		}
	}
	return nil
}

// expired reports whether a session is past its Until at the sweep's clock. It
// reads no row, so it holds while the projection cannot be read.
func (g Grant) expired(at time.Time) bool {
	return !g.Until.IsZero() && !at.Before(g.Until)
}

// maxAgeReason is why an expired session is closed.
func (g Grant) maxAgeReason() string {
	switch {
	case len(g.CertKey) > 0:
		return ReasonCertMaxAge
	case g.DeviceID != "":
		return ReasonDeviceMaxAge
	default:
		return ReasonMaxAge
	}
}

func sameInstant(a, b *time.Time) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return a.Equal(*b)
}

// graceDeadline caps a Mac code-only install-grace session (IMAP or SMTP) to
// the time remaining in its grace window, clamped to
// [0, projection.MacInstallGraceDuration] so it can never outlive the grace.
func graceDeadline(now time.Time, left time.Duration) time.Time {
	if left < 0 {
		left = 0
	}
	if left > projection.MacInstallGraceDuration {
		left = projection.MacInstallGraceDuration
	}
	return now.Add(left)
}
