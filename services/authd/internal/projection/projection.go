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
	ClerkUserID       string
	Email             string
	DisplayName       string
	Description       string
	Active            bool
	PasswordUpdatedAt *time.Time
	Aliases           []string
	MemberOf          []string // group names, not DNs; the caller renders DNs
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
// construction rather than by a filter the caller has to remember to apply —
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
}
