package projection

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
)

// The pool must stay in exec mode: PgBouncer's transaction pooling drops
// prepared statements, and SweepQuery's generic plan is hundreds of times
// slower than its custom one (NewPostgres). Skipped without a database, as the
// other projection tests are.
func TestThePoolPlansEveryStatementWithItsParameters(t *testing.T) {
	dsn := os.Getenv("AUTHD_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("AUTHD_TEST_DATABASE_URL is not set")
	}
	store, err := NewPostgres(context.Background(), dsn)
	if err != nil {
		t.Fatalf("NewPostgres: %v", err)
	}
	defer store.Close()

	if got := store.Pool().Config().ConnConfig.DefaultQueryExecMode; got != pgx.QueryExecModeExec {
		t.Fatalf("DefaultQueryExecMode = %v, want QueryExecModeExec", got)
	}
}
