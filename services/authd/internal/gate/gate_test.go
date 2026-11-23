package gate

import (
	"testing"

	"github.com/i10-tech/i10/services/authd/internal/projection"
)

func TestRefusal(t *testing.T) {
	cases := []struct {
		name string
		acct *projection.Account
		want string
	}{
		{"no active account", nil, NoActiveAccount},
		{"an ordinary account", &projection.Account{}, ""},
		{"suspended", &projection.Account{Suspended: true}, MailboxSuspended},
		// Suspension is named first: it is the reason an admin set by hand.
		{"suspended and deleting", &projection.Account{Suspended: true, Deleting: true}, MailboxSuspended},
		{"deleting", &projection.Account{Deleting: true}, MailboxDeleting},
		{"payment hold", &projection.Account{PaymentHold: true}, PaymentHold},
		{"domain no longer hosted", &projection.Account{DomainNotHosted: true}, DomainNotHosted},
		{"banned", &projection.Account{Banned: true}, AccountBanned},
		{"locked", &projection.Account{Locked: true}, AccountLocked},
		{"SSO required", &projection.Account{SSORequired: true}, SSORequired},
		{"SSO required, exempt", &projection.Account{SSORequired: true, SSOExempt: true}, ""},
		{"SSO required, already managed", &projection.Account{SSORequired: true, Managed: true, ManagedConnection: "c"}, ""},
		{"managed by a connection that is gone", &projection.Account{Managed: true}, ManagedNoConnection},
		{"managed", &projection.Account{Managed: true, ManagedConnection: "c"}, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Refusal(tc.acct); got != tc.want {
				t.Fatalf("Refusal = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestRouteOf(t *testing.T) {
	if r := RouteOf(&projection.Account{}); !r.Clerk() {
		t.Fatalf("an unmanaged account routes to %+v, want Clerk", r)
	}
	if r := RouteOf(&projection.Account{Managed: true, ManagedConnection: "c"}); r.Clerk() || r.Connection != "c" {
		t.Fatalf("a managed account routes to %+v", r)
	}
	if r := RouteOf(&projection.Account{SSORequired: true}); r.Clerk() || r.Refusal != SSORequired {
		t.Fatalf("an SSO-required account routes to %+v", r)
	}
}
