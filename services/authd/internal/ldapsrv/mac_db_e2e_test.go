package ldapsrv_test

import (
	"bytes"
	"fmt"
	"net/netip"
	"testing"
	"time"

	goldapclient "github.com/go-ldap/ldap/v3"

	"github.com/i10-tech/i10/services/authd/internal/bindtoken"
	"github.com/i10-tech/i10/services/authd/internal/devicecode"
	"github.com/i10-tech/i10/services/authd/internal/passthrough"
	"github.com/i10-tech/i10/services/authd/internal/projection"
	"github.com/i10-tech/i10/services/authd/internal/verify"
)

// The Mac lane against Postgres, as the `authd` role, through the real server:
// the rules Postgres decides (the 75-minute liveness window, the 5-minute write
// throttle, the 8-row per-device cap, IPv6 /64 matching, key changes, and the
// serial check on the real column).

func (d *deviceDB) mintMac(c devicecode.Code, key []byte, serial string) {
	d.t.Helper()
	d.exec(`INSERT INTO authd.mail_devices
		(id, clerk_user_id, email, tenant_id, platform, serial, cert_key_sha256, code_hash, code_kid, created_by)
		SELECT $1::uuid, a.clerk_user_id, a.email, a.tenant_id, 'macos', nullif($2, ''), $3::bytea, $4, 4, 'test'
		FROM authd.accounts a WHERE a.clerk_user_id = $5`,
		c.ID(), serial, key, devicecode.Hash(deviceKey, c), ddbUser)
}

func (d *deviceDB) bindExternal(id string, at bindtoken.Attest) uint16 {
	d.t.Helper()
	tok, err := bindtoken.WrapExternal(testTokenKey, ddbUser, id, at, time.Now())
	if err != nil {
		d.t.Fatal(err)
	}
	return resultCode(dial(d.t, d.addr).RawBind(ddbDN, tok))
}

func (d *deviceDB) bindCodeAt(c devicecode.Code, at bindtoken.Attest) uint16 {
	d.t.Helper()
	tok, err := bindtoken.Wrap(testTokenKey, ddbUser, c.String(), at, time.Now())
	if err != nil {
		d.t.Fatal(err)
	}
	return resultCode(dial(d.t, d.addr).RawBind(ddbDN, tok))
}

func TestAMacAgainstTheDatabase(t *testing.T) {
	d := newDeviceDB(t)
	c := newCode(0x71)
	key1 := bytes.Repeat([]byte{0x41}, 32)
	key2 := bytes.Repeat([]byte{0x42}, 32)
	d.mintMac(c, key1, "C02DBMAC1")

	// Before any IMAP bind, SMTP is unavailable.
	if g := d.bindCodeAt(c, smtpFrom(macAddr)); g != goldapclient.LDAPResultUnavailable {
		t.Fatalf("SMTP before IMAP: result = %d, want unavailable", g)
	}
	// Wrong serial is refused even with the right key.
	if g := d.bindExternal(c.ID(), macIMAP(key1, "C02WRONG", macAddr)); g != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("EXTERNAL wrong serial: result = %d, want invalidCredentials", g)
	}
	// Code alone on IMAP is refused.
	if g := d.bindCodeAt(c, imapAt); g != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("IMAP code alone: result = %d, want invalidCredentials", g)
	}
	// EXTERNAL signs in, claims first use, and writes the liveness row.
	if g := d.bindExternal(c.ID(), macIMAP(key1, "C02DBMAC1", macAddr)); g != goldapclient.LDAPResultSuccess {
		t.Fatalf("EXTERNAL: result = %d, want success", g)
	}
	first, last := d.stamps(c)
	if first == nil || last == nil {
		t.Fatalf("EXTERNAL did not claim first use: %v, %v", first, last)
	}
	// 5-minute write throttle: an immediate second bind does not rewrite bound_at.
	var boundBefore, boundAfter string
	if err := d.admin.QueryRow(d.ctx, `SELECT bound_at::text FROM authd.mail_device_cert_binds WHERE device_id = $1::uuid`, c.ID()).Scan(&boundBefore); err != nil {
		t.Fatal(err)
	}
	if g := d.bindExternal(c.ID(), macIMAP(key1, "C02DBMAC1", macAddr)); g != goldapclient.LDAPResultSuccess {
		t.Fatalf("second EXTERNAL: result = %d", g)
	}
	if err := d.admin.QueryRow(d.ctx, `SELECT bound_at::text FROM authd.mail_device_cert_binds WHERE device_id = $1::uuid`, c.ID()).Scan(&boundAfter); err != nil {
		t.Fatal(err)
	}
	if boundBefore != boundAfter {
		t.Fatalf("liveness row rewritten inside 5 minutes: %s -> %s", boundBefore, boundAfter)
	}

	// SMTP from the same /32 succeeds; another /32 is unavailable.
	if g := d.bindCodeAt(c, smtpFrom(macAddr)); g != goldapclient.LDAPResultSuccess {
		t.Fatalf("SMTP same /32: result = %d, want success", g)
	}
	if g := d.bindCodeAt(c, smtpFrom(elseAddr)); g != goldapclient.LDAPResultUnavailable {
		t.Fatalf("SMTP other /32: result = %d, want unavailable", g)
	}

	// IPv6 /64 matching: IMAP on ::77 lets SMTP send from ::99 in the same /64,
	// not from another /64.
	if g := d.bindExternal(c.ID(), macIMAP(key1, "C02DBMAC1", macAddr6)); g != goldapclient.LDAPResultSuccess {
		t.Fatalf("EXTERNAL IPv6: result = %d", g)
	}
	sameNet6 := netip.MustParseAddr("2001:db8:1:2::99")
	otherNet6 := netip.MustParseAddr("2001:db8:1:3::99")
	if g := d.bindCodeAt(c, smtpFrom(sameNet6)); g != goldapclient.LDAPResultSuccess {
		t.Fatalf("SMTP same /64: result = %d, want success", g)
	}
	if g := d.bindCodeAt(c, smtpFrom(otherNet6)); g != goldapclient.LDAPResultUnavailable {
		t.Fatalf("SMTP other /64: result = %d, want unavailable", g)
	}

	// Past 75 minutes: SMTP is unavailable.
	d.exec(`UPDATE authd.mail_device_cert_binds SET bound_at = now() - interval '76 minutes' WHERE device_id = $1::uuid`, c.ID())
	if g := d.bindCodeAt(c, smtpFrom(macAddr)); g != goldapclient.LDAPResultUnavailable {
		t.Fatalf("SMTP after 75 minutes: result = %d, want unavailable", g)
	}

	// Refreshing after > 5 minutes moves bound_at forward and reopens SMTP.
	if g := d.bindExternal(c.ID(), macIMAP(key1, "C02DBMAC1", macAddr)); g != goldapclient.LDAPResultSuccess {
		t.Fatalf("EXTERNAL refresh: result = %d", g)
	}
	if g := d.bindCodeAt(c, smtpFrom(macAddr)); g != goldapclient.LDAPResultSuccess {
		t.Fatalf("SMTP after refresh: result = %d, want success", g)
	}

	// Key change invalidates old liveness rows even if they were not deleted.
	d.exec(`UPDATE authd.mail_devices SET cert_key_sha256 = $2::bytea WHERE id = $1::uuid`, c.ID(), key2)
	if g := d.bindCodeAt(c, smtpFrom(macAddr)); g != goldapclient.LDAPResultUnavailable {
		t.Fatalf("SMTP after key change: result = %d, want unavailable", g)
	}
	// New key on IMAP replaces the row even inside 5 minutes and reopens SMTP.
	if g := d.bindExternal(c.ID(), macIMAP(key2, "C02DBMAC1", macAddr)); g != goldapclient.LDAPResultSuccess {
		t.Fatalf("EXTERNAL new key: result = %d", g)
	}
	if g := d.bindCodeAt(c, smtpFrom(macAddr)); g != goldapclient.LDAPResultSuccess {
		t.Fatalf("SMTP under new key: result = %d, want success", g)
	}

	// 8-row per-device cap: adding 10 distinct addresses leaves at most 8.
	for i := 1; i <= 10; i++ {
		ip := netip.MustParseAddr(fmt.Sprintf("198.51.100.%d", 100+i))
		if g := d.bindExternal(c.ID(), macIMAP(key2, "C02DBMAC1", ip)); g != goldapclient.LDAPResultSuccess {
			t.Fatalf("EXTERNAL addr %s: %d", ip, g)
		}
	}
	var count int
	if err := d.admin.QueryRow(d.ctx, `SELECT count(*) FROM authd.mail_device_cert_binds WHERE device_id = $1::uuid`, c.ID()).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != projection.MacLiveRowsPerDevice {
		t.Fatalf("liveness row count = %d, want %d", count, projection.MacLiveRowsPerDevice)
	}

	// Clearing the key refuses both IMAP and SMTP with invalidCredentials.
	d.exec(`UPDATE authd.mail_devices SET cert_key_sha256 = NULL WHERE id = $1::uuid`, c.ID())
	if g := d.bindExternal(c.ID(), macIMAP(key2, "C02DBMAC1", macAddr)); g != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("EXTERNAL with cleared key: %d, want invalidCredentials", g)
	}
	if g := d.bindCodeAt(c, smtpFrom(macAddr)); g != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("SMTP with cleared key: %d, want invalidCredentials", g)
	}
}

func TestAMacSMTPSameAddressSwitchOffAgainstTheDatabase(t *testing.T) {
	d := newDeviceDB(t)
	d.addr = newFixtureOpts(t, fixtureOptions{
		store:         d.devices,
		resolver:      &passthrough.ManagedResolver{Unmanaged: &fakeVerifier{outcome: verify.Verified}},
		perMinute:     600,
		budget:        newFakeBudgetStore(),
		devices:       d.devices,
		deviceKeys:    deviceKeys(),
		macAnyAddress: true,
	})
	c := newCode(0x72)
	key := bytes.Repeat([]byte{0x43}, 32)
	d.mintMac(c, key, "C02DBMAC2")
	if g := d.bindExternal(c.ID(), macIMAP(key, "C02DBMAC2", macAddr6)); g != goldapclient.LDAPResultSuccess {
		t.Fatalf("EXTERNAL IPv6: %d", g)
	}
	if g := d.bindCodeAt(c, smtpFrom(elseAddr)); g != goldapclient.LDAPResultSuccess {
		t.Fatalf("SMTP over IPv4 with same-address off: %d, want success", g)
	}
}
