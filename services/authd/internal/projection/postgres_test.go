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
