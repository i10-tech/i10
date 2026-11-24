package mailfront

import (
	"context"
	"encoding/csv"
	"fmt"
	"io"
	"log/slog"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/i10-tech/i10/services/authd/internal/projection"
)

// What a committed change must make the change-driven poll do to Alice's open
// connection.
type pathWant int

const (
	// closes: the poll reads her row and closes the connection.
	closes pathWant = iota
	// rechecks: the poll reads her row (the change names her) and she keeps it.
	rechecks
	// ignored: the change touched no gate column, so it is not logged.
	ignored
	// sweepsAll: the change names everybody, so the poll asks for a full sweep,
	// and that sweep closes nothing it should not.
	sweepsAll
)

// gatePath is one way a gate input changes: the state before Alice signs in,
// and the change, committed in one transaction.
type gatePath struct {
	table, name string
	setup       []string
	change      []string
	want        pathWant
}

// Fixture names. :A and :B are the two workspaces; Alice is in A, on path.test,
// which A holds by a verified sending-domain proof unless a setup changes that.
const (
	pathConnA = "a1111111-1111-4111-8111-111111111111"
	pathConnB = "b2222222-2222-4222-8222-222222222222"
	pathAlice = "user_path_alice"
)

var pathNames = strings.NewReplacer(
	":A", "(SELECT id FROM core.tenants WHERE slug = 'path-a')",
	":B", "(SELECT id FROM core.tenants WHERE slug = 'path-b')",
	":connA", "'"+pathConnA+"'::uuid",
	":connB", "'"+pathConnB+"'::uuid",
	":alice", "'"+pathAlice+"'",
)

const (
	upAlice   = `UPDATE authd.accounts SET `
	whAlice   = ` WHERE clerk_user_id = :alice`
	upDomain  = `UPDATE core.domains SET `
	whDomainA = ` WHERE name = 'path.test' AND tenant_id = :A`
	upJoin    = `UPDATE core.join_domains SET `
	whJoinA   = ` WHERE name = 'path.test' AND tenant_id = :A`

	managedIdentity = `INSERT INTO identity.managed_accounts (clerk_user_id, tenant_id, connection_id, reason) VALUES (:alice, :A, :connA, 'scim')`
	managedByA      = `INSERT INTO authd.managed_accounts (clerk_user_id, connection_id) VALUES (:alice, :connA)`
	requiredByA     = `INSERT INTO authd.required_domains (domain, tenant_id, connection_id) VALUES ('path.test', :A, :connA)`
	exemptOnA       = `INSERT INTO authd.required_exempt (connection_id, tenant_id, clerk_user_id, source) VALUES (:connA, :A, :alice, 'bypass')`
	versionOfA      = `INSERT INTO authd.passthrough_versions (connection_id, version, fingerprint) VALUES (:connA, 1, 'x')`
	// A's only proof of path.test is a TXT proof: the sending-domain row hosts
	// but was never proved.
	txtOnly = `UPDATE core.domains SET status = 'not_started', identity_registered_at = NULL WHERE name = 'path.test'`
	txtOfA  = `INSERT INTO core.join_domains (tenant_id, name, clerk_org_id, source, verified_at) VALUES (:A, 'path.test', 'org_path', 'txt', now())`
)

func one(s string) []string { return []string{s} }

// gatePaths is EVERY input of the mail gate (internal/gate, through
// projection.accountColumns and the core functions it calls), each column and
// each insert and delete that can move it, with what the poll must do. The
// list is the structural half of "a new input needs a trigger": a column or a
// table added to the gate gets a row here, and TestEveryTableTheGateReadsLogsItsChanges
// (internal/projection) fails until its table has the triggers.
//
// ⚠ locked_until IS ALSO READ AGAINST THE CLOCK (`locked_until > now()`), AND THE
// CLOCK ONLY EVER LIFTS A LOCK. No trigger can see time pass, and none needs to:
// a lock running out restores access, it never takes it away.
var gatePaths = []gatePath{
	// authd.accounts
	{"authd.accounts", "active", nil, one(upAlice + `active = false` + whAlice), closes},
	{"authd.accounts", "email", nil, one(upAlice + `email = 'alice2@path.test'` + whAlice), closes},
	{"authd.accounts", "tenant_id", nil, one(upAlice + `tenant_id = :B` + whAlice), closes},
	{"authd.accounts", "clerk_updated_at", nil, one(upAlice + `clerk_updated_at = clerk_updated_at + interval '1 second'` + whAlice), closes},
	{"authd.accounts", "credential_epoch", nil, one(upAlice + `credential_epoch = credential_epoch + 1` + whAlice), closes},
	{"authd.accounts", "suspended_at", nil, one(upAlice + `suspended_at = now()` + whAlice), closes},
	{"authd.accounts", "payment_hold_at", nil, one(upAlice + `payment_hold_at = now()` + whAlice), closes},
	{"authd.accounts", "deleting_at", nil, one(upAlice + `deleting_at = now()` + whAlice), closes},
	{"authd.accounts", "banned", nil, one(upAlice + `banned = true` + whAlice), closes},
	{"authd.accounts", "locked", nil, one(upAlice + `locked = true` + whAlice), closes},
	{"authd.accounts", "locked_until",
		one(upAlice + `locked = true, locked_until = now() - interval '1 hour'` + whAlice),
		one(upAlice + `locked_until = now() + interval '1 hour'` + whAlice), closes},
	{"authd.accounts", "delete", nil, one(`DELETE FROM authd.accounts` + whAlice), closes},
	{"authd.accounts", "delete and insert again", nil, []string{
		`DELETE FROM authd.accounts` + whAlice,
		`INSERT INTO authd.accounts (clerk_user_id, email, active, tenant_id, clerk_updated_at)
			VALUES (:alice, 'alice@path.test', true, :A, (SELECT now() - interval '1 day'))`,
	}, closes},
	{"authd.accounts", "display_name (read by the bind, not the gate)", nil, one(upAlice + `display_name = 'Alice'` + whAlice), rechecks},
	{"authd.accounts", "storage_allocation (ignored)", nil, one(upAlice + `storage_allocation = 1024, updated_at = now()` + whAlice), ignored},

	// authd.managed_accounts
	{"authd.managed_accounts", "insert", one(managedIdentity), one(managedByA), closes},
	{"authd.managed_accounts", "connection_id", []string{managedIdentity, managedByA},
		one(`UPDATE authd.managed_accounts SET connection_id = :connB WHERE clerk_user_id = :alice`), closes},
	{"authd.managed_accounts", "connection_id to none", []string{managedIdentity, managedByA},
		one(`UPDATE authd.managed_accounts SET connection_id = NULL WHERE clerk_user_id = :alice`), closes},
	{"authd.managed_accounts", "delete", []string{managedIdentity, managedByA},
		one(`DELETE FROM authd.managed_accounts WHERE clerk_user_id = :alice`), closes},
	{"authd.managed_accounts", "updated_at (ignored)", []string{managedIdentity, managedByA},
		one(`UPDATE authd.managed_accounts SET updated_at = now() WHERE clerk_user_id = :alice`), ignored},

	// authd.passthrough_versions: by connection, to the accounts it manages.
	{"authd.passthrough_versions", "version", []string{managedIdentity, managedByA, versionOfA},
		one(`UPDATE authd.passthrough_versions SET version = 2 WHERE connection_id = :connA`), rechecks},
	{"authd.passthrough_versions", "insert", []string{managedIdentity, managedByA}, one(versionOfA), rechecks},
	{"authd.passthrough_versions", "delete", []string{managedIdentity, managedByA, versionOfA},
		one(`DELETE FROM authd.passthrough_versions WHERE connection_id = :connA`), rechecks},
	{"authd.passthrough_versions", "fingerprint (ignored)", []string{managedIdentity, managedByA, versionOfA},
		one(`UPDATE authd.passthrough_versions SET fingerprint = 'y', updated_at = now() WHERE connection_id = :connA`), ignored},
	// ⚠ A TRUNCATE, PUT BACK IN THE SAME TRANSACTION so the tests of other
	// packages that share the database see the same rows after it.
	{"authd.passthrough_versions", "truncate", []string{managedIdentity, managedByA, versionOfA}, []string{
		`CREATE TEMP TABLE pv_keep ON COMMIT DROP AS SELECT * FROM authd.passthrough_versions`,
		`TRUNCATE authd.passthrough_versions`,
		`INSERT INTO authd.passthrough_versions SELECT * FROM pv_keep`,
	}, sweepsAll},

	// authd.required_domains: by domain.
	{"authd.required_domains", "insert", nil, one(requiredByA), closes},
	{"authd.required_domains", "domain (the new key)",
		one(`INSERT INTO authd.required_domains (domain, tenant_id, connection_id) VALUES ('other-path.test', :A, :connA)`),
		one(`UPDATE authd.required_domains SET domain = 'path.test' WHERE domain = 'other-path.test'`), closes},
	{"authd.required_domains", "domain (the old key)", []string{requiredByA, exemptOnA},
		one(`UPDATE authd.required_domains SET domain = 'other-path.test' WHERE domain = 'path.test'`), rechecks},
	{"authd.required_domains", "tenant_id",
		one(`INSERT INTO authd.required_domains (domain, tenant_id, connection_id) VALUES ('path.test', :B, :connA)`),
		one(`UPDATE authd.required_domains SET tenant_id = :A WHERE domain = 'path.test'`), closes},
	{"authd.required_domains", "connection_id", []string{requiredByA, exemptOnA},
		one(`UPDATE authd.required_domains SET connection_id = :connB WHERE domain = 'path.test'`), closes},
	{"authd.required_domains", "delete", []string{requiredByA, exemptOnA},
		one(`DELETE FROM authd.required_domains WHERE domain = 'path.test'`), rechecks},
	{"authd.required_domains", "updated_at (ignored)", []string{requiredByA, exemptOnA},
		one(`UPDATE authd.required_domains SET updated_at = now() WHERE domain = 'path.test'`), ignored},

	// authd.required_exempt: by person.
	{"authd.required_exempt", "delete", []string{requiredByA, exemptOnA},
		one(`DELETE FROM authd.required_exempt WHERE clerk_user_id = :alice`), closes},
	{"authd.required_exempt", "connection_id", []string{requiredByA, exemptOnA},
		one(`UPDATE authd.required_exempt SET connection_id = :connB WHERE clerk_user_id = :alice`), closes},
	{"authd.required_exempt", "tenant_id", []string{requiredByA, exemptOnA},
		one(`UPDATE authd.required_exempt SET tenant_id = :B WHERE clerk_user_id = :alice`), closes},
	{"authd.required_exempt", "clerk_user_id (the old key)", []string{requiredByA, exemptOnA},
		one(`UPDATE authd.required_exempt SET clerk_user_id = 'user_path_other' WHERE clerk_user_id = :alice`), closes},
	{"authd.required_exempt", "source", []string{requiredByA, exemptOnA},
		one(`UPDATE authd.required_exempt SET source = 'owner_exemption' WHERE clerk_user_id = :alice`), rechecks},
	{"authd.required_exempt", "insert", []string{requiredByA, exemptOnA},
		one(`INSERT INTO authd.required_exempt (connection_id, tenant_id, clerk_user_id, source) VALUES (:connA, :A, :alice, 'owner_exemption')`), rechecks},
	{"authd.required_exempt", "updated_at (ignored)", []string{requiredByA, exemptOnA},
		one(`UPDATE authd.required_exempt SET updated_at = now() WHERE clerk_user_id = :alice`), ignored},

	// core.domains: by domain name, through core.mailbox_domain_refused.
	{"core.domains", "hosts_mailboxes", nil, one(upDomain + `hosts_mailboxes = false` + whDomainA), closes},
	{"core.domains", "displaced_at", nil, one(upDomain + `displaced_at = now()` + whDomainA), closes},
	{"core.domains", "tenant_id", nil, one(upDomain + `tenant_id = :B` + whDomainA), closes},
	{"core.domains", "status", one(upDomain + `proof_missing_since = now()` + whDomainA),
		one(upDomain + `status = 'failed'` + whDomainA), closes},
	{"core.domains", "proof_missing_since", one(upDomain + `status = 'failed'` + whDomainA),
		one(upDomain + `proof_missing_since = now()` + whDomainA), closes},
	{"core.domains", "identity_registered_at", one(upDomain + `status = 'pending'` + whDomainA),
		one(upDomain + `identity_registered_at = NULL` + whDomainA), closes},
	{"core.domains", "verified_at", one(upDomain + `status = 'pending', identity_registered_at = NULL, verified_at = now()` + whDomainA),
		one(upDomain + `verified_at = NULL` + whDomainA), closes},
	// A's proof time is its creation; B proved the name yesterday.
	{"core.domains", "created_at", []string{
		upDomain + `identity_registered_at = NULL, created_at = now()` + whDomainA,
		`INSERT INTO core.domains (tenant_id, name, status, verified_at) VALUES (:B, 'path.test', 'pending', now() - interval '1 day')`,
	}, one(upDomain + `created_at = now() - interval '2 days'` + whDomainA), closes},
	{"core.domains", "name (the old key)", nil, one(upDomain + `name = 'renamed-path.test'` + whDomainA), rechecks},
	{"core.domains", "insert", nil,
		one(`INSERT INTO core.domains (tenant_id, name, status, identity_registered_at) VALUES (:B, 'path.test', 'pending', now() + interval '1 minute')`), closes},
	{"core.domains", "delete",
		one(`INSERT INTO core.domains (tenant_id, name) VALUES (:B, 'path.test')`),
		one(`DELETE FROM core.domains` + whDomainA), closes},
	{"core.domains", "dns_checked_at (ignored)", nil, one(upDomain + `dns_checked_at = now(), rdap_checked_at = now(), updated_at = now()` + whDomainA), ignored},

	// core.join_domains: a TXT proof, by domain name, through core.name_holders.
	{"core.join_domains", "verified_at", []string{txtOnly, txtOfA}, one(upJoin + `verified_at = NULL` + whJoinA), closes},
	{"core.join_domains", "lapsed_at", []string{txtOnly, txtOfA}, one(upJoin + `lapsed_at = now()` + whJoinA), closes},
	{"core.join_domains", "displaced_at", []string{txtOnly, txtOfA}, one(upJoin + `displaced_at = now()` + whJoinA), closes},
	{"core.join_domains", "source", []string{txtOnly, txtOfA}, one(upJoin + `source = 'domains'` + whJoinA), closes},
	{"core.join_domains", "tenant_id", []string{txtOnly, txtOfA}, one(upJoin + `tenant_id = :B` + whJoinA), closes},
	{"core.join_domains", "name (the old key)", []string{txtOnly, txtOfA}, one(upJoin + `name = 'other-path.test'` + whJoinA), closes},
	{"core.join_domains", "delete", []string{txtOnly, txtOfA}, one(`DELETE FROM core.join_domains` + whJoinA), closes},
	{"core.join_domains", "insert", []string{txtOnly, txtOfA},
		one(`INSERT INTO core.join_domains (tenant_id, name, clerk_org_id, source, verified_at) VALUES (:B, 'path.test', 'org_path_b', 'txt', now() + interval '1 minute')`), closes},
	{"core.join_domains", "checked_at (ignored)", []string{txtOnly, txtOfA}, one(upJoin + `checked_at = now(), rules = '[]'` + whJoinA), ignored},
}

// pathWorld is the scratch database the path tests write to, as the owner, and
// the front's own role it reads with.
type pathWorld struct {
	t     testing.TB
	admin *pgxpool.Pool
	store *projection.Postgres
}

func newPathWorld(t testing.TB) *pathWorld {
	dsn, admin := os.Getenv("AUTHD_TEST_MAILFRONT_DATABASE_URL"), os.Getenv("AUTHD_TEST_ADMIN_DATABASE_URL")
	if dsn == "" || admin == "" {
		t.Skip("AUTHD_TEST_MAILFRONT_DATABASE_URL and AUTHD_TEST_ADMIN_DATABASE_URL are not both set")
	}
	ctx := context.Background()
	w, err := pgxpool.New(ctx, admin)
	if err != nil {
		t.Fatalf("connect as admin: %v", err)
	}
	t.Cleanup(w.Close)
	store, err := projection.NewPostgres(ctx, dsn)
	if err != nil {
		t.Fatalf("connect as mailfront: %v", err)
	}
	t.Cleanup(store.Close)
	pw := &pathWorld{t: t, admin: w, store: store}
	t.Cleanup(pw.purge)
	return pw
}

// purge deletes the fixture: the tenants take their domains, proofs,
// connections, SSO rows and managed rows with them.
func (pw *pathWorld) purge() {
	ctx := context.Background()
	for _, q := range []string{
		`DELETE FROM authd.accounts WHERE clerk_user_id LIKE 'user_path_%'`,
		`DELETE FROM core.tenants WHERE slug IN ('path-a', 'path-b')`,
	} {
		if _, err := pw.admin.Exec(ctx, q); err != nil {
			pw.t.Logf("purge: %v", err)
		}
	}
}

// reset makes the fixture: two workspaces, two of A's connections, A's proved
// and hosted path.test, and Alice on it. Then the path's own setup.
func (pw *pathWorld) reset(setup []string) {
	pw.t.Helper()
	pw.purge()
	pw.exec(append([]string{
		`INSERT INTO core.tenants (slug, name, owner_clerk_user_id) VALUES ('path-a', 'Path A', 'user_owner'), ('path-b', 'Path B', 'user_owner')`,
		`INSERT INTO identity.connections (id, tenant_id, name, protocol) VALUES (:connA, :A, 'A', 'saml'), (:connB, :A, 'B', 'saml')`,
		`INSERT INTO core.domains (tenant_id, name, hosts_mailboxes, status, identity_registered_at) VALUES (:A, 'path.test', true, 'verified', now())`,
		`INSERT INTO authd.accounts (clerk_user_id, email, active, tenant_id, clerk_updated_at) VALUES (:alice, 'alice@path.test', true, :A, now())`,
	}, setup...))
}

// exec runs statements in ONE transaction and commits it.
func (pw *pathWorld) exec(stmts []string) {
	pw.t.Helper()
	ctx := context.Background()
	tx, err := pw.admin.Begin(ctx)
	if err != nil {
		pw.t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, q := range stmts {
		if _, err := tx.Exec(ctx, pathNames.Replace(q)); err != nil {
			pw.t.Fatalf("%s: %v", q, err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		pw.t.Fatal(err)
	}
}

// signIn reads Alice's row as the front does before it forwards a sign-in.
func (pw *pathWorld) signIn() Grant {
	pw.t.Helper()
	acct, err := pw.store.AccountByLogin(context.Background(), "alice@path.test")
	g, reason := admit(acct, err, time.Now().Add(time.Hour))
	if reason != "" {
		pw.t.Fatalf("the setup does not let Alice sign in: %s", reason)
	}
	return g
}

// ⚠ EVERY GATE INPUT, COMMITTED, REACHES THE CHANGE-DRIVEN POLL. For each path
// in gatePaths: Alice signs in and is registered, a first poll re-checks her as
// new, a second reads nothing about her, the change commits, and the next poll
// (never the backstop's full sweep) must do what the path says.
func TestEveryGateInputReachesThePoll(t *testing.T) {
	pw := newPathWorld(t)
	for _, p := range gatePaths {
		t.Run(p.table+"/"+p.name, func(t *testing.T) {
			pw.t = t
			pw.reset(p.setup)
			srv := NewServer(pw.store, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
			sw := srv.Sweeper(time.Second, 30*time.Second)
			var mu sync.Mutex
			reason := ""
			srv.reg.add(pw.signIn(), func(r string) { mu.Lock(); reason = r; mu.Unlock() })

			ctx := context.Background()
			if st := sw.Poll(ctx); st.Err != nil || st.Accounts != 1 || st.Closed != 0 {
				t.Fatalf("first poll %+v, want Alice re-checked as new and kept", st)
			}
			if st := sw.Poll(ctx); st.Err != nil || st.Accounts != 0 {
				t.Fatalf("quiet poll %+v, want no account read", st)
			}
			pw.exec(p.change)
			st := sw.Poll(ctx)
			if st.Err != nil {
				t.Fatal(st.Err)
			}
			mu.Lock()
			got := reason
			mu.Unlock()
			switch p.want {
			case closes:
				if st.Full || st.Closed != 1 || got == "" {
					t.Fatalf("poll %+v (reason %q), want Alice closed by the change-driven poll", st, got)
				}
			case rechecks:
				if st.Full || st.Accounts != 1 || st.Closed != 0 {
					t.Fatalf("poll %+v (reason %q), want Alice read and kept", st, got)
				}
			case ignored:
				if st.Full || st.Accounts != 0 {
					t.Fatalf("poll %+v, want nothing about Alice logged", st)
				}
			case sweepsAll:
				if !st.Full || len(sw.fullSweep) != 1 {
					t.Fatalf("poll %+v, want a full sweep asked for", st)
				}
				if sweep := sw.Sweep(ctx); sweep.Err != nil || sweep.Accounts != 1 || sweep.Closed != 0 {
					t.Fatalf("the sweep it asked for %+v, want Alice re-checked and kept", sweep)
				}
			}
		})
	}
}

// The registration race against the real log: a revocation that a poll read
// before Alice's connection was registered still closes it at the next poll.
func TestAPollRechecksAConnectionThatSignedInDuringAChangeOnTheDatabase(t *testing.T) {
	pw := newPathWorld(t)
	pw.reset(nil)
	pw.exec([]string{`INSERT INTO authd.accounts (clerk_user_id, email, active, tenant_id) VALUES ('user_path_bob', 'bob@path.test', true, :A)`})
	srv := NewServer(pw.store, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	sw := srv.Sweeper(time.Second, 30*time.Second)
	ctx := context.Background()
	acct, err := pw.store.AccountByLogin(ctx, "bob@path.test")
	bob, _ := admit(acct, err, time.Time{})
	srv.reg.add(bob, func(string) {})
	sw.Poll(ctx)

	alice := pw.signIn()
	pw.exec(one(upAlice + `suspended_at = now()` + whAlice))
	if st := sw.Poll(ctx); st.Err != nil || st.Changes == 0 || st.Closed != 0 {
		t.Fatalf("poll %+v, want the change read and nobody closed", st)
	}
	closed := make(chan string, 1)
	srv.reg.add(alice, func(r string) { closed <- r })
	if st := sw.Poll(ctx); st.Err != nil || st.Closed != 1 {
		t.Fatalf("poll %+v, want the new connection re-checked and closed", st)
	}
	if r := <-closed; r != "mailbox_suspended" {
		t.Fatalf("closed for %q", r)
	}
}

// TestRevocationLatency measures, for every path that closes, the time from
// COMMIT returning to the connection closing, with the real Sweeper running at
// its production interval (Run: a poll every second, the backstop every
// minute). A measurement for docs/research/mail-device-binding.md, run when
// asked:
//
//	MAILFRONT_LATENCY_CSV=/tmp/latency.csv MAILFRONT_LATENCY_RUNS=3 \
//	AUTHD_TEST_MAILFRONT_DATABASE_URL=... AUTHD_TEST_ADMIN_DATABASE_URL=... \
//	go test -run TestRevocationLatency -v ./internal/mailfront/
func TestRevocationLatency(t *testing.T) {
	out := os.Getenv("MAILFRONT_LATENCY_CSV")
	if out == "" {
		t.Skip("MAILFRONT_LATENCY_CSV not set")
	}
	runs := 3
	if v := os.Getenv("MAILFRONT_LATENCY_RUNS"); v != "" {
		runs, _ = strconv.Atoi(v)
	}
	pw := newPathWorld(t)
	rows := [][]string{{"table", "path", "runs", "min_ms", "max_ms"}}
	var worst time.Duration
	for _, p := range gatePaths {
		if p.want != closes {
			continue
		}
		var lat []time.Duration
		for range runs {
			pw.reset(p.setup)
			srv := NewServer(pw.store, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
			sw := srv.Sweeper(time.Second, 30*time.Second)
			closed := make(chan time.Time, 1)
			srv.reg.add(pw.signIn(), func(string) {
				select {
				case closed <- time.Now():
				default:
				}
			})
			ctx, cancel := context.WithCancel(context.Background())
			go sw.Run(ctx)
			// Past the first poll, which re-checks Alice as new, and at a random
			// point of the poll's second.
			time.Sleep(1500*time.Millisecond + time.Duration(len(lat))*333*time.Millisecond)
			pw.exec(p.change)
			committed := time.Now()
			select {
			case at := <-closed:
				lat = append(lat, at.Sub(committed))
			case <-time.After(10 * time.Second):
				cancel()
				t.Fatalf("%s %s: not closed within 10 s", p.table, p.name)
			}
			cancel()
		}
		sort.Slice(lat, func(i, j int) bool { return lat[i] < lat[j] })
		worst = max(worst, lat[len(lat)-1])
		ms := func(d time.Duration) string { return fmt.Sprintf("%.0f", float64(d.Microseconds())/1000) }
		rows = append(rows, []string{p.table, p.name, strconv.Itoa(len(lat)), ms(lat[0]), ms(lat[len(lat)-1])})
		t.Logf("%s %s: %s .. %s", p.table, p.name, lat[0], lat[len(lat)-1])
	}
	f, err := os.Create(out)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	_ = csv.NewWriter(f).WriteAll(rows)
	if worst > 1500*time.Millisecond {
		t.Fatalf("the slowest revocation took %s, want about a second", worst)
	}
}
