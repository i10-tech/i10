package ldapsrv_test

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	goldapclient "github.com/go-ldap/ldap/v3"

	"github.com/i10-tech/i10/services/authd/internal/bindtoken"
	"github.com/i10-tech/i10/services/authd/internal/credcache"
	"github.com/i10-tech/i10/services/authd/internal/devicecode"
	"github.com/i10-tech/i10/services/authd/internal/passthrough"
	"github.com/i10-tech/i10/services/authd/internal/projection"
	"github.com/i10-tech/i10/services/authd/internal/verify"
)

// The device lane (#383) through the real bind handler, with the device rows in
// memory. What the database itself decides (the first-use window, concurrent
// first connections, the idle limit) is in device_db_e2e_test.go, against
// Postgres.

// deviceKey is MAIL_DEVICE_CODE_KEYS key 4 in these tests.
var deviceKey = []byte("device-code-key-0123456789abcdef")

func deviceKeys() devicecode.Keys { return devicecode.Keys{4: deviceKey} }

// newCode is a fresh device code whose id starts with b.
func newCode(b byte) devicecode.Code {
	var id [16]byte
	var secret [32]byte
	id[0], id[15], secret[0], secret[31] = b, 0x40, b, 0x99
	return devicecode.New(id, secret)
}

// fakeDevices is ldapsrv.DeviceStore over a map. claimable decides the
// first-use claim, as the database's ten-minute window would.
type fakeDevices struct {
	mu        sync.Mutex
	rows      map[string]*projection.DeviceCredential
	unclaim   map[string]bool // ids whose first use is past its window
	err       error
	touchErr  error
	reads     int
	claims    int
	touches   int
	lastTouch string
}

func newFakeDevices() *fakeDevices {
	return &fakeDevices{rows: map[string]*projection.DeviceCredential{}, unclaim: map[string]bool{}}
}

// add stores a device for c, as the API's store function would mint it for
// person uid at address email.
func (f *fakeDevices) add(c devicecode.Code, uid, email string, edit ...func(*projection.DeviceCredential)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	d := &projection.DeviceCredential{
		Device:   projection.Device{ID: c.ID(), ClerkUserID: uid, Email: email, Platform: "ios"},
		CodeHash: devicecode.Hash(deviceKey, c),
		CodeKID:  4,
	}
	for _, e := range edit {
		e(d)
	}
	f.rows[c.ID()] = d
}

func (f *fakeDevices) DeviceByID(_ context.Context, id string) (*projection.DeviceCredential, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reads++
	if f.err != nil {
		return nil, f.err
	}
	d, ok := f.rows[id]
	if !ok {
		return nil, nil
	}
	cp := *d
	return &cp, nil
}

func (f *fakeDevices) ClaimDeviceFirstUse(_ context.Context, id string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.claims++
	d, ok := f.rows[id]
	if !ok || (!d.Used && f.unclaim[id]) {
		return false, nil
	}
	d.Used = true
	return true, nil
}

func (f *fakeDevices) TouchDevice(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.touches++
	f.lastTouch = id
	if f.touchErr != nil {
		return f.touchErr
	}
	if d, ok := f.rows[id]; ok {
		d.TouchDue = false
	}
	return nil
}

func (f *fakeDevices) counts() (reads, claims, touches int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.reads, f.claims, f.touches
}

// deviceRig is a server with the device lane on, every provider counted.
type deviceRig struct {
	addr    string
	store   *fakeStore
	devices *fakeDevices
	clerk   *fakeVerifier
	dir     *fakeDirectory
	budget  *fakeBudgetStore
}

type rigOption func(*fixtureOptions)

func newDeviceRig(t *testing.T, store *fakeStore, opts ...rigOption) *deviceRig {
	t.Helper()
	r := &deviceRig{
		store:   store,
		devices: newFakeDevices(),
		clerk:   &fakeVerifier{outcome: verify.Verified},
		dir:     &fakeDirectory{result: resultVerified},
		budget:  newFakeBudgetStore(),
	}
	o := fixtureOptions{
		store:      store,
		resolver:   &passthrough.ManagedResolver{Unmanaged: r.clerk, Directory: r.dir},
		perMinute:  600,
		cache:      credcache.New(2 * time.Hour),
		budget:     r.budget,
		devices:    r.devices,
		deviceKeys: deviceKeys(),
	}
	for _, opt := range opts {
		opt(&o)
	}
	r.addr = newFixtureOpts(t, o)
	return r
}

func (r *deviceRig) bind(t *testing.T, dn, password string) uint16 {
	t.Helper()
	if err := dial(t, r.addr).Bind(dn, password); err != nil {
		return resultCode(err)
	}
	return goldapclient.LDAPResultSuccess
}

// untouched fails the test if anything but the device store was asked: no
// verifier, no directory, no failure-budget write.
func (r *deviceRig) untouched(t *testing.T) {
	t.Helper()
	reserves, releases := r.budget.counts()
	if r.clerk.callCount() != 0 || r.dir.callCount() != 0 || reserves != 0 || releases != 0 {
		t.Fatalf("clerk %d, directory %d, budget reserves %d, releases %d: the device lane reached a provider or the budget",
			r.clerk.callCount(), r.dir.callCount(), reserves, releases)
	}
}

func TestADeviceCodeSignsInWithoutAskingAnyProvider(t *testing.T) {
	r := newDeviceRig(t, defaultStore())
	c := newCode(1)
	r.devices.add(c, "user_alice", aliceEmail)

	if got := r.bind(t, aliceDN, c.String()); got != goldapclient.LDAPResultSuccess {
		t.Fatalf("result = %d, want success", got)
	}
	if got := r.bind(t, aliceDN, c.String()); got != goldapclient.LDAPResultSuccess {
		t.Fatalf("second bind: result = %d, want success", got)
	}
	r.untouched(t)
	// The first bind claimed the first use; the second found it used, and its
	// stamp was not a day old, so nothing was written.
	if reads, claims, touches := r.devices.counts(); reads != 2 || claims != 1 || touches != 0 {
		t.Fatalf("device store: %d reads, %d claims, %d touches; want 2, 1, 0", reads, claims, touches)
	}
	// The person's password still works beside it, through Clerk as before.
	if got := r.bind(t, aliceDN, alicePass); got != goldapclient.LDAPResultSuccess || r.clerk.callCount() != 1 {
		t.Fatalf("the password bind: result = %d, clerk %d", got, r.clerk.callCount())
	}
}

// ⚠ EVERY REFUSAL IS A WRONG PASSWORD AND COSTS NOTHING ELSE: no provider call,
// no budget slot, and no write to the device row.
func TestDeviceCodeRefusals(t *testing.T) {
	alicesCode, bobsCode := newCode(1), newCode(2)
	cases := map[string]struct {
		password string
		setup    func(r *deviceRig)
		// readsRow: whether the refusal comes after the row read.
		readsRow bool
	}{
		"no such device": {password: newCode(9).String(), readsRow: true},
		"person B's code on person A's DN": {password: bobsCode.String(), readsRow: true, setup: func(r *deviceRig) {
			r.devices.add(bobsCode, "user_bob", "bob@i10.tech")
		}},
		// Only the person differs: the row carries alice's own address.
		"a row of another person's, on this account's address": {password: bobsCode.String(), readsRow: true, setup: func(r *deviceRig) {
			r.devices.add(bobsCode, "user_bob", aliceEmail)
		}},
		"minted for an address the account no longer has": {password: alicesCode.String(), readsRow: true, setup: func(r *deviceRig) {
			r.devices.add(alicesCode, "user_alice", "old-alice@i10.tech")
		}},
		"minted in another workspace": {password: alicesCode.String(), readsRow: true, setup: func(r *deviceRig) {
			r.devices.add(alicesCode, "user_alice", aliceEmail, func(d *projection.DeviceCredential) { d.TenantID = "t-other" })
		}},
		"a Mac's code (PR 3 adds its certificate)": {password: alicesCode.String(), readsRow: true, setup: func(r *deviceRig) {
			r.devices.add(alicesCode, "user_alice", aliceEmail, func(d *projection.DeviceCredential) { d.Platform = "macos" })
		}},
		"the right id with another secret": {password: forgeSecret(alicesCode), readsRow: true, setup: func(r *deviceRig) {
			r.devices.add(alicesCode, "user_alice", aliceEmail)
		}},
		"a hash copied from another device's row": {password: alicesCode.String(), readsRow: true, setup: func(r *deviceRig) {
			r.devices.add(alicesCode, "user_alice", aliceEmail, func(d *projection.DeviceCredential) {
				d.CodeHash = devicecode.Hash(deviceKey, bobsCode)
			})
		}},
		"an unused code past its ten minutes": {password: alicesCode.String(), readsRow: true, setup: func(r *deviceRig) {
			r.devices.add(alicesCode, "user_alice", aliceEmail)
			r.devices.unclaim[alicesCode.ID()] = true
		}},
		"a used code idle past 90 days": {password: alicesCode.String(), readsRow: true, setup: func(r *deviceRig) {
			r.devices.add(alicesCode, "user_alice", aliceEmail, func(d *projection.DeviceCredential) { d.Used, d.Idle, d.TouchDue = true, true, true })
		}},
		// ⚠ The reserved prefix: a code a client mangled never reaches Clerk.
		"a truncated code":         {password: alicesCode.String()[:devicecode.Len-1]},
		"a code with a newline":    {password: alicesCode.String() + "\n"},
		"the bare reserved prefix": {password: "i10dc"},
		"another code version":     {password: "i10dc2." + strings.TrimPrefix(alicesCode.String(), devicecode.Prefix)},
		"uppercase hex":            {password: upperHex(newCode(0xab))},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			r := newDeviceRig(t, defaultStore())
			if c.setup != nil {
				c.setup(r)
			}
			if got := r.bind(t, aliceDN, c.password); got != goldapclient.LDAPResultInvalidCredentials {
				t.Fatalf("result = %d, want invalidCredentials", got)
			}
			r.untouched(t)
			reads, _, touches := r.devices.counts()
			if (reads == 1) != c.readsRow || touches != 0 {
				t.Fatalf("device store: %d reads, %d touches", reads, touches)
			}
			// A refused code never starts a code's life.
			if d, _ := r.devices.DeviceByID(context.Background(), alicesCode.ID()); d != nil && d.Used && name != "a used code idle past 90 days" {
				t.Fatal("a refused bind recorded a first use")
			}
		})
	}
}

// upperHex is c with its id's hex digits in upper case (c's id must have letters).
func upperHex(c devicecode.Code) string {
	s, n := c.String(), len(devicecode.Prefix)
	return s[:n] + strings.ToUpper(s[n:n+32]) + s[n+32:]
}

// forgeSecret is c's id with a different secret.
func forgeSecret(c devicecode.Code) string {
	s := c.String()
	return s[:len(s)-2] + "AA"
}

// ⚠ OUR FAULTS ARE UNAVAILABLE. An iPhone told "wrong password" asks its owner
// for a code they have never seen; unavailable makes it retry.
func TestDeviceLaneFaultsAreUnavailable(t *testing.T) {
	c := newCode(1)
	cases := map[string]struct {
		opts  []rigOption
		setup func(r *deviceRig)
	}{
		"no key ring (MAIL_DEVICE_CODE_KEYS unset)": {opts: []rigOption{func(o *fixtureOptions) { o.deviceKeys = nil }}},
		"a key id the ring does not hold": {setup: func(r *deviceRig) {
			r.devices.add(c, "user_alice", aliceEmail, func(d *projection.DeviceCredential) { d.CodeKID = 9 })
		}},
		"the device store unreachable": {setup: func(r *deviceRig) { r.devices.err = errors.New("connection refused") }},
		"no device store":              {opts: []rigOption{func(o *fixtureOptions) { o.devices = nil }}},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			r := newDeviceRig(t, defaultStore(), tc.opts...)
			r.devices.add(c, "user_alice", aliceEmail)
			if tc.setup != nil {
				tc.setup(r)
			}
			if got := r.bind(t, aliceDN, c.String()); got != goldapclient.LDAPResultUnavailable {
				t.Fatalf("result = %d, want unavailable", got)
			}
			r.untouched(t)
			// The password lane does not depend on the device lane.
			if got := r.bind(t, aliceDN, alicePass); got != goldapclient.LDAPResultSuccess {
				t.Fatalf("the password bind beside it: result = %d", got)
			}
		})
	}
}

// ⚠ THE TOKEN BINDS THE DEVICE. The front puts the device the password names in
// the token's MAC; a token minted for one device, in front of another device's
// code, is refused before the device lane runs, as a token for another person is.
func TestATokenForOneDeviceDoesNotOpenAnother(t *testing.T) {
	r := newDeviceRig(t, defaultStore())
	a, b := newCode(1), newCode(2)
	r.devices.add(a, "user_alice", aliceEmail)
	r.devices.add(b, "user_alice", aliceEmail)

	forA, err := bindtoken.Wrap(testTokenKey, "user_alice", a.String(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	forged := strings.TrimSuffix(forA, a.String()) + b.String()
	if got := resultCode(dial(t, r.addr).RawBind(aliceDN, forged)); got != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("device A's token in front of device B's code: result = %d, want invalidCredentials", got)
	}
	if reads, _, _ := r.devices.counts(); reads != 0 {
		t.Fatalf("the device store was read %d times for a token that did not verify", reads)
	}
	if got := resultCode(dial(t, r.addr).RawBind(aliceDN, forA)); got != 0 {
		t.Fatalf("device A's own token: result = %d, want success", got)
	}
	r.untouched(t)
}

// A device code is held by every hold the row shows, exactly as the password
// is, and works again the moment the hold lifts. Nothing is deleted by a hold.
func TestEveryRowHoldHoldsDeviceCodesAndLiftingItResumesThem(t *testing.T) {
	holds := map[string]func(a *projection.Account, on bool){
		"suspended":         func(a *projection.Account, on bool) { a.Suspended = on },
		"payment hold":      func(a *projection.Account, on bool) { a.PaymentHold = on },
		"deleting":          func(a *projection.Account, on bool) { a.Deleting = on },
		"clerk ban":         func(a *projection.Account, on bool) { a.Banned = on },
		"clerk lock":        func(a *projection.Account, on bool) { a.Locked = on },
		"domain not hosted": func(a *projection.Account, on bool) { a.DomainNotHosted = on },
		"sso required":      func(a *projection.Account, on bool) { a.SSORequired = on },
		"inactive (unpaid, deprovisioned)": func(a *projection.Account, on bool) {
			a.Active = !on
		},
	}
	for name, set := range holds {
		t.Run(name, func(t *testing.T) {
			store := defaultStore()
			r := newDeviceRig(t, store)
			c := newCode(1)
			r.devices.add(c, "user_alice", aliceEmail)
			if got := r.bind(t, aliceDN, c.String()); got != goldapclient.LDAPResultSuccess {
				t.Fatalf("before the hold: result = %d", got)
			}
			set(&store.accounts[0], true)
			if got := r.bind(t, aliceDN, c.String()); got != goldapclient.LDAPResultInvalidCredentials {
				t.Fatalf("during the hold: result = %d, want invalidCredentials", got)
			}
			if reads, _, _ := r.devices.counts(); reads != 1 {
				t.Fatalf("the device row was read %d times: a held account reached the device lane", reads)
			}
			set(&store.accounts[0], false)
			if got := r.bind(t, aliceDN, c.String()); got != goldapclient.LDAPResultSuccess {
				t.Fatalf("after the hold lifted: result = %d", got)
			}
			r.untouched(t)
		})
	}
}

// ⚠ ROUTEOF'S REFUSALS HOLD DEVICE CODES TOO (revision 1 of the design skipped
// them and was wrong): an account that SSO is required for and does not manage
// yet, a managed account whose connection is gone, and one whose connection is
// not active.
func TestRouteRefusalsHoldDeviceCodes(t *testing.T) {
	cases := map[string]func(a *projection.Account){
		"sso_required":          func(a *projection.Account) { a.SSORequired = true },
		"managed_no_connection": func(a *projection.Account) { a.Managed, a.ManagedConnection = true, "" },
		"connection_inactive": func(a *projection.Account) {
			a.Managed, a.ManagedConnection, a.ConnectionInactive = true, connAcme, true
		},
	}
	for name, set := range cases {
		t.Run(name, func(t *testing.T) {
			store := defaultStore()
			set(&store.accounts[0])
			r := newDeviceRig(t, store)
			c := newCode(1)
			r.devices.add(c, "user_alice", aliceEmail)
			if got := r.bind(t, aliceDN, c.String()); got != goldapclient.LDAPResultInvalidCredentials {
				t.Fatalf("result = %d, want invalidCredentials", got)
			}
			if reads, _, _ := r.devices.counts(); reads != 0 {
				t.Fatalf("the device row was read %d times for an account the route refuses", reads)
			}
			r.untouched(t)
		})
	}
}

// ⚠ AN ENTRA-STYLE MANAGED ACCOUNT: its connection is active, and it has no
// password lane (no pass-through at all here). Its device code signs in; its
// company password cannot, and nothing asks Clerk either way.
func TestAManagedAccountWithNoPasswordLaneSignsInWithADeviceCode(t *testing.T) {
	store := managedStore()
	r := newDeviceRig(t, store, func(o *fixtureOptions) {
		o.resolver = &passthrough.ManagedResolver{Unmanaged: &fakeVerifier{outcome: verify.Verified}}
	})
	c := newCode(3)
	r.devices.add(c, carolUID, carolMail)
	if got := r.bind(t, carolDN, c.String()); got != goldapclient.LDAPResultSuccess {
		t.Fatalf("device code: result = %d, want success", got)
	}
	if got := r.bind(t, carolDN, carolPass); got == goldapclient.LDAPResultSuccess {
		t.Fatal("a managed account with no pass-through signed in with a password")
	}
	r.untouched(t)
}

// The per-DN throttle applies to the device lane as to passwords: a client
// stuck replaying a code is slowed down, without any provider involved.
func TestTheThrottleAppliesToDeviceCodes(t *testing.T) {
	r := newDeviceRig(t, defaultStore(), func(o *fixtureOptions) { o.perMinute = 1 })
	c := newCode(1)
	r.devices.add(c, "user_alice", aliceEmail)
	if got := r.bind(t, aliceDN, c.String()); got != goldapclient.LDAPResultSuccess {
		t.Fatalf("first: %d", got)
	}
	if got := r.bind(t, aliceDN, "i10dc-junk"); got != goldapclient.LDAPResultBusy {
		t.Fatalf("second, past the burst: result = %d, want busy", got)
	}
	r.untouched(t)
}

// A used code is touched at most once a day: a bind whose stamp is due writes
// it, the next does not.
func TestAUsedCodeIsTouchedOnlyWhenItsStampIsADayOld(t *testing.T) {
	r := newDeviceRig(t, defaultStore())
	c := newCode(1)
	r.devices.add(c, "user_alice", aliceEmail, func(d *projection.DeviceCredential) { d.Used, d.TouchDue = true, true })
	for range 3 {
		if got := r.bind(t, aliceDN, c.String()); got != goldapclient.LDAPResultSuccess {
			t.Fatalf("result = %d", got)
		}
	}
	if _, claims, touches := r.devices.counts(); claims != 0 || touches != 1 {
		t.Fatalf("%d claims, %d touches; want 0 and 1", claims, touches)
	}
}

// The touch only keeps a device ahead of the idle prune; a failed one must not
// turn a good code away.
func TestAFailedTouchStillSignsIn(t *testing.T) {
	r := newDeviceRig(t, defaultStore())
	c := newCode(1)
	r.devices.add(c, "user_alice", aliceEmail, func(d *projection.DeviceCredential) { d.Used, d.TouchDue = true, true })
	r.devices.touchErr = errors.New("read-only transaction")
	if got := r.bind(t, aliceDN, c.String()); got != goldapclient.LDAPResultSuccess {
		t.Fatalf("result = %d, want success", got)
	}
	if _, _, touches := r.devices.counts(); touches != 1 {
		t.Fatalf("%d touches, want 1", touches)
	}
}
