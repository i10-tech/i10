package gate

import (
	"bytes"
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
	key, other := bytes.Repeat([]byte{1}, 32), bytes.Repeat([]byte{2}, 32)
	mac := with(func(d *projection.Device) { d.Platform, d.CertKey = "macos", key })
	cases := []struct {
		name string
		dev  *projection.Device
		acct *projection.Account
		held []byte
		want string
	}{
		{"an iPhone of this account", &ok, acct, nil, ""},
		{"an iPad", with(func(d *projection.Device) { d.Platform = "ipados" }), acct, nil, ""},
		{"no row", nil, acct, nil, DeviceRevoked},
		{"another person's device", with(func(d *projection.Device) { d.ClerkUserID = "user_b" }), acct, nil, DeviceMismatch},
		{"minted for another address", with(func(d *projection.Device) { d.Email = "old@x.test" }), acct, nil, DeviceMismatch},
		{"minted in another workspace", with(func(d *projection.Device) { d.TenantID = "t2" }), acct, nil, DeviceMismatch},
		{"minted in a workspace, mailbox has none now", with(func(d *projection.Device) { d.TenantID = "t1" }),
			&projection.Account{ClerkUserID: "user_a", Email: "a@x.test"}, nil, DeviceMismatch},
		{"no workspace on either side (i10's own)", with(func(d *projection.Device) { d.TenantID = "" }),
			&projection.Account{ClerkUserID: "user_a", Email: "a@x.test"}, nil, ""},
		{"a platform this build does not know", with(func(d *projection.Device) { d.Platform = "android" }), acct, nil, DevicePlatformRefused},
		// A Mac stands on its key.
		{"a Mac, on its own key", mac, acct, key, ""},
		{"a Mac with no key bound", with(func(d *projection.Device) { d.Platform = "macos" }), acct, key, DeviceCertMissing},
		{"a Mac with no key bound, nothing held", with(func(d *projection.Device) { d.Platform = "macos" }), acct, nil, DeviceCertMissing},
		{"a Mac whose key an empty slice", with(func(d *projection.Device) { d.Platform, d.CertKey = "macos", []byte{} }), acct, []byte{}, DeviceCertMissing},
		{"a Mac rebound to another key", mac, acct, other, DeviceKeyChanged},
		{"a Mac, standing on no key", mac, acct, nil, DeviceKeyChanged},
		{"a Mac, standing on a key prefix", mac, acct, key[:31], DeviceKeyChanged},
		{"a key held on an iPhone row", &ok, acct, key, DeviceKeyChanged},
		{"a key held on an iPhone row that has one", with(func(d *projection.Device) { d.CertKey = key }), acct, key, DeviceKeyChanged},
		// The person, address and workspace come first, for a Mac too.
		{"another person's Mac", with(func(d *projection.Device) { d.Platform, d.CertKey, d.ClerkUserID = "macos", key, "user_b" }), acct, key, DeviceMismatch},
	}
	for _, c := range cases {
		if got := DeviceRefusal(c.dev, c.acct, c.held); got != c.want {
			t.Errorf("%s: %q, want %q", c.name, got, c.want)
		}
	}
}
