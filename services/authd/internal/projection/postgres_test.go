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
