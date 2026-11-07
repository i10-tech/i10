package budgetstore

import (
	"context"
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/i10-tech/i10/services/authd/internal/verify"
)

// These run the real statements against a real Postgres, and are skipped unless
// AUTHD_TEST_DATABASE_URL points at one. There is no database in the default
// test run on purpose; the handler logic is covered against an in-memory store
// in internal/ldapsrv, and what only a database can prove is proved here.
//
// Point it at a scratch database that has migrations 0000, 0001, 0003, 0137 and
// 0138 applied, connecting AS THE `authd` ROLE - that also proves the grants in
// 0138 are enough and nothing more is needed. The tests use a fresh user id each
// run and leave their rows behind, because authd has no DELETE.
func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("AUTHD_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("AUTHD_TEST_DATABASE_URL is not set")
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatalf("parse dsn: %v", err)
	}
	// As in production: PgBouncer in transaction mode allows no prepared
	// statements.
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeExec
	cfg.MaxConns = 16
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func freshUser(t *testing.T) string {
	return fmt.Sprintf("user_test_%s_%d", t.Name(), time.Now().UnixNano())
}

var fifteenMinutes = verify.Budget{Max: 3, Window: 15 * time.Minute}

func TestReserveGrantsExactlyMaxThenRefuses(t *testing.T) {
	s := NewPostgres(testPool(t))
	user := freshUser(t)

	for i := 1; i <= 3; i++ {
		_, ok, err := s.Reserve(context.Background(), user, fifteenMinutes)
		if err != nil || !ok {
			t.Fatalf("reserve %d: ok=%v err=%v", i, ok, err)
		}
	}
	_, ok, err := s.Reserve(context.Background(), user, fifteenMinutes)
	if err != nil {
		t.Fatalf("reserve past the budget: %v", err)
	}
	if ok {
		t.Fatal("a fourth slot was granted against a budget of 3")
	}
}

// ⚠ THE PROPERTY THE WHOLE DESIGN RESTS ON. Two pods, many connections, all
// racing for the same user's budget: the number granted is Max, never more.
func TestConcurrentReservesNeverExceedMax(t *testing.T) {
	// Two pools stand in for the two Stalwart pods' authd processes.
	pods := []*Postgres{NewPostgres(testPool(t)), NewPostgres(testPool(t))}
	user := freshUser(t)
	budget := verify.Budget{Max: 5, Window: 15 * time.Minute}

	const racers = 60
	var granted atomic.Int32
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < racers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, ok, err := pods[i%len(pods)].Reserve(context.Background(), user, budget)
			if err != nil {
				t.Errorf("reserve: %v", err)
				return
			}
			if ok {
				granted.Add(1)
			}
		}()
	}
	close(start)
	wg.Wait()

	if got := granted.Load(); got != int32(budget.Max) {
		t.Fatalf("%d racers were granted a slot, want exactly %d", got, budget.Max)
	}
}

func TestExpiredWindowRestartsTheCount(t *testing.T) {
	s := NewPostgres(testPool(t))
	user := freshUser(t)
	short := verify.Budget{Max: 1, Window: time.Second}

	first, ok, err := s.Reserve(context.Background(), user, short)
	if err != nil || !ok {
		t.Fatalf("first reserve: ok=%v err=%v", ok, err)
	}
	if _, ok, _ := s.Reserve(context.Background(), user, short); ok {
		t.Fatal("a second slot was granted inside the window")
	}

	time.Sleep(1200 * time.Millisecond)

	second, ok, err := s.Reserve(context.Background(), user, short)
	if err != nil || !ok {
		t.Fatalf("reserve after the window: ok=%v err=%v", ok, err)
	}
	if !second.Window.After(first.Window) {
		t.Fatalf("the window did not restart: %v then %v", first.Window, second.Window)
	}
}

func TestReleaseReopensASlotInTheSameWindow(t *testing.T) {
	s := NewPostgres(testPool(t))
	user := freshUser(t)
	one := verify.Budget{Max: 1, Window: 15 * time.Minute}

	slot, ok, err := s.Reserve(context.Background(), user, one)
	if err != nil || !ok {
		t.Fatalf("reserve: ok=%v err=%v", ok, err)
	}
	if err := s.Release(context.Background(), user, slot); err != nil {
		t.Fatalf("release: %v", err)
	}
	if _, ok, err := s.Reserve(context.Background(), user, one); err != nil || !ok {
		t.Fatalf("reserve after release: ok=%v err=%v", ok, err)
	}
}

// A slot from a window that has since restarted was never counted by the new
// one. Releasing it must not hand the new window a free slot.
func TestReleaseOfAStaleWindowIsANoOp(t *testing.T) {
	s := NewPostgres(testPool(t))
	user := freshUser(t)
	short := verify.Budget{Max: 1, Window: time.Second}

	old, ok, err := s.Reserve(context.Background(), user, short)
	if err != nil || !ok {
		t.Fatalf("reserve: ok=%v err=%v", ok, err)
	}
	time.Sleep(1200 * time.Millisecond)
	if _, ok, err := s.Reserve(context.Background(), user, short); err != nil || !ok {
		t.Fatalf("reserve in the new window: ok=%v err=%v", ok, err)
	}

	if err := s.Release(context.Background(), user, old); err != nil {
		t.Fatalf("release: %v", err)
	}
	if _, ok, _ := s.Reserve(context.Background(), user, short); ok {
		t.Fatal("releasing a slot from the previous window freed one in the new window")
	}
}

func TestReleaseNeverGoesBelowZero(t *testing.T) {
	s := NewPostgres(testPool(t))
	user := freshUser(t)
	one := verify.Budget{Max: 1, Window: 15 * time.Minute}

	slot, _, err := s.Reserve(context.Background(), user, one)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		if err := s.Release(context.Background(), user, slot); err != nil {
			t.Fatalf("release %d: %v", i, err)
		}
	}
	// Three releases of one slot must still leave the budget at its full size
	// of one - not at minus two, which would grant three.
	granted := 0
	for i := 0; i < 3; i++ {
		if _, ok, _ := s.Reserve(context.Background(), user, one); ok {
			granted++
		}
	}
	if granted != 1 {
		t.Fatalf("%d slots granted after over-releasing, want 1", granted)
	}
}

// Releasing for a user with no row is not an error: it can only mean the slot is
// gone, which is the outcome asked for.
func TestReleaseWithoutARowIsHarmless(t *testing.T) {
	s := NewPostgres(testPool(t))
	if err := s.Release(context.Background(), freshUser(t), verify.Slot{Window: time.Now()}); err != nil {
		t.Fatalf("release with no row: %v", err)
	}
}

// A budget of nothing forwards nothing, without a round trip.
func TestZeroBudgetRefusesWithoutTouchingTheDatabase(t *testing.T) {
	s := NewPostgres(nil) // would panic on any query
	for _, b := range []verify.Budget{{Max: 0, Window: time.Minute}, {Max: 3, Window: 0}} {
		if _, ok, err := s.Reserve(context.Background(), "u", b); ok || err != nil {
			t.Fatalf("budget %+v: ok=%v err=%v, want a clean refusal", b, ok, err)
		}
	}
}
