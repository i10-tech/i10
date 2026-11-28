package enrollctl

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/enrolltoken"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DB-gated tests for `enroll_writer` least-privilege grants and the synchronous
// micro-batcher. Run against a migrated Postgres with:
//
//	AUTHD_TEST_ENROLL_WRITER_DATABASE_URL=postgres://enroll_writer@127.0.0.1:5432/i10 \
//	AUTHD_TEST_ADMIN_DATABASE_URL=postgres://postgres@127.0.0.1:5432/i10 \
//	go test -v -race ./internal/enrollctl/
//
// Without them the tests skip; with AUTHD_TEST_DB_REQUIRED set (CI) they fail
// instead, as ENROLL_TEST_REDIS_REQUIRED does for Redis.
func openBatchTestDBs(t *testing.T) (writerPool *pgxpool.Pool, adminPool *pgxpool.Pool) {
	t.Helper()
	wURL, aURL, ok := batchTestDBURLs(t)
	if !ok {
		return nil, nil
	}
	ctx := context.Background()
	w, err := OpenEnrollWriterPool(ctx, wURL)
	if err != nil {
		t.Fatalf("open enroll_writer pool: %v", err)
	}
	t.Cleanup(w.Close)
	a, err := pgxpool.New(ctx, aURL)
	if err != nil {
		t.Fatalf("open admin pool: %v", err)
	}
	t.Cleanup(a.Close)
	return w, a
}

// batchTestDBURLs returns the two URLs, or skips (fails under
// AUTHD_TEST_DB_REQUIRED) and returns false.
func batchTestDBURLs(t testing.TB) (writer, admin string, ok bool) {
	t.Helper()
	writer = os.Getenv("AUTHD_TEST_ENROLL_WRITER_DATABASE_URL")
	admin = os.Getenv("AUTHD_TEST_ADMIN_DATABASE_URL")
	if writer != "" && admin != "" {
		return writer, admin, true
	}
	const msg = "AUTHD_TEST_ENROLL_WRITER_DATABASE_URL and AUTHD_TEST_ADMIN_DATABASE_URL are not both set"
	if os.Getenv("AUTHD_TEST_DB_REQUIRED") != "" {
		t.Fatal(msg + " (AUTHD_TEST_DB_REQUIRED is set)")
	} else {
		t.Skip(msg)
	}
	return "", "", false
}

// gateTB records whether a gate failed or skipped the test, without stopping it.
type gateTB struct {
	testing.TB
	failed, skipped bool
}

func (g *gateTB) Helper()      {}
func (g *gateTB) Fatal(...any) { g.failed = true }
func (g *gateTB) Skip(...any)  { g.skipped = true }

func TestDBRequiredTurnsAMissingDatabaseIntoAFailure(t *testing.T) {
	t.Setenv("AUTHD_TEST_ENROLL_WRITER_DATABASE_URL", "")
	t.Setenv("AUTHD_TEST_DB_REQUIRED", "")
	skip := &gateTB{TB: t}
	if _, _, ok := batchTestDBURLs(skip); ok || !skip.skipped || skip.failed {
		t.Fatalf("without the switch = (ok %v, skipped %v, failed %v), want a skip", ok, skip.skipped, skip.failed)
	}
	t.Setenv("AUTHD_TEST_DB_REQUIRED", "1")
	fail := &gateTB{TB: t}
	if _, _, ok := batchTestDBURLs(fail); ok || !fail.failed || fail.skipped {
		t.Fatalf("with AUTHD_TEST_DB_REQUIRED = (ok %v, skipped %v, failed %v), want a failure", ok, fail.skipped, fail.failed)
	}
}

func testHash32(label string) []byte {
	s := sha256.Sum256([]byte(label))
	return s[:]
}

func newUUIDStr(t *testing.T) string {
	t.Helper()
	u, err := enrolltoken.NewUUIDv7()
	if err != nil {
		t.Fatal(err)
	}
	return enrolltoken.FormatUUID(u)
}

// realEpoch reads uid's credential_epoch as the column's default seeded it:
// microseconds since 1970, 16 digits, as every real account has. Tests take
// the epoch from here, never from a constant.
func realEpoch(t *testing.T, pool *pgxpool.Pool, uid string) int64 {
	t.Helper()
	var epoch int64
	if err := pool.QueryRow(context.Background(), `SELECT credential_epoch FROM authd.accounts WHERE clerk_user_id = $1`, uid).Scan(&epoch); err != nil {
		t.Fatalf("read %s's credential_epoch: %v", uid, err)
	}
	if epoch < 1_000_000_000_000_000 {
		t.Fatalf("%s's credential_epoch = %d, want a 16-digit microsecond seed", uid, epoch)
	}
	return epoch
}

// TestEnrollWriterGrants asserts that `enroll_writer` has EXACTLY the
// least-privilege grants specified in the design and is refused everywhere else.
func TestEnrollWriterGrants(t *testing.T) {
	w, admin := openBatchTestDBs(t)
	ctx := context.Background()

	uid := "user_ew_grant_" + newUUIDStr(t)[:8]
	email := uid + "@ew.test"
	devID := newUUIDStr(t)
	enrID := newUUIDStr(t)

	cleanup := func() {
		_, _ = admin.Exec(ctx, `DELETE FROM authd.accounts WHERE clerk_user_id = $1`, uid)
	}
	cleanup()
	t.Cleanup(cleanup)

	if _, err := admin.Exec(ctx, `INSERT INTO authd.accounts (clerk_user_id, email, active) VALUES ($1, $2, true)`, uid, email); err != nil {
		t.Fatal(err)
	}

	// Allowed: SELECT on all six authd tables + EXECUTE core.mailbox_domain_refused
	// and authd.enroll_lock_gate_accounts.
	for _, q := range []string{
		`SELECT * FROM authd.enroll_lock_gate_accounts(ARRAY['` + uid + `'])`,
		`SELECT clerk_user_id FROM authd.managed_accounts LIMIT 1`,
		`SELECT connection_id FROM authd.passthrough_versions LIMIT 1`,
		`SELECT domain FROM authd.required_domains LIMIT 1`,
		`SELECT clerk_user_id FROM authd.required_exempt LIMIT 1`,
		`SELECT id FROM authd.mail_devices LIMIT 1`,
		`SELECT core.mailbox_domain_refused(NULL::uuid, 'ew.test')`,
	} {
		if _, err := w.Exec(ctx, q); err != nil {
			t.Errorf("enroll_writer should be allowed %q: %v", q, err)
		}
	}

	// Allowed: INSERT into authd.mail_devices + UPDATE of the 4 allowed columns + DELETE from authd.mail_device_cert_binds.
	if _, err := w.Exec(ctx, `
		INSERT INTO authd.mail_devices (id, clerk_user_id, email, platform, serial, enrollment_id, code_hash, code_kid, created_by)
		VALUES ($1::uuid, $2, $3, 'macos', 'C02EW1', $4::uuid, $5, 1, 'test')
	`, devID, uid, email, enrID, testHash32("ew-code-"+devID)); err != nil {
		t.Fatalf("enroll_writer INSERT authd.mail_devices failed: %v", err)
	}
	if _, err := w.Exec(ctx, `
		UPDATE authd.mail_devices
		   SET cert_key_sha256 = $2, acme_bound_at = now(), first_used_at = now(), last_used_at = now()
		 WHERE id = $1::uuid
	`, devID, testHash32("ew-key-"+devID)); err != nil {
		t.Fatalf("enroll_writer UPDATE allowed columns failed: %v", err)
	}
	if _, err := admin.Exec(ctx, `
		INSERT INTO authd.mail_device_cert_binds (device_id, addr, key_sha256)
		VALUES ($1::uuid, '192.0.2.1/32', $2)
	`, devID, testHash32("ew-key-"+devID)); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Exec(ctx, `DELETE FROM authd.mail_device_cert_binds WHERE device_id = $1::uuid`, devID); err != nil {
		t.Fatalf("enroll_writer DELETE authd.mail_device_cert_binds failed: %v", err)
	}

	// Refused: core tables, identity tables, DELETE on mail_devices, UPDATE on accounts,
	// UPDATE on every non-granted column of mail_devices, SELECT of non-device_id bind columns.
	for _, q := range []string{
		`SELECT 1 FROM core.messages LIMIT 1`,
		`SELECT 1 FROM core.tenants LIMIT 1`,
		`SELECT 1 FROM core.domains LIMIT 1`,
		`SELECT 1 FROM identity.connections LIMIT 1`,
		`SELECT 1 FROM identity.identities LIMIT 1`,
		`SELECT 1 FROM authd.access_changes LIMIT 1`,
		`DELETE FROM authd.mail_devices WHERE id = '` + devID + `'`,
		`UPDATE authd.accounts SET active = true WHERE clerk_user_id = '` + uid + `'`,
		`UPDATE authd.mail_devices SET email = email WHERE id = '` + devID + `'`,
		`UPDATE authd.mail_devices SET clerk_user_id = clerk_user_id WHERE id = '` + devID + `'`,
		`UPDATE authd.mail_devices SET tenant_id = tenant_id WHERE id = '` + devID + `'`,
		`UPDATE authd.mail_devices SET platform = platform WHERE id = '` + devID + `'`,
		`UPDATE authd.mail_devices SET code_hash = code_hash WHERE id = '` + devID + `'`,
		`UPDATE authd.mail_devices SET code_kid = code_kid WHERE id = '` + devID + `'`,
		`UPDATE authd.mail_devices SET serial = serial WHERE id = '` + devID + `'`,
		`UPDATE authd.mail_devices SET enrollment_id = enrollment_id WHERE id = '` + devID + `'`,
		`UPDATE authd.mail_devices SET created_by = created_by WHERE id = '` + devID + `'`,
		`SELECT addr, key_sha256, bound_at FROM authd.mail_device_cert_binds LIMIT 1`,
		// Every row-locking clause needs UPDATE on a column: the lock goes
		// through authd.enroll_lock_gate_accounts only.
		`SELECT 1 FROM authd.accounts WHERE clerk_user_id = '` + uid + `' FOR SHARE`,
		`SELECT 1 FROM authd.accounts WHERE clerk_user_id = '` + uid + `' FOR KEY SHARE`,
		`SELECT 1 FROM authd.accounts WHERE clerk_user_id = '` + uid + `' FOR NO KEY UPDATE`,
		`SELECT 1 FROM authd.accounts WHERE clerk_user_id = '` + uid + `' FOR UPDATE`,
	} {
		if _, err := w.Exec(ctx, q); err == nil {
			t.Errorf("enroll_writer MUST be refused %q, but succeeded", q)
		}
	}
}

// TestEnrollLockGateAccountsHoldsTheLock proves the SECURITY DEFINER function's
// row lock belongs to enroll_writer's transaction: an UPDATE of the account from
// another session waits for that transaction (refused here by a short
// lock_timeout) and goes through once it commits.
func TestEnrollLockGateAccountsHoldsTheLock(t *testing.T) {
	w, admin := openBatchTestDBs(t)
	ctx := context.Background()
	uid := "user_ew_lock_" + newUUIDStr(t)[:8]
	cleanup := func() {
		_, _ = admin.Exec(ctx, `DELETE FROM authd.accounts WHERE clerk_user_id = $1`, uid)
	}
	cleanup()
	t.Cleanup(cleanup)
	if _, err := admin.Exec(ctx, `INSERT INTO authd.accounts (clerk_user_id, email, active) VALUES ($1, $2, true)`, uid, uid+"@ew.test"); err != nil {
		t.Fatal(err)
	}
	epoch := realEpoch(t, admin, uid)

	tx, err := w.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	accounts, err := lockAndLoadAccounts(ctx, tx, []string{uid})
	if err != nil {
		t.Fatalf("lockAndLoadAccounts as enroll_writer: %v", err)
	}
	if a := accounts[uid]; a == nil || a.CredentialEpoch != epoch || a.MailDomain != "ew.test" || !a.Active {
		t.Fatalf("locked row = %+v", a)
	}

	revoke := func() error {
		other, err := admin.Begin(ctx)
		if err != nil {
			return err
		}
		defer func() { _ = other.Rollback(ctx) }()
		if _, err := other.Exec(ctx, `SET LOCAL lock_timeout = '200ms'`); err != nil {
			return err
		}
		if _, err := other.Exec(ctx, `UPDATE authd.accounts SET credential_epoch = credential_epoch + 1 WHERE clerk_user_id = $1`, uid); err != nil {
			return err
		}
		return other.Commit(ctx)
	}
	err = revoke()
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "55P03" {
		t.Fatalf("UPDATE while enroll_writer holds the lock = %v, want lock_not_available (55P03)", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := revoke(); err != nil {
		t.Fatalf("UPDATE after enroll_writer committed: %v", err)
	}
}

func TestBatcherMintPartialBadRowConflictTimeoutAndCaps(t *testing.T) {
	w, admin := openBatchTestDBs(t)
	ctx := context.Background()

	runID := newUUIDStr(t)[:8]
	tenantID := newUUIDStr(t)
	domain := "batch-" + runID + ".test"
	ownerUID := "user_bm_owner_" + runID
	uids := make([]string, 12)
	for i := range uids {
		uids[i] = fmt.Sprintf("user_bm_%s_%02d", runID, i)
	}

	cleanup := func() {
		_, _ = admin.Exec(ctx, `DELETE FROM authd.accounts WHERE clerk_user_id LIKE $1`, "user_bm_"+runID+"%")
		_, _ = admin.Exec(ctx, `DELETE FROM core.tenants WHERE id = $1::uuid`, tenantID)
		_, _ = admin.Exec(ctx, `DELETE FROM core.retention_horizons WHERE tenant_id = $1::uuid`, tenantID)
	}
	cleanup()
	t.Cleanup(cleanup)

	if _, err := admin.Exec(ctx, `INSERT INTO core.tenants (id, slug, name, owner_clerk_user_id) VALUES ($1::uuid, $2, 'Batch Test', $3)`,
		tenantID, "batch-"+runID, ownerUID); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `INSERT INTO core.domains (tenant_id, name, status, hosts_mailboxes, verified_at, identity_registered_at)
		VALUES ($1::uuid, $2, 'verified', true, now(), now())`, tenantID, domain); err != nil {
		t.Fatal(err)
	}
	for i, u := range uids {
		suspended := i == 1 // user 1 is suspended -> gate refusal
		if suspended {
			_, err := admin.Exec(ctx, `INSERT INTO authd.accounts (clerk_user_id, email, active, tenant_id, suspended_at)
				VALUES ($1, $2, true, $3::uuid, now())`, u, fmt.Sprintf("u%d@%s", i, domain), tenantID)
			if err != nil {
				t.Fatal(err)
			}
		} else {
			_, err := admin.Exec(ctx, `INSERT INTO authd.accounts (clerk_user_id, email, active, tenant_id)
				VALUES ($1, $2, true, $3::uuid)`, u, fmt.Sprintf("u%d@%s", i, domain), tenantID)
			if err != nil {
				t.Fatal(err)
			}
		}
	}
	epochOf := make(map[string]int64, len(uids))
	for _, u := range uids {
		epochOf[u] = realEpoch(t, admin, u)
	}

	// 1. Idle single request dispatches immediately with 0ms wait even when maxWait=200ms.
	bIdle := NewBatcher(w, BatcherConfig{MaxBatch: 10, MaxWait: 200 * time.Millisecond})
	defer bIdle.Close()
	t0 := time.Now()
	enrDup := newUUIDStr(t)
	res0 := bIdle.Mint(ctx, MintRequest{
		DeviceID:      newUUIDStr(t),
		EnrollmentID:  enrDup,
		ClerkUserID:   uids[0],
		Email:         fmt.Sprintf("u0@%s", domain),
		TenantID:      &tenantID,
		ExpectedEpoch: epochOf[uids[0]],
		Platform:      "ios",
		CodeHash:      testHash32("idle-" + runID),
		CodeKid:       1,
		CreatedBy:     uids[0],
	})
	if res0.Err != nil || !res0.OK {
		t.Fatalf("idle Mint = %+v", res0)
	}
	if elapsed := time.Since(t0); elapsed > 120*time.Millisecond {
		t.Fatalf("idle dispatch waited %v (maxWait=200ms); expected immediate 0ms wait", elapsed)
	}

	// 2. Partial batch: accepted + gate-refused (suspended) + ON CONFLICT (enrollment_id) + bad constraint row (platform='android').
	var (
		obsMu   sync.Mutex
		maxSeen int
		b       *Batcher
	)
	b = NewBatcher(w, BatcherConfig{
		MaxBatch: 4,
		MaxWait:  10 * time.Millisecond,
		Observe: func(_ string, size int, _ time.Duration) {
			obsMu.Lock()
			if size > maxSeen {
				maxSeen = size
			}
			obsMu.Unlock()
		},
	})
	defer b.Close()

	reqs := []MintRequest{
		// Accepted
		{DeviceID: newUUIDStr(t), EnrollmentID: newUUIDStr(t), ClerkUserID: uids[2], Email: fmt.Sprintf("u2@%s", domain), TenantID: &tenantID, ExpectedEpoch: epochOf[uids[2]], Platform: "ios", CodeHash: testHash32("ok2-" + runID), CodeKid: 1, CreatedBy: uids[2]},
		// Suspended -> gate refusal
		{DeviceID: newUUIDStr(t), EnrollmentID: newUUIDStr(t), ClerkUserID: uids[1], Email: fmt.Sprintf("u1@%s", domain), TenantID: &tenantID, ExpectedEpoch: epochOf[uids[1]], Platform: "ios", CodeHash: testHash32("susp-" + runID), CodeKid: 1, CreatedBy: uids[1]},
		// Duplicate enrollment_id -> ON CONFLICT DO NOTHING -> enrollment_conflict
		{DeviceID: newUUIDStr(t), EnrollmentID: enrDup, ClerkUserID: uids[0], Email: fmt.Sprintf("u0@%s", domain), TenantID: &tenantID, ExpectedEpoch: epochOf[uids[0]], Platform: "ios", CodeHash: testHash32("dup-" + runID), CodeKid: 1, CreatedBy: uids[0]},
		// Bad row (violates mail_devices_platform_check) -> isolated via splitting, MUST NOT fail siblings!
		{DeviceID: newUUIDStr(t), EnrollmentID: newUUIDStr(t), ClerkUserID: uids[3], Email: fmt.Sprintf("u3@%s", domain), TenantID: &tenantID, ExpectedEpoch: epochOf[uids[3]], Platform: "android", CodeHash: testHash32("bad-" + runID), CodeKid: 1, CreatedBy: uids[3]},
		// More accepted rows (also exercises MaxBatch=4 cap under concurrent load)
		{DeviceID: newUUIDStr(t), EnrollmentID: newUUIDStr(t), ClerkUserID: uids[4], Email: fmt.Sprintf("u4@%s", domain), TenantID: &tenantID, ExpectedEpoch: epochOf[uids[4]], Platform: "ipados", CodeHash: testHash32("ok4-" + runID), CodeKid: 1, CreatedBy: uids[4]},
		{DeviceID: newUUIDStr(t), EnrollmentID: newUUIDStr(t), ClerkUserID: uids[5], Email: fmt.Sprintf("u5@%s", domain), TenantID: &tenantID, ExpectedEpoch: epochOf[uids[5]], Platform: "macos", CodeHash: testHash32("ok5-" + runID), CodeKid: 1, CreatedBy: uids[5]},
		{DeviceID: newUUIDStr(t), EnrollmentID: newUUIDStr(t), ClerkUserID: uids[6], Email: fmt.Sprintf("u6@%s", domain), TenantID: &tenantID, ExpectedEpoch: epochOf[uids[6]], Platform: "ios", CodeHash: testHash32("ok6-" + runID), CodeKid: 1, CreatedBy: uids[6]},
		{DeviceID: newUUIDStr(t), EnrollmentID: newUUIDStr(t), ClerkUserID: uids[7], Email: fmt.Sprintf("u7@%s", domain), TenantID: &tenantID, ExpectedEpoch: epochOf[uids[7]], Platform: "ios", CodeHash: testHash32("ok7-" + runID), CodeKid: 1, CreatedBy: uids[7]},
	}

	got := make([]MintResult, len(reqs))
	var wg sync.WaitGroup
	for i := range reqs {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			got[idx] = b.Mint(ctx, reqs[idx])
		}(i)
	}
	wg.Wait()

	if !got[0].OK || !got[4].OK || !got[5].OK || !got[6].OK || !got[7].OK {
		t.Fatalf("expected valid rows to commit despite bad sibling, got: %+v", got)
	}
	if got[1].OK || got[1].RefusalCode != "mailbox_suspended" {
		t.Fatalf("suspended row = %+v, want mailbox_suspended", got[1])
	}
	if got[2].OK || got[2].RefusalCode != "enrollment_conflict" {
		t.Fatalf("duplicate enrollment row = %+v, want enrollment_conflict", got[2])
	}
	if got[3].OK || got[3].Err != nil || got[3].RefusalCode != "db_constraint_violation" {
		t.Fatalf("bad constraint row = %+v, want db_constraint_violation", got[3])
	}
	if maxSeen > 4 {
		t.Fatalf("observed batch size %d exceeded MaxBatch=4", maxSeen)
	}

	// 3. Lock timeout -> returns ErrUnavailable (503) and mints nothing.
	blocker, err := admin.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = blocker.Rollback(ctx) }()
	if _, err := blocker.Exec(ctx, `SELECT 1 FROM authd.accounts WHERE clerk_user_id = $1 FOR UPDATE`, uids[8]); err != nil {
		t.Fatal(err)
	}
	lockedDevID := newUUIDStr(t)
	resTimeout := b.Mint(ctx, MintRequest{
		DeviceID: lockedDevID, EnrollmentID: newUUIDStr(t), ClerkUserID: uids[8],
		Email: fmt.Sprintf("u8@%s", domain), TenantID: &tenantID, ExpectedEpoch: epochOf[uids[8]],
		Platform: "ios", CodeHash: testHash32("locked-" + runID), CodeKid: 1, CreatedBy: uids[8],
	})
	_ = blocker.Rollback(ctx)
	if !errors.Is(resTimeout.Err, ErrUnavailable) {
		t.Fatalf("lock timeout Mint = %+v, want ErrUnavailable", resTimeout)
	}
	var count int
	_ = admin.QueryRow(ctx, `SELECT count(*) FROM authd.mail_devices WHERE id = $1::uuid`, lockedDevID).Scan(&count)
	if count != 0 {
		t.Fatalf("timed-out mint left %d rows behind", count)
	}

	// 4. Forced 40P01 deadlock against reverse-order lock holder -> retry/split recovers!
	// Hold uids[10] FOR UPDATE in txD, start a batch locking uids[9] and uids[10]
	// (sorted order), then txD tries to lock uids[9] -> Postgres raises 40P01 on one side.
	txD, err := admin.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = txD.Rollback(ctx) }()
	if _, err := txD.Exec(ctx, `SELECT 1 FROM authd.accounts WHERE clerk_user_id = $1 FOR UPDATE`, uids[10]); err != nil {
		t.Fatal(err)
	}
	var dlRes [2]MintResult
	var dlWG sync.WaitGroup
	dlWG.Add(2)
	go func() {
		defer dlWG.Done()
		dlRes[0] = b.Mint(ctx, MintRequest{
			DeviceID: newUUIDStr(t), EnrollmentID: newUUIDStr(t), ClerkUserID: uids[9],
			Email: fmt.Sprintf("u9@%s", domain), TenantID: &tenantID, ExpectedEpoch: epochOf[uids[9]],
			Platform: "ios", CodeHash: testHash32("dl9-" + runID), CodeKid: 1, CreatedBy: uids[9],
		})
	}()
	go func() {
		defer dlWG.Done()
		dlRes[1] = b.Mint(ctx, MintRequest{
			DeviceID: newUUIDStr(t), EnrollmentID: newUUIDStr(t), ClerkUserID: uids[10],
			Email: fmt.Sprintf("u10@%s", domain), TenantID: &tenantID, ExpectedEpoch: epochOf[uids[10]],
			Platform: "ios", CodeHash: testHash32("dl10-" + runID), CodeKid: 1, CreatedBy: uids[10],
		})
	}()
	// Give the batch a moment to acquire uids[9] and block on uids[10], then trigger opposite lock.
	time.Sleep(50 * time.Millisecond)
	_, _ = txD.Exec(ctx, `SELECT 1 FROM authd.accounts WHERE clerk_user_id = $1 FOR UPDATE`, uids[9])
	_ = txD.Rollback(ctx)
	dlWG.Wait()
	if !dlRes[0].OK || !dlRes[1].OK {
		t.Fatalf("deadlock recovery failed: %+v", dlRes)
	}

	// 5. Mac ACME bind batch + #536 conflict rule + duplicate key_in_use splitting.
	mac1 := newUUIDStr(t)
	mac2 := newUUIDStr(t)
	ser1, ser2 := "C02BMAC1-"+runID, "C02BMAC2-"+runID
	for _, m := range []struct {
		id, uid, email, ser string
	}{
		{mac1, uids[5], fmt.Sprintf("u5@%s", domain), ser1},
		{mac2, uids[6], fmt.Sprintf("u6@%s", domain), ser2},
	} {
		s := m.ser
		r := b.Mint(ctx, MintRequest{
			DeviceID: m.id, EnrollmentID: newUUIDStr(t), ClerkUserID: m.uid, Email: m.email,
			TenantID: &tenantID, ExpectedEpoch: epochOf[m.uid], Platform: "macos", Serial: &s,
			CodeHash: testHash32("mac-" + m.id), CodeKid: 1, CreatedBy: m.uid,
		})
		if !r.OK {
			t.Fatalf("mint mac %s failed: %+v", m.id, r)
		}
	}
	// Seed a liveness row to prove BindMac deletes it.
	key1 := testHash32("mac-k1-" + runID)
	key2 := testHash32("mac-k2-" + runID)
	_, _ = admin.Exec(ctx, `INSERT INTO authd.mail_device_cert_binds (device_id, addr, key_sha256) VALUES ($1::uuid, '192.0.2.5/32', $2)`, mac1, key1)

	// First bind succeeds, sets cert_key_sha256 + acme_bound_at + deletes liveness.
	br1 := b.BindMac(ctx, BindMacRequest{DeviceID: mac1, Serial: ser1, KeySha256: key1})
	if !br1.OK {
		t.Fatalf("first Mac bind = %+v", br1)
	}
	var bindRows int
	_ = admin.QueryRow(ctx, `SELECT count(*) FROM authd.mail_device_cert_binds WHERE device_id = $1::uuid`, mac1).Scan(&bindRows)
	if bindRows != 0 {
		t.Fatalf("liveness rows not deleted on bind: %d", bindRows)
	}

	// Same-key retry is idempotent OK.
	if brRetry := b.BindMac(ctx, BindMacRequest{DeviceID: mac1, Serial: ser1, KeySha256: key1}); !brRetry.OK {
		t.Fatalf("same-key retry = %+v, want OK", brRetry)
	}

	// Duplicate key on mac2 -> refused key_in_use.
	if brDup := b.BindMac(ctx, BindMacRequest{DeviceID: mac2, Serial: ser2, KeySha256: key1}); brDup.OK || brDup.RefusalCode != "key_in_use" {
		t.Fatalf("duplicate key on mac2 = %+v, want key_in_use", brDup)
	}

	// Second, different key on mac1 -> #536 conflict: clears cert_key_sha256, keeps acme_bound_at set, refuses!
	if brConflict := b.BindMac(ctx, BindMacRequest{DeviceID: mac1, Serial: ser1, KeySha256: key2}); brConflict.OK || brConflict.RefusalCode != "acme_key_conflict" {
		t.Fatalf("#536 conflict bind = %+v, want acme_key_conflict", brConflict)
	}
	var storedKey []byte
	var boundAt *time.Time
	if err := admin.QueryRow(ctx, `SELECT cert_key_sha256, acme_bound_at FROM authd.mail_devices WHERE id = $1::uuid`, mac1).Scan(&storedKey, &boundAt); err != nil {
		t.Fatal(err)
	}
	if len(storedKey) != 0 || boundAt == nil {
		t.Fatalf("after #536 conflict: key=%x boundAt=%v, want NULL key and non-NULL acme_bound_at", storedKey, boundAt)
	}
	// Once cleared by #536 conflict, even the original key CANNOT bind again.
	if brAgain := b.BindMac(ctx, BindMacRequest{DeviceID: mac1, Serial: ser1, KeySha256: key1}); brAgain.OK || brAgain.RefusalCode != "acme_key_conflict" {
		t.Fatalf("rebind after #536 conflict = %+v, want acme_key_conflict", brAgain)
	}
	_ = bytes.Equal(key1, key2)
}

func TestBatcherPostgresUnreachableReturnsUnavailable(t *testing.T) {
	// Closed/nil pool simulates Postgres unreachable without needing any DB URL.
	b := NewBatcher(nil, BatcherConfig{MaxBatch: 10, MaxWait: time.Millisecond})
	defer b.Close()
	ctx := context.Background()
	res := b.Mint(ctx, MintRequest{DeviceID: newUUIDStr(t), ClerkUserID: "user_x"})
	if !errors.Is(res.Err, ErrUnavailable) {
		t.Fatalf("Mint on nil pool = %+v, want ErrUnavailable", res)
	}
	bres := b.BindMac(ctx, BindMacRequest{DeviceID: newUUIDStr(t), Serial: "S", KeySha256: testHash32("k")})
	if !errors.Is(bres.Err, ErrUnavailable) {
		t.Fatalf("BindMac on nil pool = %+v, want ErrUnavailable", bres)
	}
}
