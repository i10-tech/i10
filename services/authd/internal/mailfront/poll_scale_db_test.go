package mailfront

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"math/rand/v2"
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

// TestChangeDrivenPollScale measures what the change-driven poll costs the
// database each second, on the sweep seed (docs/research/mail-device-binding/
// sweep-seed.sql, migrated with the access-change log): the log read with 0, 10
// and 100 changed accounts a second committed by a writer alongside it, and the
// re-check of that many accounts, which is the worst case of the changes all
// naming live connections. The log is filled first with an hour of rows at
// 100 a second, the most it holds at that rate (rows live an hour).
//
// It also measures what the triggers add to writes (MAILFRONT_SCALE_WRITES_CSV).
// A measurement, not a check, so it runs only when asked:
//
//	MAILFRONT_SCALE_DATABASE_URL='postgres://mailfront@127.0.0.1:55511/i10?pool_max_conns=2' \
//	MAILFRONT_SCALE_ADMIN_URL='postgres://i10@127.0.0.1:55511/i10' \
//	MAILFRONT_SCALE_POLL_CSV=/tmp/poll.csv MAILFRONT_SCALE_WRITES_CSV=/tmp/writes.csv \
//	go test -run TestChangeDrivenPollScale -v -timeout 30m ./internal/mailfront/
func TestChangeDrivenPollScale(t *testing.T) {
	dsn, adminURL := os.Getenv("MAILFRONT_SCALE_DATABASE_URL"), os.Getenv("MAILFRONT_SCALE_ADMIN_URL")
	if dsn == "" || adminURL == "" {
		t.Skip("MAILFRONT_SCALE_DATABASE_URL and MAILFRONT_SCALE_ADMIN_URL not set")
	}
	ctx := context.Background()
	store, err := projection.NewPostgres(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	admin, err := pgxpool.New(ctx, adminURL)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	const total = 500000

	if path := os.Getenv("MAILFRONT_SCALE_WRITES_CSV"); path != "" {
		measureTriggerWrites(t, ctx, admin, path)
	}
	path := os.Getenv("MAILFRONT_SCALE_POLL_CSV")
	if path == "" {
		return
	}

	// An hour of history at 100 a second, committed long before the polls.
	if _, err := admin.Exec(ctx, `TRUNCATE authd.access_changes`); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `INSERT INTO authd.access_changes (kind, key, at)
		SELECT 'account', 'bench_' || (1 + g % 500000), now() - (g || ' ms')::interval * 10
		FROM generate_series(1, 360000) g`); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `ANALYZE authd.access_changes`); err != nil {
		t.Fatal(err)
	}

	rows := [][]string{{"changes_per_s", "polls", "log_rows", "poll_p50_ms", "poll_p95_ms", "poll_max_ms",
		"poll_shared_hit", "poll_shared_read", "poll_explain_ms", "recheck_p50_ms", "recheck_p95_ms",
		"recheck_shared_hit", "recheck_explain_ms", "db_core_share_at_1hz_pct"}}
	for _, k := range []int{0, 10, 100} {
		// The writer: k single-row commits a second, each its own transaction, on
		// a watched column of random accounts.
		wctx, stop := context.WithCancel(ctx)
		var wg sync.WaitGroup
		wg.Add(1)
		go func() {
			defer wg.Done()
			if k == 0 {
				<-wctx.Done()
				return
			}
			tick := time.NewTicker(time.Second / time.Duration(k))
			defer tick.Stop()
			for n := 0; ; n++ {
				select {
				case <-wctx.Done():
					return
				case <-tick.C:
				}
				_, _ = admin.Exec(wctx, `UPDATE authd.accounts SET display_name = $2 WHERE clerk_user_id = $1`,
					"bench_"+strconv.Itoa(1+rand.IntN(total)), "n"+strconv.Itoa(n))
			}
		}()

		b, err := store.AccessChanges(ctx, "", 10000)
		if err != nil {
			t.Fatal(err)
		}
		var lat []time.Duration
		var read int
		var plan []map[string]any
		since := b.Snapshot
		for i := 0; i < 61; i++ {
			time.Sleep(time.Second)
			if i == 30 {
				// The plan of a poll in the middle of the run, from a second-old snapshot.
				var raw []byte
				if err := store.Pool().QueryRow(ctx, `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) `+projection.AccessChangesQuery,
					since, 10000).Scan(&raw); err != nil {
					t.Fatal(err)
				}
				if err := json.Unmarshal(raw, &plan); err != nil {
					t.Fatal(err)
				}
				if k == 100 {
					t.Logf("poll plan at %d changes a second:\n%s", k, raw)
				}
				continue
			}
			start := time.Now()
			got, err := store.AccessChanges(ctx, since, 10000)
			if err != nil {
				t.Fatal(err)
			}
			if i > 0 {
				lat = append(lat, time.Since(start))
				read += len(got.Changes)
			}
			since = got.Snapshot
		}
		stop()
		wg.Wait()
		sort.Slice(lat, func(i, j int) bool { return lat[i] < lat[j] })

		// The re-check of k accounts, as if each change named a live connection.
		var rlat []time.Duration
		var rplan []map[string]any
		if k > 0 {
			for i := 0; i < 31; i++ {
				ids := make([]string, k)
				for j, n := range rand.Perm(total)[:k] {
					ids[j] = "bench_" + strconv.Itoa(n+1)
				}
				start := time.Now()
				if _, _, err := store.AccountsByUIDs(ctx, ids); err != nil {
					t.Fatal(err)
				}
				if i > 0 {
					rlat = append(rlat, time.Since(start))
				}
				if i == 30 {
					var raw []byte
					if err := store.Pool().QueryRow(ctx, `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) `+projection.SweepQuery, ids).Scan(&raw); err != nil {
						t.Fatal(err)
					}
					if err := json.Unmarshal(raw, &rplan); err != nil {
						t.Fatal(err)
					}
				}
			}
			sort.Slice(rlat, func(i, j int) bool { return rlat[i] < rlat[j] })
		}

		ms := func(d time.Duration) string { return fmt.Sprintf("%.2f", float64(d.Microseconds())/1000) }
		top := plan[0]["Plan"].(map[string]any)
		pollExec := plan[0]["Execution Time"].(float64)
		row := []string{strconv.Itoa(k), strconv.Itoa(len(lat)), strconv.Itoa(read / max(len(lat), 1)),
			ms(lat[len(lat)/2]), ms(lat[len(lat)*95/100]), ms(lat[len(lat)-1]),
			fmt.Sprint(top["Shared Hit Blocks"]), fmt.Sprint(top["Shared Read Blocks"]), fmt.Sprintf("%.3f", pollExec)}
		recheckExec := 0.0
		if k > 0 {
			rtop := rplan[0]["Plan"].(map[string]any)
			recheckExec = rplan[0]["Execution Time"].(float64)
			row = append(row, ms(rlat[len(rlat)/2]), ms(rlat[len(rlat)*95/100]), fmt.Sprint(rtop["Shared Hit Blocks"]), fmt.Sprintf("%.3f", recheckExec))
		} else {
			row = append(row, "0", "0", "0", "0")
		}
		row = append(row, fmt.Sprintf("%.3f", (pollExec+recheckExec)/1000*100))
		rows = append(rows, row)
		t.Logf("%v", row)
	}
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	_ = csv.NewWriter(f).WriteAll(rows)
}

// measureTriggerWrites times representative writes with the access-change
// triggers and with them disabled (inside a transaction that rolls back, so
// the seed is unchanged): one account, 10,000 accounts, and a re-check pass
// over 10,000 domains that touches only columns the triggers ignore.
func measureTriggerWrites(t *testing.T, ctx context.Context, admin *pgxpool.Pool, path string) {
	t.Helper()
	writes := []struct{ name, table, stmt string }{
		{"one account (suspended_at)", "authd.accounts",
			`UPDATE authd.accounts SET suspended_at = now() WHERE clerk_user_id = 'bench_123457'`},
		{"10,000 accounts (payment_hold_at)", "authd.accounts",
			`UPDATE authd.accounts SET payment_hold_at = now() WHERE clerk_user_id = ANY (SELECT 'bench_' || g FROM generate_series(1, 500000, 50) g)`},
		{"one domain (hosts_mailboxes)", "core.domains",
			`UPDATE core.domains SET hosts_mailboxes = false WHERE name = 't77.bench.test'`},
		{"10,000 domains, ignored columns only (dns_checked_at)", "core.domains",
			`UPDATE core.domains SET dns_checked_at = now(), updated_at = now() WHERE tenant_id IN (SELECT id FROM core.tenants WHERE slug LIKE 'bench-%' ORDER BY slug LIMIT 10000)`},
	}
	rows := [][]string{{"write", "triggers", "runs", "rows", "p50_ms", "max_ms", "trigger_ms_p50", "wal_bytes_p50", "log_rows"}}
	for _, w := range writes {
		for _, on := range []bool{false, true} {
			var times, trig []float64
			var wal []int64
			var nrows, logged int64
			for i := 0; i < 7; i++ {
				tx, err := admin.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				if !on {
					if _, err := tx.Exec(ctx, `ALTER TABLE `+w.table+` DISABLE TRIGGER access_changes_upd`); err != nil {
						t.Fatal(err)
					}
				}
				var before int64
				if err := tx.QueryRow(ctx, `SELECT count(*) FROM authd.access_changes`).Scan(&before); err != nil {
					t.Fatal(err)
				}
				var raw []byte
				if err := tx.QueryRow(ctx, `EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON) `+w.stmt).Scan(&raw); err != nil {
					t.Fatal(err)
				}
				var after int64
				if err := tx.QueryRow(ctx, `SELECT count(*) FROM authd.access_changes`).Scan(&after); err != nil {
					t.Fatal(err)
				}
				_ = tx.Rollback(ctx)
				var plan []map[string]any
				if err := json.Unmarshal(raw, &plan); err != nil {
					t.Fatal(err)
				}
				if i == 0 {
					continue // warm-up
				}
				times = append(times, plan[0]["Execution Time"].(float64))
				top := plan[0]["Plan"].(map[string]any)
				nrows = int64(top["Actual Rows"].(float64))
				if inner, ok := top["Plans"].([]any); ok && len(inner) > 0 {
					nrows = int64(inner[0].(map[string]any)["Actual Rows"].(float64))
				}
				wal = append(wal, int64(top["WAL Bytes"].(float64)))
				tt := 0.0
				if ts, ok := plan[0]["Triggers"].([]any); ok {
					for _, x := range ts {
						tr := x.(map[string]any)
						if strings.HasPrefix(tr["Trigger Name"].(string), "access_changes") {
							tt += tr["Time"].(float64)
						}
					}
				}
				trig = append(trig, tt)
				logged = after - before
				if on && i == 6 {
					t.Logf("%s with triggers:\n%s", w.name, raw)
				}
			}
			sort.Float64s(times)
			sort.Float64s(trig)
			sort.Slice(wal, func(i, j int) bool { return wal[i] < wal[j] })
			rows = append(rows, []string{w.name, strconv.FormatBool(on), strconv.Itoa(len(times)), strconv.FormatInt(nrows, 10),
				fmt.Sprintf("%.3f", times[len(times)/2]), fmt.Sprintf("%.3f", times[len(times)-1]),
				fmt.Sprintf("%.3f", trig[len(trig)/2]), strconv.FormatInt(wal[len(wal)/2], 10), strconv.FormatInt(logged, 10)})
			t.Logf("%v", rows[len(rows)-1])
		}
	}
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	_ = csv.NewWriter(f).WriteAll(rows)
}
