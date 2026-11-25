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

	// MailDomain is Email's mail domain exactly as the gate's SQL compares it,
	// `lower(split_part(email, '@', 2))`, computed by the server in the same query.
	MailDomain string

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

	// PassthroughVersion is ManagedConnection's `authd.passthrough_versions.
	// version`, 0 while it has no row. The API raises it in the same transaction
	// as any change to what the connection's pass-through answers, so a copy of
	// the settings older than it is fetched again before this bind uses it
	// (passthrough.Cache). Read in the bind's own query, so it costs no round trip.
	PassthroughVersion int64

	// ConnectionInactive is true only when ManagedConnection's row in
	// `authd.passthrough_versions` says `active = false`: the connection's status
	// is not `active` (disabled, draft, testing). Read in the bind's own query; the
	// gate refuses a managed account then (gate.ConnectionInactive), which is what
	// holds its device codes, since the device lane never asks the API.
	//
	// ⚠ NULL, OR NO ROW, REFUSES NOTHING. NULL is "not known yet": a row an API
	// pod from before the column wrote. Reading it as inactive would lock out
	// every managed account of that connection for a mirror that is merely old.
	ConnectionInactive bool

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

	// Deleting is true while an owner or admin has the mailbox in its deletion
	// grace (`authd.accounts.deleting_at`): the mailbox keeps receiving mail until
	// the purge, and NO BIND succeeds until a restore. Its own column and not
	// Suspended, because every resume path clears `suspended_at` and a deletion
	// must survive all of them. Read from the bind's row and acted on ahead of the
	// credential cache, like the others.
	Deleting bool

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

	// TenantID is `authd.accounts.tenant_id` as text, "" when null (i10's own
	// mailboxes). gate.DeviceRefusal matches a device's workspace against it.
	TenantID string

	Aliases  []string
	MemberOf []string // group names, not DNs; the caller renders DNs

	// Devices are the account's mail devices among those AccountsByUIDs was
	// asked about, for the mail front's re-check (gate.DeviceRefusal). Nothing
	// else fills it.
	Devices []Device
}

// Device is a mail device's row as the gate matches it to its account
// (`authd.mail_devices`, gate.DeviceRefusal): exactly the columns the mail
// front's role may read.
type Device struct {
	// ID is the row's UUID as Postgres writes it (devicecode.Code.ID).
	ID          string
	ClerkUserID string
	Email       string
	// TenantID is the workspace the device was minted in, as text, "" when null.
	TenantID string
	Platform string
}

// DeviceCredential is a device row as authd's bind reads it: the row, the keyed
// hash of its code, and the clock rules judged by the server's clock (the same
// clock the first-use claim and the touch compare with).
type DeviceCredential struct {
	Device
	CodeHash []byte
	CodeKID  int
	// Used is `first_used_at IS NOT NULL`.
	Used bool
	// Idle is a used code whose last sign-in is older than DeviceIdleLimit.
	Idle bool
	// TouchDue is a used code whose `last_used_at` is older than a day.
	TouchDue bool
}

// ChangeKind says what a Change's Key names (`authd.access_changes.kind`).
type ChangeKind string

const (
	// ChangeAccount: a Clerk user id.
	ChangeAccount ChangeKind = "account"
	// ChangeDomain: a lowercased mail domain, the part of an address after the @.
	ChangeDomain ChangeKind = "domain"
	// ChangeConnection: an SSO connection id.
	ChangeConnection ChangeKind = "connection"
	// ChangeAll: a gate table was truncated; every account may have changed.
	ChangeAll ChangeKind = "all"
)

// Change is one key whose gate inputs a committed transaction touched.
type Change struct {
	Kind ChangeKind
	Key  string
}

// ChangeBatch is one read of the access-change log (Postgres.AccessChanges).
type ChangeBatch struct {
	Changes []Change
	// Snapshot is where the next read starts, opaque to the caller.
	Snapshot string
	// ServerStart is the server's `pg_postmaster_start_time()` when this batch
	// was read. A change between polls means the server restarted or failed over;
	// a lagging replica promoted and then advanced by new commits past the old
	// xmax would not trip Rewound on xmax alone, so the caller treats a changed
	// ServerStart as rewound too.
	ServerStart time.Time
	// Truncated is true when there were more changes than the read's limit.
	Truncated bool
	// Rewound is true when the server's transaction ids are below the position
	// read from (a point-in-time restore, or a failover to a replica that had not
	// replayed everything): the changes cannot be trusted, and the reader must
	// re-check everything and continue from Snapshot.
	Rewound bool
	// QueryTime is the statement's own time, without the wait for a pooled
	// connection.
	QueryTime time.Duration
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
