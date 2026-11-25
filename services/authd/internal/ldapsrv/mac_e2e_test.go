package ldapsrv_test

import (
	"bytes"
	"errors"
	"net/netip"
	"testing"
	"time"

	goldapclient "github.com/go-ldap/ldap/v3"

	"github.com/i10-tech/i10/services/authd/internal/bindtoken"
	"github.com/i10-tech/i10/services/authd/internal/devicecode"
	"github.com/i10-tech/i10/services/authd/internal/projection"
)

// The Mac lane (#383 PR 3, docs/research/mail-device-binding.md section 11,
// "authd's rules for a macos device") through the real bind handler: the
// front's AUTHENTICATE EXTERNAL, a Mac's code on IMAP with its certificate, and
// a Mac's code on SMTP while a certificate session of it lives. What Postgres
// decides (the liveness rows' window, throttle and cap) is in
// mac_db_e2e_test.go.

var (
	macKey   = bytes.Repeat([]byte{0x3c}, 32)
	otherKey = bytes.Repeat([]byte{0x3d}, 32)
	macAddr  = netip.MustParseAddr("198.51.100.20")
	elseAddr = netip.MustParseAddr("198.51.100.21")
	macAddr6 = netip.MustParseAddr("2001:db8:1:2::77")
)

const macSerial = "C02MACSERIAL"

// macIMAP is what the front attests for a Mac on 993 whose certificate
// verified: its key and its subject CN (Apple puts the serial there).
func macIMAP(key []byte, cn string, addr netip.Addr) bindtoken.Attest {
	return bindtoken.Attest{Protocol: bindtoken.IMAP, Addr: addr, CertKey: key, CertCN: cn}
}

func smtpFrom(addr netip.Addr) bindtoken.Attest {
	return bindtoken.Attest{Protocol: bindtoken.SMTP, Addr: addr}
}

// addMac stores a Mac for alice, bound to macKey and macSerial, already used.
func (r *deviceRig) addMac(c devicecode.Code, edit ...func(*projection.DeviceCredential)) {
	r.devices.add(c, "user_alice", aliceEmail, append([]func(*projection.DeviceCredential){func(d *projection.DeviceCredential) {
		d.Platform, d.CertKey, d.Serial, d.Used = "macos", macKey, macSerial, true
	}}, edit...)...)
}

// external binds as the front's AUTHENTICATE EXTERNAL would, for device id.
func (r *deviceRig) external(t *testing.T, id string, at bindtoken.Attest) uint16 {
	t.Helper()
	tok, err := bindtoken.WrapExternal(testTokenKey, "user_alice", id, at, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	return resultCode(dial(t, r.addr).RawBind(aliceDN, tok))
}

// code binds a device code behind a token attesting at.
func (r *deviceRig) code(t *testing.T, password string, at bindtoken.Attest) uint16 {
	t.Helper()
	tok, err := bindtoken.Wrap(testTokenKey, "user_alice", password, at, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	return resultCode(dial(t, r.addr).RawBind(aliceDN, tok))
}

// untouchedRow fails the test if the bind wrote anything: no first use, no
// touch, no liveness row.
func (r *deviceRig) untouchedRow(t *testing.T) {
	t.Helper()
	_, claims, touches := r.devices.counts()
	if claims != 0 || touches != 0 || len(r.devices.recorded()) != 0 {
		t.Fatalf("%d claims, %d touches, liveness writes %v: a refused bind wrote", claims, touches, r.devices.recorded())
	}
}

func TestAMacSignsInWithItsCertificate(t *testing.T) {
	r := newDeviceRig(t, defaultStore())
	c := newCode(0x61)
	r.addMac(c)
	if got := r.external(t, c.ID(), macIMAP(macKey, macSerial, macAddr)); got != 0 {
		t.Fatalf("EXTERNAL with the row's key: result = %d, want success", got)
	}
	r.untouched(t)
	rec := r.devices.recorded()
	if len(rec) != 1 || rec[0].device != c.ID() || rec[0].at != netip.MustParsePrefix("198.51.100.20/32") || !bytes.Equal(rec[0].key, macKey) {
		t.Fatalf("liveness writes %+v, want one for the device's /32 under its key", rec)
	}
	// Over IPv6 the row is the /64, so a privacy address on the same network is the same Mac.
	if got := r.external(t, c.ID(), macIMAP(macKey, macSerial, macAddr6)); got != 0 {
		t.Fatalf("over IPv6: result = %d", got)
	}
	if rec := r.devices.recorded(); rec[1].at != netip.MustParsePrefix("2001:db8:1:2::/64") {
		t.Fatalf("the IPv6 liveness row is for %s, want the /64", rec[1].at)
	}
	// A row with no serial recorded yet (an operator's probe row) takes any CN.
	probe := newCode(0x62)
	r.addMac(probe, func(d *projection.DeviceCredential) { d.Serial, d.CertKey = "", otherKey })
	if got := r.external(t, probe.ID(), macIMAP(otherKey, "anything", macAddr)); got != 0 {
		t.Fatalf("a row with no serial: result = %d, want success", got)
	}
}

// ⚠ A MAC'S CODE ON IMAP NEEDS ITS CERTIFICATE BEHIND IT, AND ONLY ITS OWN: a code
// dug out of Keychain reads nothing alone.
func TestAMacsCodeOnIMAPSignsInOnlyWithItsCertificate(t *testing.T) {
	r := newDeviceRig(t, defaultStore())
	c := newCode(0x63)
	r.addMac(c)
	if got := r.code(t, c.String(), macIMAP(macKey, macSerial, macAddr)); got != 0 {
		t.Fatalf("the code with the certificate: result = %d, want success", got)
	}
	if rec := r.devices.recorded(); len(rec) != 1 || !bytes.Equal(rec[0].key, macKey) {
		t.Fatalf("liveness writes %+v, want the certificate session recorded", rec)
	}
	r.untouched(t)
}

// ⚠ EVERY MAC REFUSAL IS A WRONG PASSWORD (the SMTP rule's is unavailable), COSTS
// NO PROVIDER OR BUDGET, AND WRITES NOTHING: no first use, no touch, no liveness.
func TestMacRefusals(t *testing.T) {
	c := newCode(0x64)
	unavailable := uint16(goldapclient.LDAPResultUnavailable)
	invalid := uint16(goldapclient.LDAPResultInvalidCredentials)
	cases := map[string]struct {
		setup func(r *deviceRig)
		bind  func(t *testing.T, r *deviceRig) uint16
		want  uint16
	}{
		"EXTERNAL with another key": {
			bind: func(t *testing.T, r *deviceRig) uint16 {
				return r.external(t, c.ID(), macIMAP(otherKey, macSerial, macAddr))
			}, want: invalid},
		"EXTERNAL on a row with no key bound (device_cert_missing)": {
			setup: func(r *deviceRig) { r.devices.rows[c.ID()].CertKey = nil },
			bind: func(t *testing.T, r *deviceRig) uint16 {
				return r.external(t, c.ID(), macIMAP(macKey, macSerial, macAddr))
			}, want: invalid},
		"EXTERNAL on an iPhone's row, even one carrying the key": {
			setup: func(r *deviceRig) { r.devices.rows[c.ID()].Platform = "ios" },
			bind: func(t *testing.T, r *deviceRig) uint16 {
				return r.external(t, c.ID(), macIMAP(macKey, macSerial, macAddr))
			}, want: invalid},
		"EXTERNAL for a device that does not exist": {
			bind: func(t *testing.T, r *deviceRig) uint16 {
				return r.external(t, newCode(0x7f).ID(), macIMAP(macKey, macSerial, macAddr))
			}, want: invalid},
		"EXTERNAL for another person's Mac": {
			setup: func(r *deviceRig) { r.devices.rows[c.ID()].ClerkUserID = "user_bob" },
			bind: func(t *testing.T, r *deviceRig) uint16 {
				return r.external(t, c.ID(), macIMAP(macKey, macSerial, macAddr))
			}, want: invalid},
		"EXTERNAL with a certificate for another serial (revision 5)": {
			bind: func(t *testing.T, r *deviceRig) uint16 {
				return r.external(t, c.ID(), macIMAP(macKey, "C02OTHERMAC", macAddr))
			}, want: invalid},
		"EXTERNAL on a Mac idle past 90 days": {
			setup: func(r *deviceRig) { r.devices.rows[c.ID()].Idle = true },
			bind: func(t *testing.T, r *deviceRig) uint16 {
				return r.external(t, c.ID(), macIMAP(macKey, macSerial, macAddr))
			}, want: invalid},
		"EXTERNAL on an unused row past its first-use window": {
			setup: func(r *deviceRig) { r.devices.rows[c.ID()].Used = false; r.devices.unclaim[c.ID()] = true },
			bind: func(t *testing.T, r *deviceRig) uint16 {
				return r.external(t, c.ID(), macIMAP(macKey, macSerial, macAddr))
			}, want: invalid},
		"a Mac's code on IMAP with another certificate": {
			bind: func(t *testing.T, r *deviceRig) uint16 {
				return r.code(t, c.String(), macIMAP(otherKey, macSerial, macAddr))
			}, want: invalid},
		"a Mac's code on IMAP with its key but another serial": {
			bind: func(t *testing.T, r *deviceRig) uint16 {
				return r.code(t, c.String(), macIMAP(macKey, "C02OTHERMAC", macAddr))
			}, want: invalid},
		"a Mac's code on IMAP with no certificate (device_cert_required)": {
			bind: func(t *testing.T, r *deviceRig) uint16 { return r.code(t, c.String(), imapAt) }, want: invalid},
		"a Mac's wrong code with its certificate": {
			bind: func(t *testing.T, r *deviceRig) uint16 {
				return r.code(t, forgeSecret(c), macIMAP(macKey, macSerial, macAddr))
			}, want: invalid},
		"an iPhone's code with a certificate key behind it (revision 5)": {
			setup: func(r *deviceRig) { r.devices.rows[c.ID()].Platform, r.devices.rows[c.ID()].CertKey = "ios", nil },
			bind: func(t *testing.T, r *deviceRig) uint16 {
				return r.code(t, c.String(), macIMAP(macKey, macSerial, macAddr))
			}, want: invalid},
		"a Mac's code on SMTP with no certificate session": {
			bind: func(t *testing.T, r *deviceRig) uint16 { return r.code(t, c.String(), smtpFrom(macAddr)) }, want: unavailable},
		"a Mac's code on SMTP, the certificate session from another address": {
			setup: func(r *deviceRig) { r.devices.setLive(c.ID(), projection.MacLivePrefix(elseAddr), macKey) },
			bind:  func(t *testing.T, r *deviceRig) uint16 { return r.code(t, c.String(), smtpFrom(macAddr)) }, want: unavailable},
		"a Mac's code on SMTP, the certificate session under a key the row no longer has": {
			setup: func(r *deviceRig) { r.devices.setLive(c.ID(), projection.MacLivePrefix(macAddr), otherKey) },
			bind:  func(t *testing.T, r *deviceRig) uint16 { return r.code(t, c.String(), smtpFrom(macAddr)) }, want: unavailable},
		"a Mac's code on SMTP, its key cleared": {
			setup: func(r *deviceRig) {
				r.devices.setLive(c.ID(), projection.MacLivePrefix(macAddr), macKey)
				r.devices.rows[c.ID()].CertKey = nil
			},
			bind: func(t *testing.T, r *deviceRig) uint16 { return r.code(t, c.String(), smtpFrom(macAddr)) }, want: invalid},
		// The hash comes before the liveness rule: a wrong code is wrong, whatever
		// the Mac is doing.
		"a Mac's wrong code on SMTP while it is online": {
			setup: func(r *deviceRig) { r.devices.setLive(c.ID(), projection.MacLivePrefix(macAddr), macKey) },
			bind:  func(t *testing.T, r *deviceRig) uint16 { return r.code(t, forgeSecret(c), smtpFrom(macAddr)) }, want: invalid},
		"the liveness rows unreadable": {
			setup: func(r *deviceRig) { r.devices.liveErr = errors.New("connection refused") },
			bind:  func(t *testing.T, r *deviceRig) uint16 { return r.code(t, c.String(), smtpFrom(macAddr)) }, want: unavailable},
		"EXTERNAL with the device store unreachable": {
			setup: func(r *deviceRig) { r.devices.err = errors.New("connection refused") },
			bind: func(t *testing.T, r *deviceRig) uint16 {
				return r.external(t, c.ID(), macIMAP(macKey, macSerial, macAddr))
			}, want: unavailable},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			r := newDeviceRig(t, defaultStore())
			r.addMac(c)
			if tc.setup != nil {
				tc.setup(r)
			}
			before := len(r.devices.recorded())
			if got := tc.bind(t, r); got != tc.want {
				t.Fatalf("result = %d, want %d", got, tc.want)
			}
			r.untouched(t)
			_, claims, touches := r.devices.counts()
			if touches != 0 || len(r.devices.recorded()) != before ||
				(claims != 0 && name != "EXTERNAL on an unused row past its first-use window") {
				t.Fatalf("%d claims, %d touches, liveness writes %v: a refused bind wrote", claims, touches, r.devices.recorded())
			}
			if name == "EXTERNAL on an unused row past its first-use window" && r.devices.rows[c.ID()].Used {
				t.Fatal("a refused expired first-use claim marked the row used")
			}
		})
	}
}

// ⚠ A MAC SENDS WITH ITS CODE ONLY WHILE ONLINE: a certificate session of it,
// under its current key, from the same address, unless the same-address part is
// switched off.
func TestAMacsCodeOnSMTPNeedsALiveCertificateSession(t *testing.T) {
	c := newCode(0x65)
	t.Run("from the same address", func(t *testing.T) {
		r := newDeviceRig(t, defaultStore())
		r.addMac(c)
		if got := r.external(t, c.ID(), macIMAP(macKey, macSerial, macAddr)); got != 0 {
			t.Fatalf("IMAP: %d", got)
		}
		if got := r.code(t, c.String(), smtpFrom(macAddr)); got != 0 {
			t.Fatalf("SMTP from the IMAP session's address: result = %d, want success", got)
		}
		if got := r.code(t, c.String(), smtpFrom(elseAddr)); got != goldapclient.LDAPResultUnavailable {
			t.Fatalf("SMTP from another address: result = %d, want unavailable", got)
		}
		// SMTP never writes a liveness row: only a certificate session does.
		if rec := r.devices.recorded(); len(rec) != 1 {
			t.Fatalf("liveness writes %+v, want only IMAP's", rec)
		}
		r.untouched(t)
	})
	t.Run("same address switched off", func(t *testing.T) {
		r := newDeviceRig(t, defaultStore(), func(o *fixtureOptions) { o.macAnyAddress = true })
		r.addMac(c)
		r.devices.setLive(c.ID(), projection.MacLivePrefix(macAddr6), macKey)
		if got := r.code(t, c.String(), smtpFrom(elseAddr)); got != 0 {
			t.Fatalf("SMTP over IPv4 while the Mac is online over IPv6: result = %d, want success", got)
		}
		r.devices.live = map[string]map[netip.Prefix][]byte{}
		if got := r.code(t, c.String(), smtpFrom(elseAddr)); got != goldapclient.LDAPResultUnavailable {
			t.Fatalf("SMTP with the Mac offline: result = %d, want unavailable", got)
		}
	})
}

// Every successful Mac bind claims a first use not yet claimed and touches the
// row daily, so an active Mac is never pruned; a failed liveness write does not
// turn a good bind away.
func TestAMacBindKeepsItsRowAlive(t *testing.T) {
	r := newDeviceRig(t, defaultStore())
	c := newCode(0x66)
	r.addMac(c, func(d *projection.DeviceCredential) { d.Used = false })
	if got := r.external(t, c.ID(), macIMAP(macKey, macSerial, macAddr)); got != 0 {
		t.Fatalf("first EXTERNAL: %d", got)
	}
	r.devices.rows[c.ID()].TouchDue = true
	r.devices.recordErr = errors.New("read-only transaction")
	if got := r.external(t, c.ID(), macIMAP(macKey, macSerial, macAddr)); got != 0 {
		t.Fatalf("with the liveness write failing: %d, want success", got)
	}
	if _, claims, touches := r.devices.counts(); claims != 1 || touches != 1 {
		t.Fatalf("%d claims, %d touches; want the first use claimed once and one touch", claims, touches)
	}
	// SMTP keeps the row alive too.
	r.devices.recordErr = nil
	r.devices.setLive(c.ID(), projection.MacLivePrefix(macAddr), macKey)
	r.devices.rows[c.ID()].TouchDue = true
	if got := r.code(t, c.String(), smtpFrom(macAddr)); got != 0 {
		t.Fatalf("SMTP: %d", got)
	}
	if _, _, touches := r.devices.counts(); touches != 2 {
		t.Fatalf("%d touches after the SMTP bind, want 2", touches)
	}
}

// An iPhone or iPad is unchanged by the Mac rules: no certificate, either
// protocol, any address, and no liveness rows.
func TestAnIPhoneIsUnchangedByTheMacRules(t *testing.T) {
	r := newDeviceRig(t, defaultStore())
	c := newCode(0x67)
	r.devices.add(c, "user_alice", aliceEmail)
	for _, at := range []bindtoken.Attest{imapAt, smtpFrom(macAddr), smtpFrom(macAddr6)} {
		if got := r.code(t, c.String(), at); got != 0 {
			t.Fatalf("%s from %s: result = %d", at.Protocol, at.Addr, got)
		}
	}
	if rec := r.devices.recorded(); len(rec) != 0 {
		t.Fatalf("an iPhone wrote liveness rows: %+v", rec)
	}
	r.untouched(t)
}

// ⚠ EXTERNAL COMES AFTER THE WHOLE GATE: a held account reads no device row.
func TestAHeldAccountsMacIsRefusedBeforeItsRowIsRead(t *testing.T) {
	store := defaultStore()
	store.accounts[0].PaymentHold = true
	r := newDeviceRig(t, store)
	c := newCode(0x68)
	r.addMac(c)
	if got := r.external(t, c.ID(), macIMAP(macKey, macSerial, macAddr)); got != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("result = %d, want invalidCredentials", got)
	}
	if reads, _, _ := r.devices.counts(); reads != 0 {
		t.Fatalf("the device row was read %d times for a held account", reads)
	}
	r.untouchedRow(t)
	r.untouched(t)
}

// An external token never needs the device code keys: a Mac signs in with its
// certificate while MAIL_DEVICE_CODE_KEYS is unset.
func TestExternalNeedsNoDeviceCodeKeys(t *testing.T) {
	r := newDeviceRig(t, defaultStore(), func(o *fixtureOptions) { o.deviceKeys = nil })
	c := newCode(0x69)
	r.addMac(c)
	if got := r.external(t, c.ID(), macIMAP(macKey, macSerial, macAddr)); got != 0 {
		t.Fatalf("result = %d, want success", got)
	}
}
