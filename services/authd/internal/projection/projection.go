// Package projection reads the local mirror of Clerk's users.
//
// Every LDAP search is answered from here and costs zero Clerk calls. Only a
// bind reaches Clerk, and only after this package has resolved the DN.
package projection

import (
	"context"
	"time"
)

// Account is one mailbox as authd knows it.
type Account struct {
	ClerkUserID    string
	Email          string
	DisplayName    string
	Description    string
	Active         bool
	ClerkUpdatedAt *time.Time

	// CredentialEpoch is `authd.accounts.credential_epoch`, raised by the API to
	// invalidate every cached verification for this person on every pod. Only
	// ever compared for equality; see credcache.
	CredentialEpoch int64

	// Managed is true when an SSO connection controls this account (#344).
	// ⚠ A MANAGED ACCOUNT IS NEVER SENT TO CLERK'S verify_password: its password
	// belongs to the company's directory, and the resolver answers it with the
	// pass-through verifier or a refusal, never Clerk. ManagedConnection names
	// the connection whose pass-through answers its binds; it is empty when the
	// connection is gone, which authd refuses rather than falling back to Clerk.
	Managed           bool
	ManagedConnection string

	// Suspended is true when a company's directory switched the person off
	// (#344): the mailbox still exists and still receives mail, so searches
	// return it, but NO BIND succeeds. It is not Active=false, which would make
	// the account invisible and stop delivery.
	Suspended bool

	// PaymentHold is true while the account's workspace has no paid plan: the
	// mailbox keeps receiving mail and NO BIND succeeds, until payment clears it
	// (`authd.accounts.payment_hold_at`). Like Suspended it is read from the same
	// row as the bind and acted on ahead of the credential cache.
	PaymentHold bool

	// Banned and Locked are Clerk's own flags for the user, projected by the
	// webhook. ⚠ CLERK'S verify_password ANSWERS YES FOR BOTH (probed against its
	// dev instance 2026-11-07, see `authd.accounts.banned` in apps/api/src/db/
	// schema.ts), so a bind refuses them itself and never lets the answer, or a
	// cached one, decide. Locked is already false once the lockout has run out:
	// Clerk says nothing when it does, so the query reads the clock.
	Banned bool
	Locked bool

	// DomainNotHosted is true when the workspace no longer hosts mailboxes on the
	// account's domain: hosting was switched off, the workspace lost the name to
	// another that proved it, or its proof lapsed (#406). Read as
	// `core.mailbox_domain_refused(tenant_id, domain)` in the SAME query as the
	// account, so it is never older than the row the bind holds.
	//
	// ⚠ A DOMAIN-LEVEL GATE, NOT A STAMP ON THE MAILBOX. Nothing is written to
	// `authd.accounts` when hosting goes off, so `suspended_at` stays what an admin
	// set and switching hosting back on reopens every login that was not
	// suspended by hand. Like Suspended the mailbox still resolves as a recipient
	// (Stalwart's own Domain object decides whether mail is accepted); only the
	// BIND is refused, ahead of the credential cache.
	DomainNotHosted bool

	// SSORequired is true when the account's address is on a domain an active
	// connection REQUIRES SSO for (`authd.required_domains`). A managed account
	// is answered by its company's directory whatever this says; an account that
	// is not managed has no password to ask for, and the resolver refuses it
	// rather than asking Clerk.
	SSORequired bool

	// SSOExempt is true when that requirement does not apply to this person: an
	// owner or admin while the workspace's owner exemption is on, or somebody on
	// the bypass list of the connection that requires SSO for their domain
	// (`authd.required_exempt`). The owner's decision is that they keep their Clerk
	// password for mail as they keep their way into the console.
	//
	// ⚠ ONLY MEANINGFUL WITH SSORequired, AND ONLY EVER READ FROM THE SAME QUERY AS
	// IT. It is true only while the account's domain is required, for the
	// connection that requires it, so removing a person from the exemption makes the
	// very next bind read false and the resolver refuse them again, ahead of the
	// credential cache.
	SSOExempt bool

	Aliases  []string
	MemberOf []string // group names, not DNs; the caller renders DNs
}

// Group is a mail-enabled group.
type Group struct {
	Name        string
	Email       string
	Description string
	Members     []string // clerk user ids
}

// Store is the read surface authd needs. It is an interface so the LDAP
// handlers can be tested without a database.
//
// Every method returns ACTIVE accounts only. Inactive accounts are invisible by
// construction rather than by a filter the caller has to remember to apply -
// an unpaid or deprovisioned account must never resolve as a recipient, and
// that guarantee belongs at the bottom of the stack, not the top.
type Store interface {
	// AccountsByAddress resolves accounts whose primary address or any alias
	// matches one of the given addresses. Matching is case-insensitive.
	AccountsByAddress(ctx context.Context, addresses []string) ([]Account, error)

	// AccountByUID resolves a single account by its Clerk user id. It returns
	// (nil, nil) when there is no such active account.
	AccountByUID(ctx context.Context, clerkUserID string) (*Account, error)

	// GroupsByAddress resolves mail-enabled groups by address.
	GroupsByAddress(ctx context.Context, addresses []string) ([]Group, error)

	// GroupsForMember lists the groups an account belongs to.
	GroupsForMember(ctx context.Context, clerkUserID string) ([]Group, error)

	// GroupsByName resolves groups by their directory name, the cn of their DN.
	GroupsByName(ctx context.Context, names []string) ([]Group, error)
}
