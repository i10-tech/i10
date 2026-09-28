package projection

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

var fast = dialPolicy{
	budget:  200 * time.Millisecond,
	attempt: 50 * time.Millisecond,
	base:    2 * time.Millisecond,
	max:     10 * time.Millisecond,
}

// refused stands in for the ClusterIP race: a transport error with no answer
// from Postgres behind it.
var refused = errors.New("dial tcp 10.43.50.120:5432: connect: connection refused")

// failing returns a ping that fails n times and then succeeds, counting calls.
func failing(n int, err error) (func(context.Context) error, *int) {
	calls := 0
	return func(context.Context) error {
		calls++
		if calls <= n {
			return err
		}
		return nil
	}, &calls
}

// ⚠ THE CASE THAT FAILED THE DEPLOY. The first connections are refused and a
// later one lands; startup must succeed instead of exiting on the first.
func TestRetriesUntilReachable(t *testing.T) {
	ping, calls := failing(3, refused)
	if err := pingUntilReachable(context.Background(), ping, fast, quiet); err != nil {
		t.Fatalf("gave up on a database that became reachable: %v", err)
	}
	if *calls != 4 {
		t.Fatalf("pinged %d times, want 4", *calls)
	}
}

func TestGivesUpAfterBudgetWithLastError(t *testing.T) {
	ping, calls := failing(1<<30, refused)
	start := time.Now()
	err := pingUntilReachable(context.Background(), ping, fast, quiet)
	if !errors.Is(err, refused) {
		t.Fatalf("err = %v, want the ping's own error", err)
	}
	if elapsed := time.Since(start); elapsed > fast.budget+fast.max {
		t.Fatalf("took %s, budget is %s", elapsed, fast.budget)
	}
	if *calls < 2 {
		t.Fatalf("pinged %d times; the budget allows several", *calls)
	}
}

// ⚠ A CONFIGURATION IS NOT A RACE. Postgres answered, so retrying only delays
// the error that names the misconfiguration.
func TestDoesNotRetryAServerAnswer(t *testing.T) {
	denied := &pgconn.PgError{Code: "28P01", Message: "password authentication failed"}
	ping, calls := failing(1<<30, denied)
	err := pingUntilReachable(context.Background(), ping, fast, quiet)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		t.Fatalf("err = %v, want the PgError", err)
	}
	if *calls != 1 {
		t.Fatalf("pinged %d times, want 1", *calls)
	}
}

func TestStopsOnCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	calls := 0
	ping := func(context.Context) error {
		calls++
		if calls == 2 {
			cancel() // SIGTERM mid-startup
		}
		return refused
	}
	slow := fast
	slow.budget = time.Minute
	start := time.Now()
	if err := pingUntilReachable(ctx, ping, slow, quiet); err == nil {
		t.Fatal("returned nil after cancellation")
	}
	if time.Since(start) > time.Second {
		t.Fatal("kept retrying after the context was cancelled")
	}
	if calls != 2 {
		t.Fatalf("pinged %d times after cancel, want 2", calls)
	}
}
