package projection

import (
	"context"
	"fmt"
	"math/rand/v2"
	"os"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Skipped unless AUTHD_TEST_DATABASE_URL points at a migrated scratch database;
// see internal/budgetstore for the same arrangement. Rows are written through a
// second, privileged connection, AUTHD_TEST_ADMIN_DATABASE_URL, because the
// `authd` role this test reads as cannot write the projection.
//
// What it proves is what a mocked Store cannot: that the column list in the
// plain SQL still matches the schema Drizzle owns. A column renamed there fails
// at runtime, on a bind, not at compile time.
func TestAccountByUIDReadsTheCredentialEpoch(t *testing.T) {
	dsn, admin := os.Getenv("AUTHD_TEST_DATABASE_URL"), os.Getenv("AUTHD_TEST_ADMIN_DATABASE_URL")
	if dsn == "" || admin == "" {
		t.Skip("AUTHD_TEST_DATABASE_URL and AUTHD_TEST_ADMIN_DATABASE_URL are not both set")
	}
	ctx := context.Background()

	w, err := pgxpool.New(ctx, admin)
	if err != nil {
		t.Fatalf("connect as admin: %v", err)
	}
	defer w.Close()

	const id, email = "user_epoch_test", "epoch-test@i10.tech"
	if _, err := w.Exec(ctx, `
		INSERT INTO authd.accounts (clerk_user_id, email, active, credential_epoch)
		VALUES ($1, $2, true, 7)
		ON CONFLICT (clerk_user_id) DO UPDATE SET credential_epoch = 7, active = true`, id, email); err != nil {
		t.Fatalf("seed: %v", err)
	}

	store, err := NewPostgres(ctx, dsn)
	if err != nil {
		t.Fatalf("NewPostgres: %v", err)
	}
	defer store.Close()

	got, err := store.AccountByUID(ctx, id)
	if err != nil || got == nil {
		t.Fatalf("AccountByUID = (%v, %v)", got, err)
	}
	if got.CredentialEpoch != 7 {
		t.Fatalf("CredentialEpoch = %d, want 7", got.CredentialEpoch)
	}

	if _, err := w.Exec(ctx, `UPDATE authd.accounts SET credential_epoch = credential_epoch + 1 WHERE clerk_user_id = $1`, id); err != nil {
		t.Fatalf("bump: %v", err)
	}
	got, err = store.AccountByUID(ctx, id)
	if err != nil || got == nil || got.CredentialEpoch != 8 {
		t.Fatalf("after a bump AccountByUID = (%+v, %v), want epoch 8", got, err)
	}

	// The by-address path shares the column list and must scan it too.
	byAddr, err := store.AccountsByAddress(ctx, []string{email})
	if err != nil || len(byAddr) != 1 || byAddr[0].CredentialEpoch != 8 {
		t.Fatalf("AccountsByAddress = (%+v, %v), want one account at epoch 8", byAddr, err)
	}
}

// The same arrangement, for what an SSO connection adds to the one account
// query (#344): who manages the account and whether the directory suspended
// it. They are read in the SAME query as the credential epoch, so the answer a
// bind acts on cannot be older than the account it belongs to.
//
// The rows go in through the privileged connection because the `authd` role
// cannot write, and `authd.managed_accounts` has foreign keys into the
// `identity` schema, so a tenant and a connection come first.
func TestAccountByUIDReadsManagedAndSuspendedWithTheEpoch(t *testing.T) {
	dsn, admin := os.Getenv("AUTHD_TEST_DATABASE_URL"), os.Getenv("AUTHD_TEST_ADMIN_DATABASE_URL")
	if dsn == "" || admin == "" {
		t.Skip("AUTHD_TEST_DATABASE_URL and AUTHD_TEST_ADMIN_DATABASE_URL are not both set")
	}
	ctx := context.Background()

	w, err := pgxpool.New(ctx, admin)
	if err != nil {
		t.Fatalf("connect as admin: %v", err)
	}
	// ⚠ A CLEANUP, NOT A defer: cleanups run after the test function returns, and
	// the one below deletes through this pool. Cleanups run last in, first out, so
	// the pool is registered first and closed last.
	t.Cleanup(w.Close)

	const id, email, slug, conn = "user_managed_test", "managed-test@acme.test", "managed-test", "55555555-5555-4555-8555-555555555555"
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := w.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("seed %q: %v", sql, err)
		}
	}
	// Deleting the tenant takes the connection and identity.managed_accounts with
	// it, and the account's authd.managed_accounts row follows by cascade. It also
	// runs first, so rows a crashed run left behind do not leak into this one.
	purge := func() {
		if _, err := w.Exec(ctx, `DELETE FROM authd.accounts WHERE clerk_user_id = $1`, id); err != nil {
			t.Logf("purge account: %v", err)
		}
		if _, err := w.Exec(ctx, `DELETE FROM core.tenants WHERE slug = $1`, slug); err != nil {
			t.Logf("purge tenant: %v", err)
		}
	}
	purge()
	t.Cleanup(purge)

	exec(`INSERT INTO core.tenants (slug, name, owner_clerk_user_id) VALUES ($1, 'Managed test', 'user_owner')
		ON CONFLICT (slug) DO NOTHING`, slug)
	exec(`INSERT INTO identity.connections (id, tenant_id, name, protocol)
		SELECT $1::uuid, id, 'Test connection', 'saml' FROM core.tenants WHERE slug = $2
		ON CONFLICT (id) DO NOTHING`, conn, slug)
	exec(`INSERT INTO identity.managed_accounts (clerk_user_id, tenant_id, connection_id, reason)
		SELECT $1, id, $2::uuid, 'scim' FROM core.tenants WHERE slug = $3
		ON CONFLICT (clerk_user_id) DO NOTHING`, id, conn, slug)
	exec(`INSERT INTO authd.accounts (clerk_user_id, email, active, credential_epoch)
		VALUES ($1, $2, true, 3)
		ON CONFLICT (clerk_user_id) DO UPDATE SET credential_epoch = 3, active = true, suspended_at = NULL`, id, email)

	store, err := NewPostgres(ctx, dsn)
	if err != nil {
		t.Fatalf("NewPostgres: %v", err)
	}
	defer store.Close()

	// Not managed yet: no row in authd.managed_accounts reads as "not managed".
	got, err := store.AccountByUID(ctx, id)
	if err != nil || got == nil {
		t.Fatalf("AccountByUID = (%v, %v)", got, err)
	}
	if got.Managed || got.ManagedConnection != "" || got.Suspended || got.CredentialEpoch != 3 {
		t.Fatalf("unmanaged account read as %+v", got)
	}

	exec(`INSERT INTO authd.managed_accounts (clerk_user_id, connection_id) VALUES ($1, $2::uuid)
		ON CONFLICT (clerk_user_id) DO UPDATE SET connection_id = EXCLUDED.connection_id`, id, conn)
	exec(`UPDATE authd.accounts SET suspended_at = now(), credential_epoch = 4 WHERE clerk_user_id = $1`, id)

	got, err = store.AccountByUID(ctx, id)
	if err != nil || got == nil {
		t.Fatalf("AccountByUID = (%v, %v)", got, err)
	}
	if !got.Managed || got.ManagedConnection != conn || !got.Suspended || got.CredentialEpoch != 4 {
		t.Fatalf("managed, suspended account at epoch 4 read as %+v", got)
	}
	// No version row yet for the connection reads as 0.
	if got.PassthroughVersion != 0 {
		t.Fatalf("PassthroughVersion = %d before any row, want 0", got.PassthroughVersion)
	}

	// The connection's pass-through version comes with the account, in the bind's
	// own query, as the `authd` role (through its schema's default privileges).
	exec(`INSERT INTO authd.passthrough_versions (connection_id, version, fingerprint) VALUES ($1::uuid, 7, 'x')
		ON CONFLICT (connection_id) DO UPDATE SET version = 7`, conn)
	got, err = store.AccountByUID(ctx, id)
	if err != nil || got == nil || got.PassthroughVersion != 7 {
		t.Fatalf("AccountByUID = (%+v, %v), want PassthroughVersion 7", got, err)
	}

	// A connection that was deleted leaves the account managed by NOTHING, which
	// authd must read as managed (and refuse), never as free to ask Clerk.
	exec(`UPDATE authd.managed_accounts SET connection_id = NULL WHERE clerk_user_id = $1`, id)
	byAddr, err := store.AccountsByAddress(ctx, []string{email})
	if err != nil || len(byAddr) != 1 {
		t.Fatalf("AccountsByAddress = (%+v, %v)", byAddr, err)
	}
	if !byAddr[0].Managed || byAddr[0].ManagedConnection != "" {
		t.Fatalf("an account whose connection is gone read as %+v, want managed with no connection", byAddr[0])
	}
}

// The rest of what turns a login off, in the same query (apps/api/src/mailboxes/
// revoke.ts writes these). All four are read from the row the bind holds, as the
// `authd` role: the required-domains table is new, and the role has to be able to
// read it through the schema's default privileges, which only a real database
// shows.
func TestAccountByUIDReadsTheRowGates(t *testing.T) {
	dsn, admin := os.Getenv("AUTHD_TEST_DATABASE_URL"), os.Getenv("AUTHD_TEST_ADMIN_DATABASE_URL")
	if dsn == "" || admin == "" {
		t.Skip("AUTHD_TEST_DATABASE_URL and AUTHD_TEST_ADMIN_DATABASE_URL are not both set")
	}
	ctx := context.Background()

	w, err := pgxpool.New(ctx, admin)
	if err != nil {
		t.Fatalf("connect as admin: %v", err)
	}
	t.Cleanup(w.Close)

	const id, email, slug, conn, otherConn = "user_gates_test", "gates-test@required.test", "gates-test",
		"66666666-6666-4666-8666-666666666666", "99999999-9999-4999-8999-999999999999"
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := w.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("seed %q: %v", sql, err)
		}
	}
	purge := func() {
		if _, err := w.Exec(ctx, `DELETE FROM authd.accounts WHERE clerk_user_id = $1`, id); err != nil {
			t.Logf("purge account: %v", err)
		}
		// Takes the connection and the required-domains row with it.
		if _, err := w.Exec(ctx, `DELETE FROM core.tenants WHERE slug = $1`, slug); err != nil {
			t.Logf("purge tenant: %v", err)
		}
	}
	purge()
	t.Cleanup(purge)

	exec(`INSERT INTO core.tenants (slug, name, owner_clerk_user_id) VALUES ($1, 'Gates test', 'user_owner')`, slug)
	exec(`INSERT INTO identity.connections (id, tenant_id, name, protocol)
		SELECT $1::uuid, id, 'Test connection', 'saml' FROM core.tenants WHERE slug = $2`, conn, slug)
	exec(`INSERT INTO authd.accounts (clerk_user_id, email, active, tenant_id)
		SELECT $1, $2, true, id FROM core.tenants WHERE slug = $3`, id, email, slug)

	store, err := NewPostgres(ctx, dsn)
	if err != nil {
		t.Fatalf("NewPostgres: %v", err)
	}
	defer store.Close()

	read := func() Account {
		t.Helper()
		got, err := store.AccountByUID(ctx, id)
		if err != nil || got == nil {
			t.Fatalf("AccountByUID = (%v, %v)", got, err)
		}
		byAddr, err := store.AccountsByAddress(ctx, []string{email})
		if err != nil || len(byAddr) != 1 {
			t.Fatalf("AccountsByAddress = (%+v, %v)", byAddr, err)
		}
		// The search path and the bind path share the column list.
		if byAddr[0].PaymentHold != got.PaymentHold || byAddr[0].Banned != got.Banned ||
			byAddr[0].Locked != got.Locked || byAddr[0].SSORequired != got.SSORequired ||
			byAddr[0].SSOExempt != got.SSOExempt || byAddr[0].Deleting != got.Deleting {
			t.Fatalf("search read %+v, bind read %+v", byAddr[0], got)
		}
		return *got
	}

	if a := read(); a.PaymentHold || a.Banned || a.Locked || a.SSORequired {
		t.Fatalf("a clean account read as %+v", a)
	}

	exec(`UPDATE authd.accounts SET payment_hold_at = now() WHERE clerk_user_id = $1`, id)
	if a := read(); !a.PaymentHold || a.Banned || a.Locked || a.SSORequired {
		t.Fatalf("a payment hold read as %+v", a)
	}
	exec(`UPDATE authd.accounts SET payment_hold_at = NULL, deleting_at = now() WHERE clerk_user_id = $1`, id)
	if a := read(); !a.Deleting || a.PaymentHold || a.Banned || a.Suspended {
		t.Fatalf("a deletion grace read as %+v", a)
	}
	exec(`UPDATE authd.accounts SET deleting_at = NULL, banned = true WHERE clerk_user_id = $1`, id)
	if a := read(); a.Deleting {
		t.Fatalf("a restored mailbox still read as deleting: %+v", a)
	}
	if a := read(); a.PaymentHold || !a.Banned || a.Locked {
		t.Fatalf("a ban read as %+v", a)
	}
	exec(`UPDATE authd.accounts SET banned = false, locked = true WHERE clerk_user_id = $1`, id)
	if a := read(); a.Banned || !a.Locked {
		t.Fatalf("an indefinite lock read as %+v", a)
	}
	// A lockout ends by itself and Clerk says nothing when it does, so the row's
	// own end time is what lifts it.
	exec(`UPDATE authd.accounts SET locked_until = now() + interval '1 hour' WHERE clerk_user_id = $1`, id)
	if a := read(); !a.Locked {
		t.Fatalf("a lockout that has not run out read as %+v", a)
	}
	exec(`UPDATE authd.accounts SET locked_until = now() - interval '1 second' WHERE clerk_user_id = $1`, id)
	if a := read(); a.Locked {
		t.Fatalf("a lockout that has run out still read as locked: %+v", a)
	}
	exec(`UPDATE authd.accounts SET locked = false, locked_until = NULL WHERE clerk_user_id = $1`, id)

	// SSO is required for the DOMAIN, and a row for another domain says nothing
	// about this account.
	exec(`INSERT INTO authd.required_domains (domain, tenant_id, connection_id)
		SELECT 'other.test', id, $1::uuid FROM core.tenants WHERE slug = $2`, conn, slug)
	if a := read(); a.SSORequired {
		t.Fatalf("a required domain that is not the account's marked it: %+v", a)
	}
	exec(`INSERT INTO authd.required_domains (domain, tenant_id, connection_id)
		SELECT 'required.test', id, $1::uuid FROM core.tenants WHERE slug = $2`, conn, slug)
	if a := read(); !a.SSORequired {
		t.Fatalf("an account on a required domain read as %+v", a)
	}
	// A row left behind for another workspace's name binds nobody of this one's.
	exec(`UPDATE authd.accounts SET tenant_id = NULL WHERE clerk_user_id = $1`, id)
	if a := read(); a.SSORequired {
		t.Fatalf("a required domain of another workspace marked this account: %+v", a)
	}
	exec(`UPDATE authd.accounts SET tenant_id = (SELECT id FROM core.tenants WHERE slug = $2) WHERE clerk_user_id = $1`, id, slug)

	// ⚠ WHO SSO EXEMPTS IS READ FROM THE SAME ROW, THROUGH THE CONNECTION THAT
	// REQUIRES THE DOMAIN. `authd.required_exempt` is new too: the `authd` role has to
	// read it through the schema's default privileges.
	if a := read(); !a.SSORequired || a.SSOExempt {
		t.Fatalf("a required, unexempt account read as %+v", a)
	}
	exec(`INSERT INTO identity.connections (id, tenant_id, name, protocol)
		SELECT $1::uuid, id, 'Other connection', 'saml' FROM core.tenants WHERE slug = $2`, otherConn, slug)
	grant := func(connection, source string) {
		exec(`INSERT INTO authd.required_exempt (connection_id, tenant_id, clerk_user_id, source)
			SELECT $1::uuid, id, $2, $3 FROM core.tenants WHERE slug = $4`, connection, id, source, slug)
	}
	// A pass for ANOTHER connection says nothing about this domain's.
	grant(otherConn, "bypass")
	if a := read(); !a.SSORequired || a.SSOExempt {
		t.Fatalf("a bypass for another connection exempted the account: %+v", a)
	}
	grant(conn, "owner_exemption")
	if a := read(); !a.SSORequired || !a.SSOExempt {
		t.Fatalf("an exempt owner on a required domain read as %+v", a)
	}
	// A row left behind for a name that changed hands exempts nobody there either.
	exec(`UPDATE authd.accounts SET tenant_id = NULL WHERE clerk_user_id = $1`, id)
	if a := read(); a.SSORequired || a.SSOExempt {
		t.Fatalf("another workspace's domain marked this account: %+v", a)
	}
	exec(`UPDATE authd.accounts SET tenant_id = (SELECT id FROM core.tenants WHERE slug = $2) WHERE clerk_user_id = $1`, id, slug)
	// Removed from the exemption: the very next read says so.
	exec(`DELETE FROM authd.required_exempt WHERE clerk_user_id = $1 AND connection_id = $2::uuid`, id, conn)
	if a := read(); !a.SSORequired || a.SSOExempt {
		t.Fatalf("losing the exemption did not show: %+v", a)
	}
	// And an exemption means nothing once the domain is not required at all.
	grant(conn, "bypass")
	exec(`DELETE FROM authd.required_domains WHERE domain = 'required.test'`)
	if a := read(); a.SSORequired || a.SSOExempt {
		t.Fatalf("turning the requirement off did not restore the account: %+v", a)
	}
}

// The domain gate (#406), against the real function: whether an account's domain
// still hosts mail is read in the SAME query as the account, as the `authd` role,
// which may execute `core.mailbox_domain_refused` and nothing else in `core`.
//
// What a mocked Store cannot prove, and what each case pins:
//   - hosting on and the workspace holding the name: not refused;
//   - hosting switched off: refused, with nothing written to the mailbox, so a
//     suspension an admin set by hand is neither added nor lifted by it;
//   - the domain taken by another workspace's proof (displaced): refused;
//   - a name with no `core.domains` row at all (i10's own): never refused;
//   - an account with no tenant on a name that has a row but does not host: refused.
func TestAccountReadsWhetherItsDomainStillHostsMail(t *testing.T) {
	dsn, admin := os.Getenv("AUTHD_TEST_DATABASE_URL"), os.Getenv("AUTHD_TEST_ADMIN_DATABASE_URL")
	if dsn == "" || admin == "" {
		t.Skip("AUTHD_TEST_DATABASE_URL and AUTHD_TEST_ADMIN_DATABASE_URL are not both set")
	}
	ctx := context.Background()

	w, err := pgxpool.New(ctx, admin)
	if err != nil {
		t.Fatalf("connect as admin: %v", err)
	}
	t.Cleanup(w.Close)

	const (
		slug   = "hosting-gate-test"
		domain = "hosting-gate-test.example"
		hosted = "user_hosting_gate"
		bare   = "user_hosting_gate_none"
		own    = "user_hosting_gate_own"
	)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := w.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("seed %q: %v", sql, err)
		}
	}
	purge := func() {
		for _, id := range []string{hosted, bare, own} {
			if _, err := w.Exec(ctx, `DELETE FROM authd.accounts WHERE clerk_user_id = $1`, id); err != nil {
				t.Logf("purge account: %v", err)
			}
		}
		if _, err := w.Exec(ctx, `DELETE FROM core.tenants WHERE slug = $1`, slug); err != nil {
			t.Logf("purge tenant: %v", err)
		}
	}
	purge()
	t.Cleanup(purge)

	exec(`INSERT INTO core.tenants (slug, name, owner_clerk_user_id) VALUES ($1, 'Hosting gate test', 'user_owner')`, slug)
	// Proven by DKIM at some point, SES never verified it: the point of #406 is that
	// this still hosts.
	exec(`INSERT INTO core.domains (tenant_id, name, hosts_mailboxes, identity_registered_at, status)
		SELECT id, $2, true, now(), 'pending' FROM core.tenants WHERE slug = $1`, slug, domain)
	exec(`INSERT INTO authd.accounts (clerk_user_id, email, active, tenant_id)
		SELECT $1, $2, true, id FROM core.tenants WHERE slug = $3`, hosted, "ada@"+domain, slug)
	// No tenant, on a name that has a row.
	exec(`INSERT INTO authd.accounts (clerk_user_id, email, active) VALUES ($1, $2, true)`, bare, "bob@"+domain)
	// No tenant, on a name nobody registered: i10's own shape.
	exec(`INSERT INTO authd.accounts (clerk_user_id, email, active) VALUES ($1, $2, true)`, own, "own@unregistered-hosting-gate.example")

	store, err := NewPostgres(ctx, dsn)
	if err != nil {
		t.Fatalf("NewPostgres: %v", err)
	}
	defer store.Close()

	// ⚠ EVERY ANSWER IS ASKED TWICE: as a bind reads it, and as the mail front's
	// sweep does (SweepQuery judges each domain once for all its accounts). The
	// two must never disagree, or an open connection outlives what a new
	// sign-in is refused for.
	refused := func(id string) bool {
		t.Helper()
		got, err := store.AccountByUID(ctx, id)
		if err != nil || got == nil {
			t.Fatalf("AccountByUID(%s) = (%v, %v)", id, got, err)
		}
		swept, err := store.AccountsByUIDs(ctx, []string{hosted, bare, own})
		if err != nil || len(swept) != 3 {
			t.Fatalf("AccountsByUIDs = (%d rows, %v), want 3", len(swept), err)
		}
		for _, a := range swept {
			if a.ClerkUserID == id && a.DomainNotHosted != got.DomainNotHosted {
				t.Fatalf("%s: the sweep reads DomainNotHosted=%v, a bind %v", id, a.DomainNotHosted, got.DomainNotHosted)
			}
		}
		return got.DomainNotHosted
	}

	if refused(hosted) {
		t.Fatal("a mailbox on a hosted, owned domain was refused")
	}
	if refused(own) {
		t.Fatal("an unregistered domain (i10's own) was refused")
	}

	// A hand-set suspension, to prove hosting off neither adds nor lifts one.
	exec(`UPDATE authd.accounts SET suspended_at = now() WHERE clerk_user_id = $1`, hosted)

	exec(`UPDATE core.domains SET hosts_mailboxes = false WHERE name = $1`, domain)
	if !refused(hosted) || !refused(bare) {
		t.Fatal("hosting off did not refuse the mailboxes on the domain")
	}
	if refused(own) {
		t.Fatal("hosting off on one domain refused an unrelated one")
	}
	var suspended bool
	if err := w.QueryRow(ctx, `SELECT suspended_at IS NOT NULL FROM authd.accounts WHERE clerk_user_id = $1`, hosted).Scan(&suspended); err != nil || !suspended {
		t.Fatalf("the hand-set suspension changed (suspended=%v, err=%v)", suspended, err)
	}

	// Back on: the gate opens by itself, and the suspension is still there.
	exec(`UPDATE core.domains SET hosts_mailboxes = true WHERE name = $1`, domain)
	if refused(hosted) {
		t.Fatal("hosting back on left the mailbox refused")
	}
	if err := w.QueryRow(ctx, `SELECT suspended_at IS NOT NULL FROM authd.accounts WHERE clerk_user_id = $1`, hosted).Scan(&suspended); err != nil || !suspended {
		t.Fatalf("hosting back on lifted the hand-set suspension (suspended=%v, err=%v)", suspended, err)
	}

	// Another workspace proved the name: displaced rows never host.
	exec(`UPDATE core.domains SET displaced_at = now(), status = 'failed' WHERE name = $1`, domain)
	if !refused(hosted) {
		t.Fatal("a displaced domain still let its mailboxes sign in")
	}
}

// The mail front's two reads: by login before a sign-in is forwarded, and by id
// for the sweep. Both return the bind's gate columns, never an inactive row, and
// the login matches the primary address only, as Stalwart's filterLogin does.
func TestTheMailFrontsReads(t *testing.T) {
	dsn, admin := os.Getenv("AUTHD_TEST_DATABASE_URL"), os.Getenv("AUTHD_TEST_ADMIN_DATABASE_URL")
	if dsn == "" || admin == "" {
		t.Skip("AUTHD_TEST_DATABASE_URL and AUTHD_TEST_ADMIN_DATABASE_URL are not both set")
	}
	ctx := context.Background()
	w, err := pgxpool.New(ctx, admin)
	if err != nil {
		t.Fatalf("connect as admin: %v", err)
	}
	t.Cleanup(w.Close)
	ids := []string{"user_front_a", "user_front_b", "user_front_gone"}
	purge := func() {
		for _, id := range ids {
			_, _ = w.Exec(ctx, `DELETE FROM authd.accounts WHERE clerk_user_id = $1`, id)
		}
	}
	purge()
	t.Cleanup(purge)
	for _, q := range []string{
		`INSERT INTO authd.accounts (clerk_user_id, email, active, credential_epoch) VALUES ('user_front_a', 'front-a@front.example', true, 5)`,
		`INSERT INTO authd.accounts (clerk_user_id, email, active, suspended_at) VALUES ('user_front_b', 'front-b@front.example', true, now())`,
		`INSERT INTO authd.accounts (clerk_user_id, email, active) VALUES ('user_front_gone', 'front-gone@front.example', false)`,
		`INSERT INTO authd.aliases (clerk_user_id, address) VALUES ('user_front_a', 'alias-a@front.example')`,
	} {
		if _, err := w.Exec(ctx, q); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	store, err := NewPostgres(ctx, dsn)
	if err != nil {
		t.Fatalf("NewPostgres: %v", err)
	}
	defer store.Close()

	got, err := store.AccountByLogin(ctx, "  Front-A@FRONT.example ")
	if err != nil || got == nil || got.ClerkUserID != "user_front_a" || got.CredentialEpoch != 5 {
		t.Fatalf("AccountByLogin = (%+v, %v)", got, err)
	}
	if got, err := store.AccountByLogin(ctx, "alias-a@front.example"); err != nil || got != nil {
		t.Fatalf("an alias signed in as %+v (%v); filterLogin reads mail, the primary address", got, err)
	}
	if got, err := store.AccountByLogin(ctx, "front-gone@front.example"); err != nil || got != nil {
		t.Fatalf("an inactive account resolved: %+v (%v)", got, err)
	}

	swept, err := store.AccountsByUIDs(ctx, append(ids, "user_front_never"))
	if err != nil {
		t.Fatal(err)
	}
	if len(swept) != 2 {
		t.Fatalf("AccountsByUIDs returned %d rows, want the two active ones", len(swept))
	}
	for _, a := range swept {
		one, err := store.AccountByUID(ctx, a.ClerkUserID)
		if err != nil || one == nil {
			t.Fatal(err)
		}
		one.Aliases, one.MemberOf = nil, nil
		if !reflect.DeepEqual(&a, one) {
			t.Fatalf("the sweep read %+v, a bind %+v", a, *one)
		}
	}
}

// The mail front's own role (`mailfront`, apps/api/drizzle/*_mailfront_role_
// grants) can run both of the front's reads, every gate column included, and
// can write nothing: least of all the failure budget, which `authd` may write.
func TestTheMailFrontRoleReadsTheGateAndWritesNothing(t *testing.T) {
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
	purge := func() { _, _ = w.Exec(ctx, `DELETE FROM authd.accounts WHERE clerk_user_id = 'user_front_role'`) }
	purge()
	t.Cleanup(purge)
	if _, err := w.Exec(ctx, `INSERT INTO authd.accounts (clerk_user_id, email, active) VALUES ('user_front_role', 'front-role@front.example', true)`); err != nil {
		t.Fatal(err)
	}

	store, err := NewPostgres(ctx, dsn)
	if err != nil {
		t.Fatalf("NewPostgres as mailfront: %v", err)
	}
	defer store.Close()
	if got, err := store.AccountByLogin(ctx, "front-role@front.example"); err != nil || got == nil {
		t.Fatalf("AccountByLogin as mailfront = (%v, %v)", got, err)
	}
	if got, err := store.AccountsByUIDs(ctx, []string{"user_front_role"}); err != nil || len(got) != 1 {
		t.Fatalf("AccountsByUIDs as mailfront = (%d rows, %v)", len(got), err)
	}
	for _, q := range []string{
		`INSERT INTO authd.bind_failure_budget (clerk_user_id, window_start, count) VALUES ('user_front_role', now(), 0)`,
		`UPDATE authd.accounts SET credential_epoch = credential_epoch + 1 WHERE clerk_user_id = 'user_front_role'`,
		`SELECT 1 FROM authd.aliases LIMIT 1`,
		`SELECT 1 FROM core.domains LIMIT 1`,
	} {
		if _, err := store.Pool().Exec(ctx, q); err == nil {
			t.Errorf("the mailfront role may run %q", q)
		}
	}
}

// oldAccountsByAddress is AccountsByAddress' statement before the scale harness
// (finding 1, docs/research/db-scale/README.md): one OR with a correlated alias
// subquery, which read every active account. It is kept here only as the
// reference the rewrite must agree with, on the same column list.
const oldAccountsByAddress = `
	SELECT ` + accountColumns + `
	` + accountFrom + `
	WHERE a.active
	  AND (a.email = ANY($1)
	       OR EXISTS (SELECT 1 FROM authd.aliases al
	                  WHERE al.clerk_user_id = a.clerk_user_id
	                    AND al.address = ANY($1)))`

// addressFixture writes accounts and aliases through the privileged connection
// and removes every row it wrote, before and after the test. Every id starts
// with prefix and every address ends in @domain, so runs of other tests in the
// same database are untouched.
type addressFixture struct {
	t      *testing.T
	ctx    context.Context
	w      *pgxpool.Pool
	store  *Postgres
	prefix string
}

func newAddressFixture(t *testing.T, prefix string) *addressFixture {
	t.Helper()
	dsn, admin := os.Getenv("AUTHD_TEST_DATABASE_URL"), os.Getenv("AUTHD_TEST_ADMIN_DATABASE_URL")
	if dsn == "" || admin == "" {
		t.Skip("AUTHD_TEST_DATABASE_URL and AUTHD_TEST_ADMIN_DATABASE_URL are not both set")
	}
	ctx := context.Background()
	w, err := pgxpool.New(ctx, admin)
	if err != nil {
		t.Fatalf("connect as admin: %v", err)
	}
	t.Cleanup(w.Close)
	f := &addressFixture{t: t, ctx: ctx, w: w, prefix: prefix}
	f.purge()
	t.Cleanup(f.purge)

	store, err := NewPostgres(ctx, dsn)
	if err != nil {
		t.Fatalf("NewPostgres: %v", err)
	}
	t.Cleanup(store.Close)
	f.store = store
	return f
}

// Aliases go with their account (ON DELETE CASCADE).
func (f *addressFixture) purge() {
	if _, err := f.w.Exec(f.ctx, `DELETE FROM authd.accounts WHERE starts_with(clerk_user_id, $1)`, f.prefix); err != nil {
		f.t.Logf("purge: %v", err)
	}
}

func (f *addressFixture) account(id, email string, active bool, aliases ...string) {
	f.t.Helper()
	if _, err := f.w.Exec(f.ctx, `INSERT INTO authd.accounts (clerk_user_id, email, active) VALUES ($1, $2, $3)`,
		f.prefix+id, email, active); err != nil {
		f.t.Fatalf("seed account %s: %v", id, err)
	}
	for _, al := range aliases {
		if _, err := f.w.Exec(f.ctx, `INSERT INTO authd.aliases (clerk_user_id, address) VALUES ($1, $2)`,
			f.prefix+id, al); err != nil {
			f.t.Fatalf("seed alias %s: %v", al, err)
		}
	}
}

// ids is what AccountsByAddress returned, with the prefix stripped, in the
// order returned (no ORDER BY, so callers sort when they compare sets).
func (f *addressFixture) ids(addresses ...string) []string {
	f.t.Helper()
	got, err := f.store.AccountsByAddress(f.ctx, addresses)
	if err != nil {
		f.t.Fatalf("AccountsByAddress(%v): %v", addresses, err)
	}
	out := make([]string, len(got))
	for i, a := range got {
		out[i] = strings.TrimPrefix(a.ClerkUserID, f.prefix)
	}
	return out
}

func sorted(s []string) []string {
	s = slices.Clone(s)
	slices.Sort(s)
	return s
}

// Each way an address can name an account, against the real tables as the
// `authd` role.
func TestAccountsByAddressMatchesPrimaryAddressesAndAliases(t *testing.T) {
	f := newAddressFixture(t, "user_addr_cases_")
	const d = "@addr-cases.test"
	f.account("primary", "primary"+d, true)
	f.account("aliased", "aliased"+d, true, "alias-of-aliased"+d)
	f.account("both", "both"+d, true, "both-alias"+d)
	f.account("off", "off"+d, false, "off-alias"+d)
	// One address that is an inactive account's primary and an active
	// account's alias (no constraint spans the two tables).
	f.account("stale", "shared"+d, false)
	f.account("live", "live"+d, true, "shared"+d)

	cases := []struct {
		name      string
		addresses []string
		want      []string
	}{
		{"primary address only", []string{"primary" + d}, []string{"primary"}},
		{"alias only", []string{"alias-of-aliased" + d}, []string{"aliased"}},
		{"one account's primary and another's alias", []string{"primary" + d, "alias-of-aliased" + d}, []string{"aliased", "primary"}},
		{"one account by its primary and its alias, once", []string{"both" + d, "both-alias" + d}, []string{"both"}},
		{"inactive by primary", []string{"off" + d}, nil},
		{"inactive by alias", []string{"off-alias" + d}, nil},
		{"missing", []string{"nobody" + d}, nil},
		{"an inactive primary and an active alias on one address", []string{"shared" + d}, []string{"live"}},
		{"normalised before the lookup", []string{"  PRIMARY" + strings.ToUpper(d) + " "}, []string{"primary"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := sorted(f.ids(c.addresses...)); !slices.Equal(got, c.want) {
				t.Fatalf("AccountsByAddress(%v) = %v, want %v", c.addresses, got, c.want)
			}
		})
	}

	t.Run("empty input asks nothing", func(t *testing.T) {
		for _, in := range [][]string{nil, {}, {"", "  "}} {
			got, err := f.store.AccountsByAddress(f.ctx, in)
			if err != nil || got != nil {
				t.Fatalf("AccountsByAddress(%q) = (%v, %v), want (nil, nil)", in, got, err)
			}
		}
	})

	// The aliases and groups of the accounts found still come with them.
	t.Run("hydrated", func(t *testing.T) {
		got, err := f.store.AccountsByAddress(f.ctx, []string{"both-alias" + d})
		if err != nil || len(got) != 1 || !slices.Equal(got[0].Aliases, []string{"both-alias" + d}) {
			t.Fatalf("AccountsByAddress = (%+v, %v), want one account carrying its alias", got, err)
		}
	})
}

// A 50-recipient delivery: present and missing addresses, primaries and aliases
// mixed, with a duplicate account among them.
func TestAccountsByAddressFiftyRecipients(t *testing.T) {
	f := newAddressFixture(t, "user_addr_fifty_")
	const d = "@addr-fifty.test"
	var addresses, want []string
	for i := range 25 {
		id := fmt.Sprintf("r%02d", i)
		f.account(id, id+d, true, id+"-alias"+d)
		want = append(want, id)
		if i%2 == 0 {
			addresses = append(addresses, id+d)
		} else {
			addresses = append(addresses, id+"-alias"+d)
		}
	}
	// r00 is named a second time, by its alias.
	addresses = append(addresses, "r00-alias"+d)
	for i := len(addresses); i < 50; i++ {
		addresses = append(addresses, fmt.Sprintf("missing%02d%s", i, d))
	}
	if got := sorted(f.ids(addresses...)); !slices.Equal(got, want) {
		t.Fatalf("AccountsByAddress(50 addresses) = %v, want %v", got, want)
	}
}

// The rewrite against the statement it replaced, on a random fixture: the same
// accounts, with every gate column equal, for every draw of addresses.
func TestAccountsByAddressAgreesWithTheOldStatement(t *testing.T) {
	f := newAddressFixture(t, "user_addr_ref_")
	const d = "@addr-ref.test"
	rng := rand.New(rand.NewPCG(507, 1))

	var pool []string // every address the fixture wrote, primaries and aliases
	for i := range 200 {
		id := fmt.Sprintf("a%03d", i)
		var aliases []string
		for j := range rng.IntN(4) {
			aliases = append(aliases, fmt.Sprintf("%s-al%d%s", id, j, d))
		}
		f.account(id, id+d, rng.IntN(5) != 0, aliases...)
		pool = append(append(pool, id+d), aliases...)
	}
	for i := range 20 {
		pool = append(pool, fmt.Sprintf("missing%02d%s", i, d))
	}

	for draw := range 50 {
		n := 1 + rng.IntN(60)
		addresses := make([]string, n)
		for i := range addresses {
			addresses[i] = pool[rng.IntN(len(pool))]
		}

		got, err := f.store.AccountsByAddress(f.ctx, addresses)
		if err != nil {
			t.Fatalf("draw %d: AccountsByAddress: %v", draw, err)
		}
		rows, err := f.store.Pool().Query(f.ctx, oldAccountsByAddress, normalise(addresses))
		if err != nil {
			t.Fatalf("draw %d: old statement: %v", draw, err)
		}
		want, err := scanAccounts(rows)
		if err != nil {
			t.Fatalf("draw %d: scan old statement: %v", draw, err)
		}
		for i := range got {
			got[i].Aliases, got[i].MemberOf = nil, nil
		}
		byID := func(a, b Account) int { return strings.Compare(a.ClerkUserID, b.ClerkUserID) }
		slices.SortFunc(got, byID)
		slices.SortFunc(want, byID)
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("draw %d (%d addresses): the rewrite returned %d accounts, the old statement %d\nnew: %+v\nold: %+v",
				draw, n, len(got), len(want), got, want)
		}
	}
}
