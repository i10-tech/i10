package ldapsrv_test

import (
	"context"
	"os"
	"sync"
	"testing"

	goldapclient "github.com/go-ldap/ldap/v3"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/i10-tech/i10/services/authd/internal/devicecode"
	"github.com/i10-tech/i10/services/authd/internal/passthrough"
	"github.com/i10-tech/i10/services/authd/internal/projection"
	"github.com/i10-tech/i10/services/authd/internal/verify"
)

// The device lane against Postgres, as the `authd` role, through the real
// server: the rules the database decides (the first-use window, concurrent
// first connections, the idle limit, the cascade, the gate's new column), with
// the rows written as the API would write them.

type deviceDB struct {
	t       *testing.T
	ctx     context.Context
	admin   *pgxpool.Pool
	addr    string
	clerk   *fakeVerifier
	devices *projection.Postgres
}

const (
	ddbUser   = "user_devdb_frank"
	ddbDN     = "uid=" + ddbUser + ",ou=people,dc=i10,dc=tech"
	ddbEmail  = "frank@devdb.test"
	ddbSlug   = "devdb-e2e"
	ddbConnID = "99999999-9999-4999-8999-999999999999"
)

func newDeviceDB(t *testing.T) *deviceDB {
	t.Helper()
	dsn, admin := os.Getenv("AUTHD_TEST_DATABASE_URL"), os.Getenv("AUTHD_TEST_ADMIN_DATABASE_URL")
	if dsn == "" || admin == "" {
		t.Skip("AUTHD_TEST_DATABASE_URL and AUTHD_TEST_ADMIN_DATABASE_URL are not both set")
	}
	ctx := context.Background()
	w, err := pgxpool.New(ctx, admin)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Close)
	d := &deviceDB{t: t, ctx: ctx, admin: w, clerk: &fakeVerifier{outcome: verify.Verified}}
	d.purge()
	t.Cleanup(d.purge)
	d.exec(`INSERT INTO core.tenants (slug, name, owner_clerk_user_id) VALUES ($1, 'Device e2e', $2)`, ddbSlug, ddbUser)
	d.exec(`INSERT INTO authd.accounts (clerk_user_id, email, active, tenant_id)
		SELECT $1, $2, true, id FROM core.tenants WHERE slug = $3`, ddbUser, ddbEmail, ddbSlug)

	store, err := projection.NewPostgres(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(store.Close)
	d.devices = store
	d.addr = newFixtureOpts(t, fixtureOptions{
		store:      store,
		resolver:   &passthrough.ManagedResolver{Unmanaged: d.clerk},
		perMinute:  600,
		budget:     newFakeBudgetStore(),
		devices:    store,
		deviceKeys: deviceKeys(),
	})
	return d
}

func (d *deviceDB) purge() {
	for _, q := range []string{
		`DELETE FROM authd.accounts WHERE starts_with(clerk_user_id, 'user_devdb_')`,
		`DELETE FROM core.tenants WHERE slug = '` + ddbSlug + `'`,
	} {
		if _, err := d.admin.Exec(d.ctx, q); err != nil {
			d.t.Logf("purge: %v", err)
		}
	}
}

func (d *deviceDB) exec(q string, args ...any) {
	d.t.Helper()
	if _, err := d.admin.Exec(d.ctx, q, args...); err != nil {
		d.t.Fatalf("%s: %v", q, err)
	}
}

// mint writes a device row for c, as the API's store function would: the
// account's address and workspace, the keyed hash under kid. created is SQL.
func (d *deviceDB) mint(c devicecode.Code, kid int, created string) {
	d.t.Helper()
	d.exec(`INSERT INTO authd.mail_devices (id, clerk_user_id, email, tenant_id, platform, code_hash, code_kid, created_by, created_at)
		SELECT $1::uuid, a.clerk_user_id, a.email, a.tenant_id, 'ios', $2, $3, 'test', `+created+`
		FROM authd.accounts a WHERE a.clerk_user_id = $4`, c.ID(), devicecode.Hash(deviceKey, c), kid, ddbUser)
}

func (d *deviceDB) bind(password string) uint16 {
	d.t.Helper()
	if err := dial(d.t, d.addr).Bind(ddbDN, password); err != nil {
		return resultCode(err)
	}
	return goldapclient.LDAPResultSuccess
}

func (d *deviceDB) stamps(c devicecode.Code) (first, last *string) {
	d.t.Helper()
	if err := d.admin.QueryRow(d.ctx, `SELECT first_used_at::text, last_used_at::text FROM authd.mail_devices WHERE id = $1::uuid`,
		c.ID()).Scan(&first, &last); err != nil {
		d.t.Fatal(err)
	}
	return first, last
}

func TestADeviceCodeAgainstTheDatabase(t *testing.T) {
	d := newDeviceDB(t)
	c := newCode(0x51)
	d.mint(c, 4, "now()")

	// ⚠ Apple Mail's first connections arrive together: all of them sign in, and
	// the first-use stamp is written once.
	var wg sync.WaitGroup
	got := make([]uint16, 6)
	for i := range got {
		wg.Add(1)
		go func() { defer wg.Done(); got[i] = d.bind(c.String()) }()
	}
	wg.Wait()
	for i, g := range got {
		if g != goldapclient.LDAPResultSuccess {
			t.Fatalf("concurrent first bind %d: result = %d, want success (all: %v)", i, g, got)
		}
	}
	first, last := d.stamps(c)
	if first == nil || last == nil || *first != *last {
		t.Fatalf("after the first use: first_used_at %v, last_used_at %v", first, last)
	}
	if d.clerk.callCount() != 0 {
		t.Fatalf("clerk called %d times for device codes", d.clerk.callCount())
	}

	// A day later the next bind moves last_used_at, and only that.
	d.exec(`UPDATE authd.mail_devices SET first_used_at = first_used_at - interval '2 days',
		last_used_at = last_used_at - interval '2 days' WHERE id = $1::uuid`, c.ID())
	before, _ := d.stamps(c)
	if g := d.bind(c.String()); g != goldapclient.LDAPResultSuccess {
		t.Fatalf("a day later: result = %d", g)
	}
	after, touched := d.stamps(c)
	if *after != *before || *touched == *after {
		t.Fatalf("the touch: first %s -> %s, last %s", *before, *after, *touched)
	}

	// 90 days without a sign-in: refused, by the database's clock.
	d.exec(`UPDATE authd.mail_devices SET last_used_at = now() - interval '91 days' WHERE id = $1::uuid`, c.ID())
	if g := d.bind(c.String()); g != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("idle 91 days: result = %d, want invalidCredentials", g)
	}
	d.exec(`UPDATE authd.mail_devices SET last_used_at = now() - interval '89 days' WHERE id = $1::uuid`, c.ID())
	if g := d.bind(c.String()); g != goldapclient.LDAPResultSuccess {
		t.Fatalf("idle 89 days: result = %d, want success", g)
	}

	// A revoke is a DELETE: the very next bind is refused.
	d.exec(`DELETE FROM authd.mail_devices WHERE id = $1::uuid`, c.ID())
	if g := d.bind(c.String()); g != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("after the revoke: result = %d, want invalidCredentials", g)
	}
}

// ⚠ An unused code lives ten minutes from its mint, by the database's clock, and
// a refused claim writes nothing.
func TestAnUnusedDeviceCodeExpiresAfterTenMinutes(t *testing.T) {
	d := newDeviceDB(t)
	stale, fresh := newCode(0x52), newCode(0x53)
	d.mint(stale, 4, "now() - interval '10 minutes 1 second'")
	d.mint(fresh, 4, "now() - interval '9 minutes 50 seconds'")
	if g := d.bind(stale.String()); g != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("an unused code 10 minutes old: result = %d, want invalidCredentials", g)
	}
	if first, _ := d.stamps(stale); first != nil {
		t.Fatal("the refused first use was stamped")
	}
	if g := d.bind(fresh.String()); g != goldapclient.LDAPResultSuccess {
		t.Fatalf("an unused code just under 10 minutes old: result = %d, want success", g)
	}
	// Once used it no longer has a ten-minute life.
	d.exec(`UPDATE authd.mail_devices SET created_at = now() - interval '1 day' WHERE id = $1::uuid`, fresh.ID())
	if g := d.bind(fresh.String()); g != goldapclient.LDAPResultSuccess {
		t.Fatalf("a used code a day after its mint: result = %d, want success", g)
	}
}

// ⚠ A RECREATED ADDRESS. The mailbox deleted takes its devices (the foreign key
// cascades), so a code from before the delete opens nothing on the mailbox
// made again with the same address; and a device minted for an address the
// account has since left is refused.
func TestARecreatedOrChangedAddressRefusesTheOldCode(t *testing.T) {
	d := newDeviceDB(t)
	c := newCode(0x54)
	d.mint(c, 4, "now()")
	if g := d.bind(c.String()); g != goldapclient.LDAPResultSuccess {
		t.Fatalf("before: result = %d", g)
	}
	d.exec(`DELETE FROM authd.accounts WHERE clerk_user_id = $1`, ddbUser)
	d.exec(`INSERT INTO authd.accounts (clerk_user_id, email, active, tenant_id)
		SELECT $1, $2, true, id FROM core.tenants WHERE slug = $3`, ddbUser, ddbEmail, ddbSlug)
	if g := d.bind(c.String()); g != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("on the recreated mailbox: result = %d, want invalidCredentials", g)
	}

	moved := newCode(0x55)
	d.mint(moved, 4, "now()")
	d.exec(`UPDATE authd.accounts SET email = 'frank2@devdb.test' WHERE clerk_user_id = $1`, ddbUser)
	if g := d.bind(moved.String()); g != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("a device minted for the old address: result = %d, want invalidCredentials", g)
	}
	// The workspace too: the account moved to another (or to none).
	d.exec(`UPDATE authd.accounts SET email = $2 WHERE clerk_user_id = $1`, ddbUser, ddbEmail)
	if g := d.bind(moved.String()); g != goldapclient.LDAPResultSuccess {
		t.Fatalf("back on its address: result = %d", g)
	}
	d.exec(`UPDATE authd.accounts SET tenant_id = NULL WHERE clerk_user_id = $1`, ddbUser)
	if g := d.bind(moved.String()); g != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("the mailbox out of the workspace the device was minted in: result = %d, want invalidCredentials", g)
	}
}

// A key id the ring does not hold is our fault: unavailable, never a wrong code.
func TestAnUnknownKeyIDIsUnavailable(t *testing.T) {
	d := newDeviceDB(t)
	c := newCode(0x56)
	d.mint(c, 9, "now()")
	if g := d.bind(c.String()); g != goldapclient.LDAPResultUnavailable {
		t.Fatalf("result = %d, want unavailable", g)
	}
	if first, _ := d.stamps(c); first != nil {
		t.Fatal("a code under an unknown key was stamped")
	}
}

// ⚠ THE NEW GATE INPUT, FROM THE REAL COLUMN. A managed account's device code
// works while its connection's `authd.passthrough_versions.active` is true or
// null (an older API pod's row, which refuses nothing), and is held while it
// is false.
func TestADisabledConnectionHoldsItsManagedAccountsDeviceCodes(t *testing.T) {
	d := newDeviceDB(t)
	d.exec(`INSERT INTO identity.connections (id, tenant_id, name, protocol, status)
		SELECT $1::uuid, id, 'Entra', 'saml', 'active' FROM core.tenants WHERE slug = $2`, ddbConnID, ddbSlug)
	d.exec(`INSERT INTO identity.managed_accounts (clerk_user_id, tenant_id, connection_id, reason)
		SELECT $1, id, $2::uuid, 'scim' FROM core.tenants WHERE slug = $3`, ddbUser, ddbConnID, ddbSlug)
	d.exec(`INSERT INTO authd.managed_accounts (clerk_user_id, connection_id) VALUES ($1, $2::uuid)`, ddbUser, ddbConnID)
	d.exec(`INSERT INTO authd.passthrough_versions (connection_id, version, fingerprint, active) VALUES ($1::uuid, 1, 'x', true)`, ddbConnID)
	c := newCode(0x57)
	d.mint(c, 4, "now()")

	for _, step := range []struct {
		active string
		want   uint16
	}{
		{"true", goldapclient.LDAPResultSuccess},
		{"false", goldapclient.LDAPResultInvalidCredentials},
		{"NULL", goldapclient.LDAPResultSuccess},
		{"false", goldapclient.LDAPResultInvalidCredentials},
		{"true", goldapclient.LDAPResultSuccess},
	} {
		d.exec(`UPDATE authd.passthrough_versions SET active = `+step.active+` WHERE connection_id = $1::uuid`, ddbConnID)
		if g := d.bind(c.String()); g != step.want {
			t.Fatalf("active = %s: result = %d, want %d", step.active, g, step.want)
		}
	}
	if d.clerk.callCount() != 0 {
		t.Fatalf("clerk called %d times for a managed account", d.clerk.callCount())
	}
}
