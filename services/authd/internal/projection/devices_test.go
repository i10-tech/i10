package projection

import (
	"bytes"
	"context"
	"encoding/hex"
	"fmt"
	"net/netip"
	"os"
	"slices"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// deviceWorld is a scratch fixture for `authd.mail_devices`: accounts and
// devices written as the owner, read back as authd's and the front's roles.
type deviceWorld struct {
	t     *testing.T
	ctx   context.Context
	admin *pgxpool.Pool
}

const devicePrefix = "user_devtest_"

func newDeviceWorld(t *testing.T) *deviceWorld {
	t.Helper()
	admin := os.Getenv("AUTHD_TEST_ADMIN_DATABASE_URL")
	if admin == "" || os.Getenv("AUTHD_TEST_DATABASE_URL") == "" || os.Getenv("AUTHD_TEST_MAILFRONT_DATABASE_URL") == "" {
		t.Skip("AUTHD_TEST_DATABASE_URL, AUTHD_TEST_MAILFRONT_DATABASE_URL and AUTHD_TEST_ADMIN_DATABASE_URL are not all set")
	}
	ctx := context.Background()
	w, err := pgxpool.New(ctx, admin)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Close)
	dw := &deviceWorld{t: t, ctx: ctx, admin: w}
	dw.purge()
	t.Cleanup(dw.purge)
	return dw
}

// purge: the devices go with their accounts (ON DELETE CASCADE).
func (dw *deviceWorld) purge() {
	if _, err := dw.admin.Exec(dw.ctx, `DELETE FROM authd.accounts WHERE starts_with(clerk_user_id, $1)`, devicePrefix); err != nil {
		dw.t.Logf("purge: %v", err)
	}
}

func (dw *deviceWorld) exec(q string, args ...any) {
	dw.t.Helper()
	if _, err := dw.admin.Exec(dw.ctx, q, args...); err != nil {
		dw.t.Fatalf("%s: %v", q, err)
	}
}

// account writes an active account in workspace tenant ("" for none).
func (dw *deviceWorld) account(id, email, tenant string) {
	dw.t.Helper()
	dw.exec(`INSERT INTO authd.accounts (clerk_user_id, email, active, tenant_id) VALUES ($1, $2, true, nullif($3, '')::uuid)`,
		devicePrefix+id, email, tenant)
}

// device writes a device row and returns its id. extra is SQL for the
// remaining columns' values, as `created_at`, `first_used_at`, `last_used_at`.
func (dw *deviceWorld) device(account, email, tenant, platform string, times ...string) string {
	dw.t.Helper()
	created, first, last := "now()", "NULL", "NULL"
	if len(times) == 3 {
		created, first, last = times[0], times[1], times[2]
	}
	var id string
	if err := dw.admin.QueryRow(dw.ctx, `INSERT INTO authd.mail_devices
		(clerk_user_id, email, tenant_id, platform, device_name, model, serial, code_hash, code_kid, created_by,
		 created_at, first_used_at, last_used_at)
		VALUES ($1, $2, nullif($3, '')::uuid, $4, 'Phone', 'iPhone17,1', 'SER1', '\x01'::bytea, 1, 'test', `+
		created+`, `+first+`, `+last+`) RETURNING id::text`,
		devicePrefix+account, email, tenant, platform).Scan(&id); err != nil {
		dw.t.Fatal(err)
	}
	return id
}

func (dw *deviceWorld) store(env string) *Postgres {
	dw.t.Helper()
	s, err := NewPostgres(dw.ctx, os.Getenv(env))
	if err != nil {
		dw.t.Fatal(err)
	}
	dw.t.Cleanup(s.Close)
	return s
}

const tenantA = "aaaaaaaa-0000-4000-8000-00000000000a"

// 32-byte SHA-256 values as bytea literals, for the key/nonce columns' length
// CHECKs and unique indexes.
const (
	key32  = `\x` + "0101010101010101010101010101010101010101010101010101010101010101"
	key32b = `\x` + "0202020202020202020202020202020202020202020202020202020202020202"
)

// The sweep returns one row per account, however many of its devices are asked
// about, with only the devices asked about that still belong to it.
func TestTheSweepReadsEachAccountOnceWithItsDevices(t *testing.T) {
	dw := newDeviceWorld(t)
	dw.account("alice", "alice@dev.test", tenantA)
	dw.account("bob", "bob@dev.test", "")
	a1 := dw.device("alice", "alice@dev.test", tenantA, "ios")
	a2 := dw.device("alice", "alice@dev.test", tenantA, "ipados")
	a3 := dw.device("alice", "alice@dev.test", tenantA, "ios") // not asked about
	b1 := dw.device("bob", "bob@dev.test", "", "ios")
	front := dw.store("AUTHD_TEST_MAILFRONT_DATABASE_URL")

	gone := "00000000-0000-4000-8000-000000000000"
	rows, _, err := front.AccountsByUIDs(dw.ctx, []string{devicePrefix + "alice", devicePrefix + "bob"}, []string{a1, a2, b1, gone})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("%d rows, want one per account", len(rows))
	}
	byID := map[string]Account{}
	for _, r := range rows {
		byID[r.ClerkUserID] = r
	}
	alice, bob := byID[devicePrefix+"alice"], byID[devicePrefix+"bob"]
	var ids []string
	for _, d := range alice.Devices {
		ids = append(ids, d.ID)
		if d.ClerkUserID != alice.ClerkUserID || d.Email != "alice@dev.test" || d.TenantID != tenantA {
			t.Fatalf("alice's device read as %+v", d)
		}
	}
	if want := []string{a1, a2}; !slices.Equal(ids, sorted(want)) {
		t.Fatalf("alice's devices %v, want %v (and never %s, which nobody asked about)", ids, sorted(want), a3)
	}
	if alice.TenantID != tenantA || bob.TenantID != "" {
		t.Fatalf("tenants: alice %q, bob %q", alice.TenantID, bob.TenantID)
	}
	if len(bob.Devices) != 1 || bob.Devices[0].ID != b1 || bob.Devices[0].Platform != "ios" || bob.Devices[0].TenantID != "" {
		t.Fatalf("bob's devices %+v", bob.Devices)
	}

	// A device re-pointed at another person comes back on that person's row only.
	dw.exec(`UPDATE authd.mail_devices SET clerk_user_id = $1 WHERE id = $2::uuid`, devicePrefix+"bob", a1)
	rows, _, err = front.AccountsByUIDs(dw.ctx, []string{devicePrefix + "alice"}, []string{a1})
	if err != nil || len(rows) != 1 || len(rows[0].Devices) != 0 {
		t.Fatalf("after the device moved: %+v, %v; want alice with no device", rows, err)
	}
}

// What the bind reads, and the clock rules, judged by the server's clock.
func TestTheBindsDeviceReadsAndWrites(t *testing.T) {
	dw := newDeviceWorld(t)
	dw.account("carol", "carol@dev.test", tenantA)
	authd := dw.store("AUTHD_TEST_DATABASE_URL")

	fresh := dw.device("carol", "carol@dev.test", tenantA, "ios")
	stale := dw.device("carol", "carol@dev.test", tenantA, "ios", "now() - interval '11 minutes'", "NULL", "NULL")
	idle := dw.device("carol", "carol@dev.test", tenantA, "ios",
		"now() - interval '200 days'", "now() - interval '200 days'", "now() - interval '91 days'")
	due := dw.device("carol", "carol@dev.test", tenantA, "ios",
		"now() - interval '30 days'", "now() - interval '30 days'", "now() - interval '2 days'")
	today := dw.device("carol", "carol@dev.test", tenantA, "ios",
		"now() - interval '30 days'", "now() - interval '30 days'", "now() - interval '1 hour'")

	read := func(id string) *DeviceCredential {
		t.Helper()
		d, err := authd.DeviceByID(dw.ctx, id)
		if err != nil || d == nil {
			t.Fatalf("DeviceByID(%s) = %v, %v", id, d, err)
		}
		return d
	}
	if d := read(fresh); d.Used || d.Idle || d.TouchDue || d.CodeKID != 1 || len(d.CodeHash) != 1 ||
		d.Email != "carol@dev.test" || d.TenantID != tenantA || d.Platform != "ios" || d.ID != fresh {
		t.Fatalf("a fresh device read as %+v", d)
	}
	if d := read(idle); !d.Used || !d.Idle {
		t.Fatalf("a device last used 91 days ago read as %+v", d)
	}
	if d := read(due); !d.Used || d.Idle || !d.TouchDue {
		t.Fatalf("a device last used 2 days ago read as %+v", d)
	}
	if d := read(today); d.TouchDue {
		t.Fatalf("a device used an hour ago read as due a touch: %+v", d)
	}
	if d, err := authd.DeviceByID(dw.ctx, "00000000-0000-4000-8000-000000000000"); d != nil || err != nil {
		t.Fatalf("no such device = %v, %v", d, err)
	}

	// ⚠ The first-use window: ten minutes from created_at, by the server's clock.
	if ok, err := authd.ClaimDeviceFirstUse(dw.ctx, stale); ok || err != nil {
		t.Fatalf("an unused code past its ten minutes was claimed: %v, %v", ok, err)
	}
	if d := read(stale); d.Used {
		t.Fatal("the refused claim wrote first_used_at")
	}

	// ⚠ Concurrent first connections all pass, and the first stamp stands.
	var wg sync.WaitGroup
	results := make([]bool, 8)
	for i := range results {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ok, err := authd.ClaimDeviceFirstUse(dw.ctx, fresh)
			results[i] = ok && err == nil
		}()
	}
	wg.Wait()
	if slices.Contains(results, false) {
		t.Fatalf("concurrent first uses: %v, want all claimed", results)
	}
	var stamps int
	if err := dw.admin.QueryRow(dw.ctx, `SELECT count(*) FROM authd.mail_devices
		WHERE id = $1::uuid AND first_used_at IS NOT NULL AND first_used_at = last_used_at`, fresh).Scan(&stamps); err != nil || stamps != 1 {
		t.Fatalf("after the claims: %d rows with one first stamp (%v)", stamps, err)
	}
	// A used code is claimable again past its ten minutes: the window is for
	// codes never used.
	dw.exec(`UPDATE authd.mail_devices SET created_at = now() - interval '1 day' WHERE id = $1::uuid`, fresh)
	if ok, err := authd.ClaimDeviceFirstUse(dw.ctx, fresh); !ok || err != nil {
		t.Fatalf("a used code's claim: %v, %v", ok, err)
	}

	// The touch moves last_used_at only once it is a day old.
	if err := authd.TouchDevice(dw.ctx, due); err != nil {
		t.Fatal(err)
	}
	if d := read(due); d.TouchDue {
		t.Fatal("the touch did not move last_used_at")
	}
	var before, after string
	_ = dw.admin.QueryRow(dw.ctx, `SELECT last_used_at::text FROM authd.mail_devices WHERE id = $1::uuid`, today).Scan(&before)
	if err := authd.TouchDevice(dw.ctx, today); err != nil {
		t.Fatal(err)
	}
	_ = dw.admin.QueryRow(dw.ctx, `SELECT last_used_at::text FROM authd.mail_devices WHERE id = $1::uuid`, today).Scan(&after)
	if before != after {
		t.Fatalf("a device used an hour ago was touched: %s -> %s", before, after)
	}
}

// ⚠ THE TWO ROLES' GRANTS ON THE DEVICE TABLES. The front reads exactly the five
// columns the gate matches plus the bound key, and the Mac liveness rows, and
// writes nothing; authd reads the row, writes only the two clock stamps, and
// keeps the liveness rows. Neither may touch a certificate permit, which only
// the API's CA webhook handlers read. A grant wider than any of that fails here.
func TestTheDeviceTableGrants(t *testing.T) {
	dw := newDeviceWorld(t)
	dw.account("dave", "dave@dev.test", tenantA)
	id := dw.device("dave", "dave@dev.test", tenantA, "ios")
	front := dw.store("AUTHD_TEST_MAILFRONT_DATABASE_URL")
	authd := dw.store("AUTHD_TEST_DATABASE_URL")

	if _, err := front.Pool().Exec(dw.ctx, `SELECT id, clerk_user_id, email, tenant_id, platform, cert_key_sha256 FROM authd.mail_devices WHERE id = $1::uuid`, id); err != nil {
		t.Fatalf("the front cannot read the gate's columns: %v", err)
	}
	if _, err := front.Pool().Exec(dw.ctx, `SELECT device_id, addr, key_sha256, bound_at FROM authd.mail_device_cert_binds`); err != nil {
		t.Fatalf("the front cannot read the Mac liveness rows: %v", err)
	}
	for _, q := range []string{
		`SELECT code_hash FROM authd.mail_devices`,
		`SELECT code_kid FROM authd.mail_devices`,
		`SELECT serial FROM authd.mail_devices`,
		`SELECT device_name FROM authd.mail_devices`,
		`SELECT model FROM authd.mail_devices`,
		`SELECT created_by FROM authd.mail_devices`,
		`SELECT first_used_at FROM authd.mail_devices`,
		`SELECT * FROM authd.mail_devices`,
		`UPDATE authd.mail_devices SET first_used_at = now(), last_used_at = now() WHERE id = '` + id + `'`,
		`UPDATE authd.mail_devices SET email = email WHERE id = '` + id + `'`,
		`DELETE FROM authd.mail_devices WHERE id = '` + id + `'`,
		`INSERT INTO authd.mail_devices (clerk_user_id, email, platform, code_hash, code_kid, created_by)
		 VALUES ('` + devicePrefix + `dave', 'dave@dev.test', 'ios', '\x00', 1, 'front')`,
		`TRUNCATE authd.mail_devices`,
		`INSERT INTO authd.mail_device_cert_binds (device_id, addr, key_sha256)
		 VALUES ('` + id + `', '192.0.2.1/32', '` + key32 + `')`,
		`UPDATE authd.mail_device_cert_binds SET bound_at = now()`,
		`DELETE FROM authd.mail_device_cert_binds`,
		`SELECT id FROM authd.mail_device_cert_permits`,
		`DELETE FROM authd.mail_device_cert_permits`,
	} {
		if _, err := front.Pool().Exec(dw.ctx, q); err == nil {
			t.Errorf("the mailfront role may run %q", q)
		}
	}

	if d, err := authd.DeviceByID(dw.ctx, id); err != nil || d == nil {
		t.Fatalf("authd cannot read its device: %v, %v", d, err)
	}
	if _, err := authd.Pool().Exec(dw.ctx, `UPDATE authd.mail_devices SET first_used_at = now(), last_used_at = now() WHERE id = $1::uuid`, id); err != nil {
		t.Fatalf("authd cannot write the clock stamps: %v", err)
	}
	for _, col := range []string{"clerk_user_id", "email", "tenant_id", "platform", "device_name", "model", "serial",
		"cert_key_sha256", "code_hash", "code_kid", "created_by", "created_at", "id"} {
		q := `UPDATE authd.mail_devices SET ` + col + ` = ` + col + ` WHERE id = '` + id + `'`
		if _, err := authd.Pool().Exec(dw.ctx, q); err == nil {
			t.Errorf("the authd role may run %q", q)
		}
	}
	for _, q := range []string{
		`DELETE FROM authd.mail_devices WHERE id = '` + id + `'`,
		`INSERT INTO authd.mail_devices (clerk_user_id, email, platform, code_hash, code_kid, created_by)
		 VALUES ('` + devicePrefix + `dave', 'dave@dev.test', 'ios', '\x00', 1, 'authd')`,
		`TRUNCATE authd.mail_devices`,
		`SELECT id FROM authd.mail_device_cert_permits`,
		`INSERT INTO authd.mail_device_cert_permits (clerk_user_id, kind, serial, challenge_hash, expires_at)
		 VALUES ('` + devicePrefix + `dave', 'scep', 'S', '` + key32 + `', now() + interval '10 minutes')`,
		`UPDATE authd.mail_device_cert_permits SET status = 'expired'`,
		`DELETE FROM authd.mail_device_cert_permits`,
		`TRUNCATE authd.mail_device_cert_binds`,
	} {
		if _, err := authd.Pool().Exec(dw.ctx, q); err == nil {
			t.Errorf("the authd role may run %q", q)
		}
	}

	// The liveness rows are authd's to keep: the upsert per bind, the throttled
	// refresh, and the per-device cap's delete.
	for _, q := range []string{
		`INSERT INTO authd.mail_device_cert_binds (device_id, addr, key_sha256)
		 VALUES ('` + id + `', '192.0.2.1/32', '` + key32 + `')
		 ON CONFLICT (device_id, addr) DO UPDATE SET key_sha256 = excluded.key_sha256, bound_at = now()`,
		`SELECT bound_at FROM authd.mail_device_cert_binds WHERE device_id = '` + id + `'`,
		`UPDATE authd.mail_device_cert_binds SET bound_at = now() WHERE device_id = '` + id + `'`,
		`DELETE FROM authd.mail_device_cert_binds WHERE device_id = '` + id + `'`,
	} {
		if _, err := authd.Pool().Exec(dw.ctx, q); err != nil {
			t.Errorf("the authd role cannot run %q: %v", q, err)
		}
	}
}

// The table's own rules: the person id cannot move under a device, an account
// deleted takes its devices, and the CHECKs hold.
func TestTheDeviceTableConstraints(t *testing.T) {
	dw := newDeviceWorld(t)
	dw.account("erin", "erin@dev.test", "")
	id := dw.device("erin", "erin@dev.test", "", "ios")
	for _, q := range []string{
		`UPDATE authd.accounts SET clerk_user_id = '` + devicePrefix + `erin2' WHERE clerk_user_id = '` + devicePrefix + `erin'`,
		`UPDATE authd.mail_devices SET email = 'Erin@dev.test' WHERE id = '` + id + `'`,
		`UPDATE authd.mail_devices SET platform = 'android' WHERE id = '` + id + `'`,
		`UPDATE authd.mail_devices SET code_kid = 256 WHERE id = '` + id + `'`,
		`UPDATE authd.mail_devices SET first_used_at = now() WHERE id = '` + id + `'`,
		`UPDATE authd.mail_devices SET clerk_user_id = 'user_nobody' WHERE id = '` + id + `'`,
		`UPDATE authd.mail_devices SET cert_key_sha256 = '\x01' WHERE id = '` + id + `'`,
	} {
		if _, err := dw.admin.Exec(dw.ctx, q); err == nil {
			t.Errorf("the table accepted %q", q)
		}
	}
	dw.exec(`UPDATE authd.mail_devices SET cert_key_sha256 = $2::bytea WHERE id = $1::uuid`, id, key32)

	// A device takes its liveness rows and permits with it, and an account its
	// SCEP permits, which name no device.
	other := dw.device("erin", "erin@dev.test", "", "macos")
	for i, dev := range []string{id, other} {
		nonce := key32
		if i == 1 {
			nonce = key32b
		}
		dw.exec(`INSERT INTO authd.mail_device_cert_binds (device_id, addr, key_sha256) VALUES ($1::uuid, '2001:db8::/64', $2::bytea)`, dev, key32)
		dw.exec(`INSERT INTO authd.mail_device_cert_permits (clerk_user_id, device_id, kind, serial, nonce_sha256, expires_at)
			VALUES ($1, $2::uuid, 'acme', $3, $4::bytea, now() + interval '10 minutes')`, devicePrefix+"erin", dev, "SER-"+dev, nonce)
	}
	var enrollID string
	if err := dw.admin.QueryRow(dw.ctx, `INSERT INTO authd.mail_device_enrollments
		(clerk_user_id, email, expected_epoch, token_sha256, created_by, expires_at)
		VALUES ($1, 'erin@dev.test', 0, $2::bytea, 'test', now() + interval '10 minutes')
		RETURNING id::text`, devicePrefix+"erin", key32).Scan(&enrollID); err != nil {
		t.Fatal(err)
	}
	dw.exec(`INSERT INTO authd.mail_device_cert_permits (clerk_user_id, enrollment_id, kind, serial, challenge_hash, expires_at)
		VALUES ($1, $2::uuid, 'scep', 'S', $3::bytea, now() + interval '10 minutes')`, devicePrefix+"erin", enrollID, key32)
	count := func(q string, args ...any) int {
		t.Helper()
		var n int
		if err := dw.admin.QueryRow(dw.ctx, q, args...).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	dw.exec(`DELETE FROM authd.mail_devices WHERE id = $1::uuid`, other)
	if n := count(`SELECT count(*) FROM authd.mail_device_cert_binds WHERE device_id = $1::uuid`, other); n != 0 {
		t.Fatalf("the device's delete left %d liveness rows", n)
	}
	if n := count(`SELECT count(*) FROM authd.mail_device_cert_permits WHERE device_id = $1::uuid`, other); n != 0 {
		t.Fatalf("the device's delete left %d permits", n)
	}

	dw.exec(`DELETE FROM authd.accounts WHERE clerk_user_id = $1`, devicePrefix+"erin")
	if n := count(`SELECT count(*) FROM authd.mail_devices WHERE id = $1::uuid`, id); n != 0 {
		t.Fatalf("the account's delete left %d devices", n)
	}
	if n := count(`SELECT count(*) FROM authd.mail_device_cert_binds WHERE device_id = $1::uuid`, id); n != 0 {
		t.Fatalf("the account's delete left %d liveness rows", n)
	}
	if n := count(`SELECT count(*) FROM authd.mail_device_cert_permits WHERE clerk_user_id = $1`, devicePrefix+"erin"); n != 0 {
		t.Fatalf("the account's delete left %d permits", n)
	}
}

func TestMacLiveRowsConstantMatchesSQL(t *testing.T) {
	if macLiveRowsSQL != strconv.Itoa(MacLiveRowsPerDevice) {
		t.Fatalf("macLiveRowsSQL = %q, MacLiveRowsPerDevice = %d", macLiveRowsSQL, MacLiveRowsPerDevice)
	}
}

func TestMacInstallGraceConstantsMatchSQL(t *testing.T) {
	if want := strconv.FormatInt(MacInstallGraceDuration.Milliseconds(), 10); macInstallGraceMaxMS != want {
		t.Fatalf("macInstallGraceMaxMS = %q, want %q", macInstallGraceMaxMS, want)
	}
	wantWindow := fmt.Sprintf("interval '%d minutes'", int(MacInstallGraceDuration/time.Minute))
	if MacInstallGraceWindow != wantWindow {
		t.Fatalf("MacInstallGraceWindow = %q, want %q", MacInstallGraceWindow, wantWindow)
	}
}

func TestMacLivePrefix(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"203.0.113.7", "203.0.113.7/32"},
		{"::ffff:203.0.113.7", "203.0.113.7/32"},
		{"2001:db8:1:2:abcd:ef01:2345:6789", "2001:db8:1:2::/64"},
		{"fe80::1%eth0", "fe80::/64"},
	}
	for _, tc := range cases {
		got := MacLivePrefix(netip.MustParseAddr(tc.in))
		if got.String() != tc.want {
			t.Errorf("MacLivePrefix(%s) = %s, want %s", tc.in, got, tc.want)
		}
	}
}

// DeviceByCertKey, DeviceGate, SweepQuery's cert_key_sha256, and the Mac
// liveness rows (RecordMacLive, MacLive, MacLiveFamilies) against Postgres as
// the real roles.
func TestMacDeviceQueriesAndLiveness(t *testing.T) {
	dw := newDeviceWorld(t)
	dw.account("mac", "mac@dev.test", tenantA)
	id := dw.device("mac", "mac@dev.test", tenantA, "macos")
	key1, _ := hex.DecodeString(key32[2:])
	key2, _ := hex.DecodeString(key32b[2:])
	dw.exec(`UPDATE authd.mail_devices SET cert_key_sha256 = $2::bytea WHERE id = $1::uuid`, id, key32)

	front := dw.store("AUTHD_TEST_MAILFRONT_DATABASE_URL")
	authd := dw.store("AUTHD_TEST_DATABASE_URL")

	// DeviceByCertKey and DeviceGate as mailfront.
	if d, err := front.DeviceByCertKey(dw.ctx, key1); err != nil || d == nil || d.ID != id || !bytes.Equal(d.CertKey, key1) {
		t.Fatalf("DeviceByCertKey(key1) = %+v, %v", d, err)
	}
	if d, err := front.DeviceByCertKey(dw.ctx, key2); err != nil || d != nil {
		t.Fatalf("DeviceByCertKey(unbound) = %+v, %v", d, err)
	}
	if d, err := front.DeviceByCertKey(dw.ctx, []byte{1, 2}); err != nil || d != nil {
		t.Fatalf("DeviceByCertKey(short) = %+v, %v", d, err)
	}
	if d, err := front.DeviceGate(dw.ctx, id); err != nil || d == nil || !bytes.Equal(d.CertKey, key1) {
		t.Fatalf("DeviceGate(id) = %+v, %v", d, err)
	}
	if d, err := front.DeviceGate(dw.ctx, "not-a-uuid"); err != nil || d != nil {
		t.Fatalf("DeviceGate(not-a-uuid) = %+v, %v; want nil, nil", d, err)
	}

	// SweepQuery returns the bound key on the account's device slice.
	rows, _, err := front.AccountsByUIDs(dw.ctx, []string{devicePrefix + "mac"}, []string{id})
	if err != nil || len(rows) != 1 || len(rows[0].Devices) != 1 || !bytes.Equal(rows[0].Devices[0].CertKey, key1) {
		t.Fatalf("AccountsByUIDs = %+v, %v", rows, err)
	}

	// RecordMacLive writes as authd; MacLive reads as mailfront and authd.
	p4 := MacLivePrefix(netip.MustParseAddr("198.51.100.5"))
	p6 := MacLivePrefix(netip.MustParseAddr("2001:db8:abcd:1::42"))
	if err := authd.RecordMacLive(dw.ctx, id, p4, key1); err != nil {
		t.Fatal(err)
	}
	if live, err := front.MacLive(dw.ctx, id, p4, key1); err != nil || !live {
		t.Fatalf("MacLive(p4, key1) = %v, %v", live, err)
	}
	if live, err := front.MacLive(dw.ctx, id, p4, key2); err != nil || live {
		t.Fatalf("MacLive(p4, key2) = %v, %v", live, err)
	}
	if live, err := front.MacLive(dw.ctx, id, p6, key1); err != nil || live {
		t.Fatalf("MacLive(p6, key1) = %v, %v", live, err)
	}
	// Any-address mode (zero Prefix).
	if live, err := front.MacLive(dw.ctx, id, netip.Prefix{}, key1); err != nil || !live {
		t.Fatalf("MacLive(any, key1) = %v, %v", live, err)
	}
	if err := authd.RecordMacLive(dw.ctx, id, p6, key1); err != nil {
		t.Fatal(err)
	}
	fams, err := authd.MacLiveFamilies(dw.ctx, id, key1)
	slices.Sort(fams)
	if err != nil || !slices.Equal(fams, []int32{4, 6}) {
		t.Fatalf("MacLiveFamilies = %v, %v; want [4 6]", fams, err)
	}

	// Cap at 8 rows, keeping the newest.
	for i := 1; i <= 10; i++ {
		p := MacLivePrefix(netip.MustParseAddr(fmt.Sprintf("198.51.100.%d", 20+i)))
		if err := authd.RecordMacLive(dw.ctx, id, p, key1); err != nil {
			t.Fatal(err)
		}
	}
	var n int
	if err := dw.admin.QueryRow(dw.ctx, `SELECT count(*) FROM authd.mail_device_cert_binds WHERE device_id = $1::uuid`, id).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != MacLiveRowsPerDevice {
		t.Fatalf("capped count = %d, want %d", n, MacLiveRowsPerDevice)
	}
}

// TestMacInstallGraceSQL verifies the shared MacInstallGraceSQL expression
// through both authd's DeviceByID and mailfront's DeviceGate against Postgres
// 18's uuidv7() / uuid_extract_timestamp() and database clock.
func TestMacInstallGraceSQL(t *testing.T) {
	dw := newDeviceWorld(t)
	dw.account("grace", "grace@dev.test", tenantA)
	front := dw.store("AUTHD_TEST_MAILFRONT_DATABASE_URL")
	authd := dw.store("AUTHD_TEST_DATABASE_URL")

	// insertRow inserts a device with an explicit SQL expression for its UUID id
	// and an optional 32-byte cert_key_sha256 literal ("" -> NULL).
	insertRow := func(idExpr, platform, keyHex string) string {
		t.Helper()
		keySQL := "NULL"
		if keyHex != "" {
			keySQL = `'` + keyHex + `'::bytea`
		}
		var id string
		q := `INSERT INTO authd.mail_devices
			(id, clerk_user_id, email, tenant_id, platform, cert_key_sha256, code_hash, code_kid, created_by)
			VALUES (` + idExpr + `, $1, 'grace@dev.test', $2::uuid, $3, ` + keySQL + `, '\x01'::bytea, 1, 'test')
			RETURNING id::text`
		if err := dw.admin.QueryRow(dw.ctx, q, devicePrefix+"grace", tenantA, platform).Scan(&id); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
		return id
	}
	uniqueKey := func(b byte) string {
		return `\x` + hex.EncodeToString(bytes.Repeat([]byte{b}, 32))
	}

	// 1. Fresh Mac with bound key and no cert_binds row -> in grace (~10m left).
	freshMac := insertRow(`uuidv7()`, "macos", uniqueKey(0x11))
	// 2. Mac created 4 minutes ago -> in grace (~6m left).
	midMac := insertRow(`uuidv7(-interval '4 minutes')`, "macos", uniqueKey(0x12))
	// 3. Slightly future-dated Mac (+30s, inside 1m clock skew) -> in grace, clamped <= 10m.
	skewMac := insertRow(`uuidv7(interval '30 seconds')`, "macos", uniqueKey(0x13))
	// 4. Too old (> 10 minutes) -> NOT in grace.
	oldMac := insertRow(`uuidv7(-interval '10 minutes 5 seconds')`, "macos", uniqueKey(0x14))
	// 5. Future-dated beyond +1 minute -> NOT in grace.
	futureMac := insertRow(`uuidv7(interval '2 minutes')`, "macos", uniqueKey(0x15))
	// 6. Fresh Mac with a cert_binds row (even expired) -> NOT in grace.
	withLiveMac := insertRow(`uuidv7()`, "macos", uniqueKey(0x16))
	dw.exec(`INSERT INTO authd.mail_device_cert_binds (device_id, addr, key_sha256, bound_at)
		VALUES ($1::uuid, '198.51.100.1/32', $2::bytea, now() - interval '2 hours')`, withLiveMac, uniqueKey(0x16))
	// 7. Not macos (ios / ipados), even with fresh uuidv7 and a key -> NOT in grace.
	iosDev := insertRow(`uuidv7()`, "ios", uniqueKey(0x17))
	ipadosDev := insertRow(`uuidv7()`, "ipados", "")
	// 8. Mac with no cert key bound -> NOT in grace.
	noKeyMac := insertRow(`uuidv7()`, "macos", "")
	// 9. Non-v7 UUID (UUIDv4: uuid_extract_timestamp returns NULL) -> NOT in grace, never errors on Scan.
	v4Mac := insertRow(`gen_random_uuid()`, "macos", uniqueKey(0x18))

	cases := []struct {
		name      string
		id        string
		wantGrace bool
		minLeft   time.Duration
		maxLeft   time.Duration
	}{
		{"fresh mac in grace", freshMac, true, 9*time.Minute + 30*time.Second, MacInstallGraceDuration},
		{"mid-window mac in grace", midMac, true, 5*time.Minute + 30*time.Second, 6*time.Minute + 5*time.Second},
		{"within 1m future skew clamped to 10m", skewMac, true, MacInstallGraceDuration - time.Second, MacInstallGraceDuration},
		{"too old (>10m)", oldMac, false, 0, 0},
		{"future-dated beyond 1m", futureMac, false, 0, 0},
		{"cert_binds row present (even expired)", withLiveMac, false, 0, 0},
		{"ios not macos", iosDev, false, 0, 0},
		{"ipados not macos", ipadosDev, false, 0, 0},
		{"macos with no cert key", noKeyMac, false, 0, 0},
		{"non-v7 uuid (v4)", v4Mac, false, 0, 0},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ad, err := authd.DeviceByID(dw.ctx, tc.id)
			if err != nil || ad == nil {
				t.Fatalf("DeviceByID(%s) = (%v, %v)", tc.id, ad, err)
			}
			if ad.MacInstallGrace != tc.wantGrace {
				t.Fatalf("DeviceByID.MacInstallGrace = %v, want %v", ad.MacInstallGrace, tc.wantGrace)
			}

			fd, err := front.DeviceGate(dw.ctx, tc.id)
			if err != nil || fd == nil {
				t.Fatalf("DeviceGate(%s) = (%v, %v)", tc.id, fd, err)
			}
			if fd.MacInstallGrace != tc.wantGrace {
				t.Fatalf("DeviceGate.MacInstallGrace = %v, want %v", fd.MacInstallGrace, tc.wantGrace)
			}
			if !tc.wantGrace {
				if fd.MacInstallGraceLeft != 0 {
					t.Fatalf("DeviceGate.MacInstallGraceLeft = %s, want 0", fd.MacInstallGraceLeft)
				}
			} else {
				if fd.MacInstallGraceLeft < tc.minLeft || fd.MacInstallGraceLeft > tc.maxLeft {
					t.Fatalf("DeviceGate.MacInstallGraceLeft = %s, want in [%s, %s]",
						fd.MacInstallGraceLeft, tc.minLeft, tc.maxLeft)
				}
			}
		})
	}
}
