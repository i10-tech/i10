// Package gate decides, from an account's projection row alone, whether that
// account may sign in to mail and who answers for its password.
//
// ⚠ IT IS THE ONE COPY OF THAT DECISION. authd's bind (ldapsrv) refuses a login
// with it before the credential cache is read, the resolver
// (passthrough.ManagedResolver) routes with it, and the mail front
// (internal/mailfront) uses it to close connections that signed in before the
// row changed. A rule added here reaches all three; a rule added anywhere else
// reaches one of them, which is how an open session outlives a revocation.
//
// ⚠ A NEW INPUT ALSO NEEDS A TRIGGER. The mail front re-checks an open
// connection when the access-change log names it (`authd.access_changes`,
// written by a trigger on every table this decision reads), and every
// connection only once a minute otherwise. A rule that reads a new table or
// column without a trigger that logs its changes closes open sessions a minute
// late. TestEveryTableTheGateReadsLogsItsChanges (internal/projection) fails for
// a table without the triggers, and every input has a row in gatePaths
// (internal/mailfront paths_db_test.go), whose test commits each change and
// checks that the next poll closes the connection.
//
// Everything here is pure: no I/O, no clock. The row already carries every
// input, read in one query (projection.accountColumns), including the ones
// that are not columns of authd.accounts: the required SSO domains, who is
// exempt from them, and whether the account's domain still hosts mail.
//
// What it cannot decide, by design, is whether a managed account's connection
// has pass-through switched on: that is the API's answer, fetched inside the
// pass-through verifier with a secret only authd holds. See Route.
package gate

import (
	"crypto/hmac"

	"github.com/i10-tech/i10/services/authd/internal/projection"
)

// Reasons a login is refused. They are log reason codes, so they are stable.
const (
	NoActiveAccount  = "no_active_account"
	MailboxSuspended = "mailbox_suspended"
	MailboxDeleting  = "mailbox_deleting"
	PaymentHold      = "payment_hold"
	DomainNotHosted  = "domain_not_hosted"
	AccountBanned    = "account_banned"
	AccountLocked    = "account_locked"

	// SSORequired is an account that is NOT managed but whose address is on a
	// domain an active connection requires SSO for: its Clerk password is not
	// accepted any more, and it becomes managed (and gets its company's password)
	// by signing in through SSO. Not the people the SSO layer exempts (owners and
	// admins while the owner exemption is on, a connection's bypass list).
	SSORequired = "sso_required"

	// ManagedNoConnection is an account an SSO connection manages whose
	// connection is gone. It is refused rather than sent to Clerk.
	ManagedNoConnection = "managed_no_connection"

	// ConnectionInactive is an account an SSO connection manages while that
	// connection is not active (disabled, or back to draft or testing). Its
	// company's password lane has nothing to ask then either; the rule is here
	// for the device lane, which never asks the API, so a disabled connection
	// holds its people's device codes until it is active again.
	ConnectionInactive = "connection_inactive"
)

// Reasons a device code is refused, or a device session closed, because its
// row no longer matches the account (DeviceRefusal).
const (
	// DeviceRevoked: the device row is gone (a revoke, the account deleted, the
	// prune), or now belongs to another account.
	DeviceRevoked = "device_revoked"
	// DeviceMismatch: the row is there but was minted for another person,
	// address or workspace than the account has now.
	DeviceMismatch = "device_mismatch"
	// DevicePlatformRefused: a platform this build does not sign in.
	DevicePlatformRefused = "device_platform_refused"
	// DeviceCertMissing: a Mac whose row has no certificate key bound (never
	// bound, or cleared by `unbind-key` or a re-enrollment). Even during the
	// initial install grace a Mac row must have its ACME key bound, so clearing
	// the key ends every session of it, IMAP and SMTP included.
	DeviceCertMissing = "device_cert_missing"
	// DeviceKeyChanged: the certificate key the session or bind stands on is not
	// the row's key now (rebound to another key), or a session that stands on a
	// key meets a row that is not a Mac, or a Mac row meets a session that stands
	// on none.
	DeviceKeyChanged = "device_key_changed"
)

// Macos is the platform whose devices sign in with a certificate.
const Macos = "macos"

// RowRefusal names why the account row turns this login away before a verifier
// is even chosen, or "". A nil account is one the projection does not have as
// active: no such account, or it is inactive (unpaid, deprovisioned).
//
// ⚠ EACH OF THESE COMES BEFORE THE CREDENTIAL CACHE in a bind, so a password that
// was right yesterday, cached or asked of a company's directory, cannot open the
// mailbox. Each is read from the same row as the account, so it takes effect on
// every pod at once:
//
//   - a suspension (#344): a company's directory, an owner, a member leaving;
//     the mailbox still receives.
//   - a deletion grace: an owner or admin deleted the mailbox, which still
//     receives until the purge; only a restore clears the column.
//   - a payment hold: the workspace has no paid plan; paying clears it.
//   - the domain no longer hosts mail (#406): switched off, lost to another
//     workspace's proof, or its proof lapsed.
//   - Clerk's ban or lock: neither moves `clerk_updated_at` the way a password
//     change does, and verify_password may still say yes for the user.
func RowRefusal(a *projection.Account) string {
	switch {
	case a == nil:
		return NoActiveAccount
	case a.Suspended:
		return MailboxSuspended
	case a.Deleting:
		return MailboxDeleting
	case a.PaymentHold:
		return PaymentHold
	case a.DomainNotHosted:
		return DomainNotHosted
	case a.Banned:
		return AccountBanned
	case a.Locked:
		return AccountLocked
	}
	return ""
}

// Route is who answers an account's password, as far as the row can say.
type Route struct {
	// Refusal is set when nobody may: the account has no password anywhere i10
	// will ask. It is a reason code.
	Refusal string
	// Connection is the SSO connection whose company directory answers a managed
	// account. Empty, with no Refusal, means Clerk.
	Connection string
}

// Clerk reports whether Clerk answers for the account.
func (r Route) Clerk() bool { return r.Refusal == "" && r.Connection == "" }

// RouteOf is the resolver's decision, which needs nothing but the row.
//
// ⚠ A MANAGED ACCOUNT IS NEVER ROUTED TO CLERK: its password belongs to its
// company. Nor is an account that SSO is required for while it is not managed
// yet, unless SSO itself exempts it (SSOExempt). A managed account whose
// connection is not active is refused outright (ConnectionInactive).
//
// Whether the connection has pass-through configured and switched on is NOT
// decided here. It is the API's answer, fetched by the pass-through verifier at
// bind time; the resolver also refuses a managed account when the authd it runs
// in has no pass-through configured at all. Neither is a fact about the row.
func RouteOf(a *projection.Account) Route {
	switch {
	case !a.Managed && a.SSORequired && !a.SSOExempt:
		return Route{Refusal: SSORequired}
	case !a.Managed:
		return Route{}
	case a.ManagedConnection == "":
		return Route{Refusal: ManagedNoConnection}
	case a.ConnectionInactive:
		return Route{Refusal: ConnectionInactive}
	}
	return Route{Connection: a.ManagedConnection}
}

// Refusal is everything the row alone refuses: RowRefusal, then RouteOf's
// refusal. "" means the row lets the login through to a verifier.
func Refusal(a *projection.Account) string {
	if r := RowRefusal(a); r != "" {
		return r
	}
	return RouteOf(a).Refusal
}

// DeviceRefusal names why a device row does not let its code sign in to the
// account the bind DN names (or keep a device session open), or "". d is nil
// when there is no such row. The account must already have passed Refusal.
//
// ⚠ ONE COPY, FOR THE BIND AND THE FRONT. authd's bind refuses a code with it
// before the hash is compared, and the mail front closes an open device session
// with it when the row changes, so a revocation that stops the next sign-in also
// ends the session that is open.
//
// ⚠ THE ROW MUST STILL BELONG TO THIS PERSON, THIS ADDRESS AND THIS WORKSPACE.
// The code names a row; the row names who it was minted for. A code of person
// A presented on person B's DN, a device minted for an address the account no
// longer has, or one minted in a workspace the mailbox has since left, is
// refused. The workspaces compare null-safely: i10's own mailboxes have none.
//
// ⚠ A MAC STANDS ON ITS CERTIFICATE KEY (#383 PR 3). held is the key the
// session or bind stands on: the key the front proved in the TLS handshake (an
// `external` sign-in, or a Mac's code on IMAP with a certificate), or the row's
// key at admission for a Mac's SMTP session and for a Mac code-only install-
// grace session (IMAP or SMTP, before its first certificate session is
// recorded); nil for an iPhone or iPad. A Mac row must have a key
// (DeviceCertMissing), and held must be exactly it; a row that is not a Mac
// must meet no key at all (DeviceKeyChanged). So binding a new key, clearing
// it, or a row that stops being a Mac ends every session that stood on the old
// one, through the same rule a bind uses. authd's bind names its refusals more
// finely (device_cert_required, device_cert_mismatch) from this reason.
//
// The clock rules (the first-use window, the idle limit) are not here: they are
// the bind's alone (projection.DeviceByID). An open session already passed them
// at its bind, and the first-use stamp is that bind's own write.
func DeviceRefusal(d *projection.Device, a *projection.Account, held []byte) string {
	switch {
	case d == nil:
		return DeviceRevoked
	case d.ClerkUserID != a.ClerkUserID, d.Email != a.Email, d.TenantID != a.TenantID:
		return DeviceMismatch
	case d.Platform == Macos:
		if len(d.CertKey) == 0 {
			return DeviceCertMissing
		}
		// Lengths first: hmac.Equal of two empty slices is true.
		if len(held) != len(d.CertKey) || !hmac.Equal(held, d.CertKey) {
			return DeviceKeyChanged
		}
	case d.Platform != "ios" && d.Platform != "ipados":
		return DevicePlatformRefused
	case len(held) != 0:
		return DeviceKeyChanged
	}
	return ""
}
