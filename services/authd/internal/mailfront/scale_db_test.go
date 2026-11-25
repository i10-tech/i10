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
	"testing"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/projection"
)

// TestSweepQueryScale measures the sweep's one query at live-account counts
// from 10 to 50,000, against a database seeded with accounts named bench_1 ..
// bench_<MAILFRONT_SCALE_ACCOUNTS> by docs/research/mail-device-binding/
// sweep-seed.sql (the results are in mail-device-binding.md, section 9). It is
// a measurement, not a check, so it runs only when asked:
//
//	MAILFRONT_SCALE_LABEL=current \
//	MAILFRONT_SCALE_DATABASE_URL='postgres://authd:authd@127.0.0.1:55432/i10?pool_max_conns=1' \
//	MAILFRONT_SCALE_CSV=/tmp/sweep-db.csv go test -run TestSweepQueryScale -v ./internal/mailfront/
func TestSweepQueryScale(t *testing.T) {
	dsn := os.Getenv("MAILFRONT_SCALE_DATABASE_URL")
	if dsn == "" {
		t.Skip("MAILFRONT_SCALE_DATABASE_URL not set")
	}
	total := 500000
	if v := os.Getenv("MAILFRONT_SCALE_ACCOUNTS"); v != "" {
		total, _ = strconv.Atoi(v)
	}
	ctx := context.Background()
	store, err := projection.NewPostgres(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	pool := store.Pool()

	label := os.Getenv("MAILFRONT_SCALE_LABEL")
	var rows [][]string
	rows = append(rows, []string{"schema", "distribution", "live_accounts", "distinct_domains", "runs", "p50_ms", "p95_ms", "max_ms", "rows_returned",
		"shared_hit_blocks", "shared_read_blocks", "explain_exec_ms", "db_core_share_at_1hz_pct"})
	// The seed puts account k on domain t<1 + k%20000>. "spread" draws live
	// accounts from all of them (nearly one domain each: the worst case for the
	// per-domain gate), "clustered" from as few domains as hold them (25 live
	// accounts a domain, a company whose people all read mail).
	for _, dist := range []string{"clustered", "spread"} {
		for _, n := range []int{10, 100, 1000, 10000, 50000} {
			ids := make([]string, n)
			domains := map[int]bool{}
			if dist == "spread" {
				for i, k := range rand.Perm(total)[:n] {
					ids[i] = "bench_" + strconv.Itoa(k+1)
					domains[(k+1)%20000] = true
				}
			} else {
				for i := range ids {
					k := (i/25)%20000 + 20000*(i%25) + 1
					ids[i] = "bench_" + strconv.Itoa(k)
					domains[k%20000] = true
				}
			}

			// At least 60 runs, unless one size's runs would take more than two
			// minutes: a query that slow is past the knee, and its count says so.
			const warm, maxRuns = 1, 60
			var lat []time.Duration
			returned := 0
			began := time.Now()
			for i := 0; i < warm+maxRuns; i++ {
				if i > warm && time.Since(began) > 2*time.Minute {
					break
				}
				start := time.Now()
				got, _, err := store.AccountsByUIDs(ctx, ids, nil)
				if err != nil {
					t.Fatal(err)
				}
				if i >= warm {
					lat = append(lat, time.Since(start))
				}
				returned = len(got)
			}
			sort.Slice(lat, func(i, j int) bool { return lat[i] < lat[j] })

			var plan []map[string]any
			var raw []byte
			if err := pool.QueryRow(ctx, `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) `+projection.SweepQuery, ids).Scan(&raw); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(raw, &plan); err != nil {
				t.Fatal(err)
			}
			top := plan[0]["Plan"].(map[string]any)
			hit, read := top["Shared Hit Blocks"], top["Shared Read Blocks"]
			execMS := plan[0]["Execution Time"]

			ms := func(d time.Duration) string { return fmt.Sprintf("%.2f", float64(d.Microseconds())/1000) }
			runs := len(lat)
			row := []string{label, dist, strconv.Itoa(n), strconv.Itoa(len(domains)), strconv.Itoa(runs), ms(lat[len(lat)/2]), ms(lat[len(lat)*95/100]), ms(lat[len(lat)-1]),
				strconv.Itoa(returned), fmt.Sprint(hit), fmt.Sprint(read), fmt.Sprintf("%.2f", execMS),
				// The share of one core a 1 Hz sweep holds a backend for: the
				// server's own execution time over the second between sweeps.
				fmt.Sprintf("%.1f", execMS.(float64)/1000*100)}
			rows = append(rows, row)
			t.Logf("%v", row)
			if n == 1000 && dist == "spread" {
				t.Logf("plan for %d:\n%s", n, raw)
			}
		}
	}
	if path := os.Getenv("MAILFRONT_SCALE_CSV"); path != "" {
		f, err := os.Create(path)
		if err != nil {
			t.Fatal(err)
		}
		defer f.Close()
		w := csv.NewWriter(f)
		_ = w.WriteAll(rows)
	}
}
