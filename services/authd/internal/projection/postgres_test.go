package projection

import (
	"context"
	"os"
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
			byAddr[0].SSOExempt != got.SSOExempt {
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
	exec(`UPDATE authd.accounts SET payment_hold_at = NULL, banned = true WHERE clerk_user_id = $1`, id)
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

	refused := func(id string) bool {
		t.Helper()
		got, err := store.AccountByUID(ctx, id)
		if err != nil || got == nil {
			t.Fatalf("AccountByUID(%s) = (%v, %v)", id, got, err)
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
