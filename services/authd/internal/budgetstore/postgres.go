// Package budgetstore keeps the shared failure budget in Postgres.
//
// Both Stalwart pods run an authd, and each must see the other's forwarded
// failures, so the count lives in `authd.bind_failure_budget`. It holds a
// counter and the instant its window opened, keyed by Clerk user id - no
// password, no hash, nothing derived from either.
package budgetstore

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/i10-tech/i10/services/authd/internal/verify"
)

// Postgres implements verify.BudgetStore.
//
// ⚠ ONE STATEMENT PER OPERATION AND NO PREPARED STATEMENTS. authd reaches
// Postgres through PgBouncer in transaction mode, where a multi-statement
// sequence can land on different server connections and a prepared statement
// does not survive between transactions. The pool is built with
// QueryExecModeExec (see projection.NewPostgres), and every operation here is a
// single statement, so each one is its own atomic transaction.
type Postgres struct{ pool *pgxpool.Pool }

func NewPostgres(pool *pgxpool.Pool) *Postgres { return &Postgres{pool: pool} }

// reserveSQL takes a slot or reports that none is left, in one atomic upsert.
//
// ⚠ WHY THIS NEVER FORWARDS MORE THAN MAX, WITH ANY NUMBER OF CONCURRENT
// CALLERS ON ANY NUMBER OF PODS. `INSERT ... ON CONFLICT DO UPDATE` takes a row
// lock on the conflicting row and, under READ COMMITTED, re-evaluates the
// `WHERE` against the row's LATEST committed version once the lock is held. Two
// reservers therefore serialise on the row: the second one sees the count the
// first one wrote. The first reservation for a user is the plain INSERT branch,
// and two racing inserts cannot both succeed - the loser conflicts and takes the
// UPDATE branch behind the winner.
//
//   - A missing row inserts at count 1, so Max must be at least 1 (Reserve
//     refuses lower without asking the database).
//   - An expired window restarts: window_start becomes now() and the count 1.
//   - Otherwise the count rises by one, but only while it is below Max. When it
//     is not, the WHERE is false, no row is updated, and RETURNING yields nothing
//   - which is the answer "budget spent".
//
// Time comes from the database's now(), not from the pod, so two pods with
// skewed clocks agree on when a window ends. now() is the start of the
// statement's own transaction, which for a single statement is the statement.
const reserveSQL = `
INSERT INTO authd.bind_failure_budget AS b (clerk_user_id, window_start, count)
VALUES ($1, now(), 1)
ON CONFLICT (clerk_user_id) DO UPDATE SET
	window_start = CASE WHEN b.window_start + make_interval(secs => $2::float8) <= now()
	                    THEN now() ELSE b.window_start END,
	count        = CASE WHEN b.window_start + make_interval(secs => $2::float8) <= now()
	                    THEN 1 ELSE b.count + 1 END
WHERE b.window_start + make_interval(secs => $2::float8) <= now()
   OR b.count < $3::int
RETURNING window_start`

// releaseSQL gives one slot back, floored at zero, and only in the window the
// slot was taken in. A slot whose window has since restarted was never counted
// by the new one, and decrementing it would let the new window forward Max+1.
const releaseSQL = `
UPDATE authd.bind_failure_budget
SET count = GREATEST(count - 1, 0)
WHERE clerk_user_id = $1 AND window_start = $2`

func (p *Postgres) Reserve(ctx context.Context, userID string, b verify.Budget) (verify.Slot, bool, error) {
	if b.Max < 1 || b.Window <= 0 {
		// A budget of nothing forwards nothing. Not an error: it is a
		// configuration that means "never", and the database has no say.
		return verify.Slot{}, false, nil
	}

	var window time.Time
	err := p.pool.QueryRow(ctx, reserveSQL, userID, b.Window.Seconds(), b.Max).Scan(&window)
	switch {
	case err == nil:
		return verify.Slot{Window: window}, true, nil
	case errors.Is(err, pgx.ErrNoRows):
		return verify.Slot{}, false, nil
	default:
		return verify.Slot{}, false, fmt.Errorf("budgetstore: reserve: %w", err)
	}
}

func (p *Postgres) Release(ctx context.Context, userID string, slot verify.Slot) error {
	if _, err := p.pool.Exec(ctx, releaseSQL, userID, slot.Window); err != nil {
		return fmt.Errorf("budgetstore: release: %w", err)
	}
	return nil
}

var _ verify.BudgetStore = (*Postgres)(nil)
