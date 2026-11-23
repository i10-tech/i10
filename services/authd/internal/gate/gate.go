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
// Everything here is pure: no I/O, no clock. The row already carries every
// input, read in one query (projection.accountColumns), including the ones
// that are not columns of authd.accounts: the required SSO domains, who is
// exempt from them, and whether the account's domain still hosts mail.
//
// What it cannot decide, by design, is whether a managed account's connection
// has pass-through switched on: that is the API's answer, fetched inside the
// pass-through verifier with a secret only authd holds. See Route.
package gate

import "github.com/i10-tech/i10/services/authd/internal/projection"

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
)

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
// yet, unless SSO itself exempts it (SSOExempt).
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
