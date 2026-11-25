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
		{"managed by a connection that is not active", &projection.Account{Managed: true, ManagedConnection: "c", ConnectionInactive: true}, ConnectionInactive},
		// A row suspended AND on an inactive connection names the row's reason.
		{"suspended, connection not active", &projection.Account{Suspended: true, Managed: true, ManagedConnection: "c", ConnectionInactive: true}, MailboxSuspended},
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

func TestDeviceRefusal(t *testing.T) {
	acct := &projection.Account{ClerkUserID: "user_a", Email: "a@x.test", TenantID: "t1"}
	ok := projection.Device{ID: "d", ClerkUserID: "user_a", Email: "a@x.test", TenantID: "t1", Platform: "ios"}
	with := func(f func(*projection.Device)) *projection.Device { d := ok; f(&d); return &d }
	cases := []struct {
		name string
		dev  *projection.Device
		acct *projection.Account
		want string
	}{
		{"an iPhone of this account", &ok, acct, ""},
		{"an iPad", with(func(d *projection.Device) { d.Platform = "ipados" }), acct, ""},
		{"no row", nil, acct, DeviceRevoked},
		{"another person's device", with(func(d *projection.Device) { d.ClerkUserID = "user_b" }), acct, DeviceMismatch},
		{"minted for another address", with(func(d *projection.Device) { d.Email = "old@x.test" }), acct, DeviceMismatch},
		{"minted in another workspace", with(func(d *projection.Device) { d.TenantID = "t2" }), acct, DeviceMismatch},
		{"minted in a workspace, mailbox has none now", with(func(d *projection.Device) { d.TenantID = "t1" }),
			&projection.Account{ClerkUserID: "user_a", Email: "a@x.test"}, DeviceMismatch},
		{"no workspace on either side (i10's own)", with(func(d *projection.Device) { d.TenantID = "" }),
			&projection.Account{ClerkUserID: "user_a", Email: "a@x.test"}, ""},
		{"a Mac", with(func(d *projection.Device) { d.Platform = "macos" }), acct, DevicePlatformRefused},
		{"a platform this build does not know", with(func(d *projection.Device) { d.Platform = "android" }), acct, DevicePlatformRefused},
	}
	for _, c := range cases {
		if got := DeviceRefusal(c.dev, c.acct); got != c.want {
			t.Errorf("%s: %q, want %q", c.name, got, c.want)
		}
	}
}
