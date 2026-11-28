package enrollctl

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/gate"
	"github.com/i10-tech/i10/services/authd/internal/projection"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	// DefaultMaxBatch caps rows per Postgres transaction.
	DefaultMaxBatch = 200
	// DefaultMaxWait bounds how long a busy writer collects arrivals for the next batch.
	DefaultMaxWait = 5 * time.Millisecond
	// DefaultBatchDeadline bounds one batch execution including retry/split.
	DefaultBatchDeadline = 4 * time.Second
)

// ErrUnavailable indicates a Postgres timeout, lock timeout, or connection
// failure; callers translate this into HTTP 503 and mint/bind nothing.
var ErrUnavailable = errors.New("enrollctl: database unavailable")

// MintRequest is one Phase 4 device mint submitted to the micro-batcher.
// DeviceID, CodeHash, and CodeKid are pre-generated before enqueueing.
type MintRequest struct {
	DeviceID      string // UUIDv7
	EnrollmentID  string // UUIDv7
	ClerkUserID   string
	Email         string // lowercase expected email from session
	TenantID      *string
	ExpectedEpoch int64
	Platform      string // ios | ipados | macos
	DeviceName    *string
	Model         *string
	Serial        *string
	CodeHash      []byte
	CodeKid       int16
	CreatedBy     string
}

// MintResult is the per-request outcome returned by Batcher.Mint.
type MintResult struct {
	OK          bool
	RefusalCode string // empty when OK; "enrollment_conflict" on ON CONFLICT DO NOTHING
	Err         error  // non-nil (e.g. ErrUnavailable) on transient DB failure -> 503
}

// BindMacRequest is one Mac ACME key-bind request submitted to the micro-batcher.
type BindMacRequest struct {
	DeviceID  string
	Serial    string
	KeySha256 []byte // 32-byte SPKI SHA-256
}

// BindMacResult is the per-request outcome returned by Batcher.BindMac.
type BindMacResult struct {
	OK          bool
	RefusalCode string // empty when OK; e.g. "acme_key_conflict", "key_in_use", gate refusals
	Err         error  // non-nil on transient DB failure -> 503
}

// BatchObserver optionally records batch sizes and latencies for logging/loadtest.
type BatchObserver func(kind string, size int, dur time.Duration)

// BatcherConfig configures the synchronous micro-batcher.
type BatcherConfig struct {
	MaxBatch int
	MaxWait  time.Duration
	Deadline time.Duration
	Log      *slog.Logger
	Observe  BatchObserver
}

// Batcher coordinates synchronous micro-batched Postgres writes as `enroll_writer`.
// One writer goroutine handles mints and one handles Mac ACME binds, keeping
// connection usage bounded to at most 2 concurrent transactions per replica
// (`pool_max_conns=2`, `QueryExecModeExec` for PgBouncer transaction pooling).
//
// Lock order everywhere: authd.accounts (FOR SHARE through the SECURITY
// DEFINER authd.enroll_lock_gate_accounts, sorted by clerk_user_id), then
// authd.mail_devices (FOR NO KEY UPDATE, sorted by id), then
// authd.mail_device_cert_binds.
type Batcher struct {
	pool *pgxpool.Pool
	log  *slog.Logger
	mint *lane[MintRequest, MintResult]
	bind *lane[BindMacRequest, BindMacResult]

	stopOnce sync.Once
	stopCh   chan struct{}
	wg       sync.WaitGroup
}

// job is one waiter's request.
//
// ⚠ A COMMIT IS NEVER ANSWERED AS UNAVAILABLE. A caller whose context ends
// while its job is still queued abandons it, and dispatch never runs it (nor a
// job whose context is already done when its batch starts). Once dispatch has
// taken a job into a transaction, submit waits for that transaction's answer
// whatever the caller's context does: otherwise a dropped connection mid-mint
// would leave a committed device whose profile is never sealed.
type job[Req, Res any] struct {
	ctx   context.Context // the caller's
	req   Req
	resp  chan Res
	state *atomic.Int32 // jobQueued, then jobTaken (dispatch) or jobAbandoned (submit)
}

const (
	jobQueued int32 = iota
	jobTaken
	jobAbandoned
)

// takenGrace is how long past the batch deadline submit still waits for a
// taken job's answer before it logs a bug and gives up.
const takenGrace = time.Second

func newJob[Req, Res any](ctx context.Context, req Req) job[Req, Res] {
	return job[Req, Res]{ctx: ctx, req: req, resp: make(chan Res, 1), state: new(atomic.Int32)}
}

type (
	mintJob = job[MintRequest, MintResult]
	bindJob = job[BindMacRequest, BindMacResult]
)

// lane is one writer goroutine and its queue: the mint lane and the Mac bind
// lane are the same machine with a different transaction.
type lane[Req, Res any] struct {
	kind     string
	ch       chan job[Req, Res]
	exec     func(context.Context, []job[Req, Res]) ([]Res, error)
	failed   func(error) Res  // the answer for a waiter whose batch could not run
	refused  func(string) Res // the answer for the one row a constraint refused
	maxBatch int
	maxWait  time.Duration
	deadline time.Duration
	log      *slog.Logger
	observe  BatchObserver
	stopCh   <-chan struct{}
}

// OpenEnrollWriterPool opens a pgxpool configured for PgBouncer transaction
// mode: QueryExecModeExec (zero prepared statements) and max 2 connections.
func OpenEnrollWriterPool(ctx context.Context, dsn string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("enrollctl: parse enroll_writer dsn: %w", err)
	}
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeExec
	cfg.MaxConns = 2
	cfg.MinConns = 0
	cfg.MaxConnLifetime = 30 * time.Minute
	cfg.MaxConnIdleTime = 5 * time.Minute
	return pgxpool.NewWithConfig(ctx, cfg)
}

// NewBatcher starts the mint and Mac-bind writer goroutines.
func NewBatcher(pool *pgxpool.Pool, cfg BatcherConfig) *Batcher {
	maxBatch := cfg.MaxBatch
	if maxBatch <= 0 {
		maxBatch = DefaultMaxBatch
	}
	maxWait := cfg.MaxWait
	if maxWait <= 0 {
		maxWait = DefaultMaxWait
	}
	deadline := cfg.Deadline
	if deadline <= 0 {
		deadline = DefaultBatchDeadline
	}
	b := &Batcher{pool: pool, log: cfg.Log, stopCh: make(chan struct{})}
	b.mint = &lane[MintRequest, MintResult]{
		kind:     "mint",
		ch:       make(chan mintJob, maxBatch*4),
		exec:     b.execMintTx,
		failed:   func(err error) MintResult { return MintResult{Err: err} },
		refused:  func(code string) MintResult { return MintResult{RefusalCode: code} },
		maxBatch: maxBatch, maxWait: maxWait, deadline: deadline,
		log: cfg.Log, observe: cfg.Observe, stopCh: b.stopCh,
	}
	b.bind = &lane[BindMacRequest, BindMacResult]{
		kind:     "bind",
		ch:       make(chan bindJob, maxBatch*4),
		exec:     b.execBindTx,
		failed:   func(err error) BindMacResult { return BindMacResult{Err: err} },
		refused:  func(code string) BindMacResult { return BindMacResult{RefusalCode: code} },
		maxBatch: maxBatch, maxWait: maxWait, deadline: deadline,
		log: cfg.Log, observe: cfg.Observe, stopCh: b.stopCh,
	}
	b.wg.Add(2)
	go func() { defer b.wg.Done(); b.mint.run() }()
	go func() { defer b.wg.Done(); b.bind.run() }()
	return b
}

// Close stops accepting new batches and waits for in-flight batches to finish.
func (b *Batcher) Close() {
	b.stopOnce.Do(func() {
		close(b.stopCh)
	})
	b.wg.Wait()
}

// Mint submits a single device mint and waits synchronously for its commit or refusal.
func (b *Batcher) Mint(ctx context.Context, req MintRequest) MintResult {
	return b.mint.submit(ctx, req)
}

// BindMac submits a single Mac ACME key-bind and waits synchronously for its result.
func (b *Batcher) BindMac(ctx context.Context, req BindMacRequest) BindMacResult {
	return b.bind.submit(ctx, req)
}

func (l *lane[Req, Res]) submit(ctx context.Context, req Req) Res {
	j := newJob[Req, Res](ctx, req)
	select {
	case l.ch <- j:
	case <-l.stopCh:
		return l.failed(ErrUnavailable)
	case <-ctx.Done():
		return l.failed(ErrUnavailable)
	}
	select {
	case res := <-j.resp:
		return res
	case <-ctx.Done():
	case <-l.stopCh:
	}
	// The caller left, or the lane is stopping. A job dispatch has not taken
	// will never run; a taken one is in a transaction that may commit, so its
	// answer is awaited, bounded by the batch deadline.
	if j.state.CompareAndSwap(jobQueued, jobAbandoned) {
		return l.failed(ErrUnavailable)
	}
	timer := time.NewTimer(l.deadline + takenGrace)
	defer timer.Stop()
	select {
	case res := <-j.resp:
		return res
	case <-timer.C:
		l.logError("a job in a transaction had no answer past the batch deadline (bug)")
		return l.failed(ErrUnavailable)
	}
}

// take keeps the jobs this batch may run: it drops the ones their callers
// abandoned, and answers ErrUnavailable to the ones whose caller's context is
// already done, BEFORE any transaction starts.
func (l *lane[Req, Res]) take(jobs []job[Req, Res]) []job[Req, Res] {
	kept := jobs[:0:0]
	for _, j := range jobs {
		if !j.state.CompareAndSwap(jobQueued, jobTaken) {
			continue
		}
		if j.ctx.Err() != nil {
			j.resp <- l.failed(ErrUnavailable)
			continue
		}
		kept = append(kept, j)
	}
	return kept
}

// run dispatches immediately (0 ms wait) when idle, and coalesces up to
// maxBatch arrivals or maxWait while a previous batch ran.
func (l *lane[Req, Res]) run() {
	for {
		var first job[Req, Res]
		select {
		case first = <-l.ch:
		case <-l.stopCh:
			return
		}
		batch := append(make([]job[Req, Res], 0, l.maxBatch), first)
		// Drain anything already queued right now (0 ms added wait when idle).
		l.drain(&batch)
		l.dispatch(batch)

		// While busy (more arrivals landed during the batch), coalesce up to
		// maxBatch or maxWait before dispatching the next wave.
	busy:
		for {
			select {
			case next := <-l.ch:
				wave := append(make([]job[Req, Res], 0, l.maxBatch), next)
				l.collect(&wave)
				l.dispatch(wave)
			case <-l.stopCh:
				return
			default:
				break busy
			}
		}
	}
}

func (l *lane[Req, Res]) drain(batch *[]job[Req, Res]) {
	for len(*batch) < l.maxBatch {
		select {
		case j := <-l.ch:
			*batch = append(*batch, j)
		default:
			return
		}
	}
}

func (l *lane[Req, Res]) collect(batch *[]job[Req, Res]) {
	l.drain(batch)
	if len(*batch) >= l.maxBatch {
		return
	}
	timer := time.NewTimer(l.maxWait)
	defer timer.Stop()
	for len(*batch) < l.maxBatch {
		select {
		case j := <-l.ch:
			*batch = append(*batch, j)
		case <-timer.C:
			return
		case <-l.stopCh:
			return
		}
	}
}

// dispatch runs one batch and answers every waiter exactly once.
//
// ⚠ A BUG MAY NEVER KILL THE PROCESS OR STRAND A WAITER. A result slice of the
// wrong length is logged as a bug and every waiter gets ErrUnavailable, and a
// panic anywhere in the batch is recovered here, so the lane keeps running and
// each waiter still gets one answer.
func (l *lane[Req, Res]) dispatch(queued []job[Req, Res]) {
	jobs := l.take(queued)
	if len(jobs) == 0 {
		return
	}
	start := time.Now()
	answered := make([]bool, len(jobs))
	answer := func(i int, r Res) {
		if !answered[i] {
			answered[i] = true
			jobs[i].resp <- r
		}
	}
	defer func() {
		if rec := recover(); rec != nil {
			l.logError("batch panicked; answering every waiter unavailable", "size", len(jobs), "panic", fmt.Sprint(rec))
		}
		for i := range jobs {
			answer(i, l.failed(ErrUnavailable))
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), l.deadline)
	defer cancel()
	results := l.runWithRecovery(ctx, jobs, false)
	if len(results) != len(jobs) {
		l.logError("batch returned the wrong number of results (bug)", "size", len(jobs), "results", len(results))
		results = l.allFailed(len(jobs))
	}
	for i := range jobs {
		answer(i, results[i])
	}
	dur := time.Since(start)
	if l.observe != nil {
		l.observe(l.kind, len(jobs), dur)
	}
	if l.log != nil {
		l.log.Info("enroll batch committed", "kind", l.kind, "batch_size", len(jobs), "duration_ms", dur.Milliseconds())
	}
}

// runWithRecovery returns exactly one result per job, whatever happens:
//   - 40P01 / 40001: retry the whole batch once, then split in halves;
//   - a constraint violation: split until the one bad row is alone, refuse only
//     it (⚠ ONLY A SINGLE JOB IS EVER REFUSED FOR A CONSTRAINT; out of time to
//     split, every waiter of a larger batch gets ErrUnavailable and retries);
//   - anything else (timeout, lock_timeout, Postgres down): ErrUnavailable for
//     every waiter, nothing minted.
func (l *lane[Req, Res]) runWithRecovery(ctx context.Context, jobs []job[Req, Res], retriedOnce bool) []Res {
	results, err := l.exec(ctx, jobs)
	if err == nil {
		return results
	}
	split := func(retried bool) []Res {
		mid := len(jobs) / 2
		left := l.runWithRecovery(ctx, jobs[:mid], retried)
		return append(left, l.runWithRecovery(ctx, jobs[mid:], retried)...)
	}
	switch {
	case isDeadlockOrSerialization(err):
		if ctx.Err() == nil && !retriedOnce {
			if l.log != nil {
				l.log.Warn("batch retryable conflict, retrying whole batch once", "kind", l.kind, "size", len(jobs), "code", pgErrCode(err))
			}
			return l.runWithRecovery(ctx, jobs, true)
		}
		if ctx.Err() == nil && len(jobs) > 1 {
			return split(true)
		}
		return l.allFailed(len(jobs))
	case isConstraintViolation(err):
		if len(jobs) == 1 {
			return []Res{l.refused(constraintRefusalCode(err))}
		}
		if ctx.Err() != nil {
			return l.allFailed(len(jobs))
		}
		return split(retriedOnce)
	}
	l.logError("batch failed", "size", len(jobs), "code", pgErrCode(err))
	return l.allFailed(len(jobs))
}

func (l *lane[Req, Res]) allFailed(n int) []Res {
	out := make([]Res, n)
	for i := range out {
		out[i] = l.failed(ErrUnavailable)
	}
	return out
}

func (l *lane[Req, Res]) logError(msg string, args ...any) {
	if l.log != nil {
		l.log.Error(msg, append([]any{"kind", l.kind}, args...)...)
	}
}

func (b *Batcher) logError(msg string, args ...any) {
	if b.log != nil {
		b.log.Error(msg, args...)
	}
}

type domainKey struct {
	tenant string // "" for NULL tenant
	domain string
}

func (b *Batcher) execMintTx(ctx context.Context, jobs []mintJob) ([]MintResult, error) {
	if b.pool == nil {
		return nil, ErrUnavailable
	}
	tx, err := b.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	if err := setBatchTimeouts(ctx, tx); err != nil {
		return nil, err
	}

	uids := distinctSortedUIDsFromMints(jobs)
	accounts, err := lockAndLoadAccounts(ctx, tx, uids)
	if err != nil {
		return nil, err
	}
	if err := evaluateDomainsOnce(ctx, tx, accounts); err != nil {
		return nil, err
	}

	results := make([]MintResult, len(jobs))
	var acceptedIdx []int
	seenEnrollments := make(map[string]bool, len(jobs))

	for i, j := range jobs {
		acc := accounts[j.req.ClerkUserID]
		if refusal := mintRefusal(acc, j.req); refusal != "" {
			results[i] = MintResult{OK: false, RefusalCode: refusal}
			continue
		}
		if j.req.EnrollmentID != "" {
			if seenEnrollments[j.req.EnrollmentID] {
				results[i] = MintResult{OK: false, RefusalCode: "enrollment_conflict"}
				continue
			}
			seenEnrollments[j.req.EnrollmentID] = true
		}
		acceptedIdx = append(acceptedIdx, i)
	}

	if len(acceptedIdx) > 0 {
		n := len(acceptedIdx)
		ids := make([]string, n)
		clerkUIDs := make([]string, n)
		emails := make([]string, n)
		tenants := make([]pgtype.Text, n)
		platforms := make([]string, n)
		devNames := make([]pgtype.Text, n)
		models := make([]pgtype.Text, n)
		serials := make([]pgtype.Text, n)
		enrollIDs := make([]pgtype.Text, n)
		codeHashes := make([][]byte, n)
		codeKids := make([]int16, n)
		createdBys := make([]string, n)

		for k, idx := range acceptedIdx {
			r := jobs[idx].req
			acc := accounts[r.ClerkUserID]
			ids[k] = r.DeviceID
			clerkUIDs[k] = acc.ClerkUserID
			emails[k] = strings.ToLower(acc.Email)
			tenants[k] = optText(acc.TenantID)
			platforms[k] = r.Platform
			if r.DeviceName != nil {
				devNames[k] = pgtype.Text{String: *r.DeviceName, Valid: true}
			}
			if r.Model != nil {
				models[k] = pgtype.Text{String: *r.Model, Valid: true}
			}
			if r.Serial != nil {
				serials[k] = pgtype.Text{String: *r.Serial, Valid: true}
			}
			enrollIDs[k] = optText(r.EnrollmentID)
			codeHashes[k] = r.CodeHash
			codeKids[k] = r.CodeKid
			createdBys[k] = r.CreatedBy
		}

		rows, err := tx.Query(ctx, `
			INSERT INTO authd.mail_devices (
				id, clerk_user_id, email, tenant_id, platform, device_name, model,
				serial, enrollment_id, code_hash, code_kid, created_by
			)
			SELECT id, clerk_user_id, email, tenant_id, platform, device_name, model,
				   serial, enrollment_id, code_hash, code_kid, created_by
			  FROM unnest(
				$1::uuid[], $2::text[], $3::text[], $4::uuid[], $5::text[], $6::text[],
				$7::text[], $8::text[], $9::uuid[], $10::bytea[], $11::smallint[], $12::text[]
			  ) AS v(id, clerk_user_id, email, tenant_id, platform, device_name, model,
					 serial, enrollment_id, code_hash, code_kid, created_by)
			ON CONFLICT (enrollment_id) WHERE enrollment_id IS NOT NULL DO NOTHING
			RETURNING id::text
		`, ids, clerkUIDs, emails, tenants, platforms, devNames, models, serials, enrollIDs, codeHashes, codeKids, createdBys)
		if err != nil {
			return nil, err
		}
		insertedIDs := make(map[string]bool, n)
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return nil, err
			}
			insertedIDs[id] = true
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()

		for _, idx := range acceptedIdx {
			if insertedIDs[jobs[idx].req.DeviceID] {
				results[idx] = MintResult{OK: true}
			} else {
				results[idx] = MintResult{OK: false, RefusalCode: "enrollment_conflict"}
			}
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return results, nil
}

type lockedDevice struct {
	ID            string
	ClerkUserID   string
	Email         string
	TenantID      string // "" for NULL, as projection.Account.TenantID
	Platform      string
	Serial        *string
	CertKeySha256 []byte
	ACMEBoundAt   *time.Time
	Alive         bool
}

func (b *Batcher) execBindTx(ctx context.Context, jobs []bindJob) ([]BindMacResult, error) {
	if b.pool == nil {
		return nil, ErrUnavailable
	}
	tx, err := b.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	if err := setBatchTimeouts(ctx, tx); err != nil {
		return nil, err
	}

	devIDs := distinctSortedDeviceIDs(jobs)
	// Step 1: Unlocked read of device owners so we can lock authd.accounts FIRST
	// (strict lock order: authd.accounts -> authd.mail_devices -> authd.mail_device_cert_binds).
	ownerRows, err := tx.Query(ctx, `
		SELECT id::text, clerk_user_id
		  FROM authd.mail_devices
		 WHERE id = ANY($1::uuid[])
	`, devIDs)
	if err != nil {
		return nil, err
	}
	uidSet := make(map[string]struct{}, len(devIDs))
	for ownerRows.Next() {
		var id, uid string
		if err := ownerRows.Scan(&id, &uid); err != nil {
			ownerRows.Close()
			return nil, err
		}
		uidSet[uid] = struct{}{}
	}
	if err := ownerRows.Err(); err != nil {
		ownerRows.Close()
		return nil, err
	}
	ownerRows.Close()

	uids := make([]string, 0, len(uidSet))
	for u := range uidSet {
		uids = append(uids, u)
	}
	sort.Strings(uids)

	accounts, err := lockAndLoadAccounts(ctx, tx, uids)
	if err != nil {
		return nil, err
	}
	if err := evaluateDomainsOnce(ctx, tx, accounts); err != nil {
		return nil, err
	}

	// Step 2: Lock distinct devices in sorted id order (FOR NO KEY UPDATE).
	devRows, err := tx.Query(ctx, `
		SELECT id::text, clerk_user_id, email, coalesce(tenant_id::text, ''), platform, serial,
			   cert_key_sha256, acme_bound_at,
			   CASE WHEN first_used_at IS NULL
					THEN created_at > now() - interval '10 minutes'
					ELSE last_used_at > now() - interval '90 days' END AS alive
		  FROM authd.mail_devices
		 WHERE id = ANY($1::uuid[])
		 ORDER BY id
		   FOR NO KEY UPDATE
	`, devIDs)
	if err != nil {
		return nil, err
	}
	devices := make(map[string]*lockedDevice, len(devIDs))
	for devRows.Next() {
		var d lockedDevice
		var serial pgtype.Text
		var boundAt pgtype.Timestamptz
		if err := devRows.Scan(&d.ID, &d.ClerkUserID, &d.Email, &d.TenantID, &d.Platform, &serial, &d.CertKeySha256, &boundAt, &d.Alive); err != nil {
			devRows.Close()
			return nil, err
		}
		if serial.Valid {
			s := serial.String
			d.Serial = &s
		}
		if boundAt.Valid {
			t := boundAt.Time
			d.ACMEBoundAt = &t
		}
		devices[d.ID] = &d
	}
	if err := devRows.Err(); err != nil {
		devRows.Close()
		return nil, err
	}
	devRows.Close()

	plan := planBinds(jobs, devices, accounts)
	for _, id := range plan.cleared {
		b.logError("mac acme key conflict: clearing the bound key and blocking further binds", "device_id", id)
	}

	if len(plan.setIDs) > 0 {
		_, err := tx.Exec(ctx, `
			UPDATE authd.mail_devices d
			   SET cert_key_sha256 = v.key_sha256,
				   acme_bound_at = coalesce(d.acme_bound_at, now()),
				   first_used_at = coalesce(d.first_used_at, now()),
				   last_used_at = coalesce(d.last_used_at, now())
			  FROM unnest($1::uuid[], $2::bytea[]) AS v(id, key_sha256)
			 WHERE d.id = v.id
		`, plan.setIDs, plan.setKeys)
		if err != nil {
			return nil, err
		}
	}

	if len(plan.cleared) > 0 {
		_, err := tx.Exec(ctx, `
			UPDATE authd.mail_devices
			   SET cert_key_sha256 = NULL,
				   acme_bound_at = coalesce(acme_bound_at, now())
			 WHERE id = ANY($1::uuid[])
		`, plan.cleared)
		if err != nil {
			return nil, err
		}
	}

	if dels := plan.livenessDeletes(); len(dels) > 0 {
		// Step 3 (lock order #3): delete Mac liveness rows AFTER locking devices.
		if _, err := tx.Exec(ctx, `
			DELETE FROM authd.mail_device_cert_binds
			 WHERE device_id = ANY($1::uuid[])
		`, dels); err != nil {
			return nil, err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return plan.results, nil
}

// bindPlan is what one bind batch writes and answers, decided in Go from the
// locked rows alone (no I/O), so the #536 rule is unit-testable.
type bindPlan struct {
	results []BindMacResult
	setIDs  []string // first ACME bind: set cert_key_sha256 + acme_bound_at
	setKeys [][]byte
	cleared []string // #536 conflict: clear cert_key_sha256, keep acme_bound_at
}

func (p bindPlan) livenessDeletes() []string {
	ids := append(append([]string{}, p.setIDs...), p.cleared...)
	sort.Strings(ids)
	return ids
}

// planBinds applies, per job and in this order: the device row exists, the
// account gate (bindRefusal), the device's own checks (deviceKeyRefusal: owner,
// platform, alive, serial), and an operator pre-bound key. ⚠ ONLY THEN THE #536
// CONFLICT RULE, AND ONLY OVER THE JOBS THAT PASSED ALL OF THOSE: a sibling that
// is itself refused (another serial, a gate refusal, an expired device) must
// never wipe a valid device's key, and two requests against a pre-bound key are
// both refused without touching it.
//
// #536 with `acme_bound_at`:
//   - first bind (no acme_bound_at, no key): set the key and stamp acme_bound_at;
//   - the same key again: idempotent OK;
//   - a different key once acme_bound_at is set, or two different keys in one
//     batch: clear the key, keep acme_bound_at (nothing can bind again), refuse.
func planBinds(jobs []bindJob, devices map[string]*lockedDevice, accounts map[string]*projection.Account) bindPlan {
	plan := bindPlan{results: make([]BindMacResult, len(jobs))}
	passed := make([]bool, len(jobs))
	for i, j := range jobs {
		d := devices[j.req.DeviceID]
		if d == nil {
			plan.results[i] = BindMacResult{RefusalCode: "device_not_found"}
			continue
		}
		acc := accounts[d.ClerkUserID]
		if refusal := bindRefusal(acc, d.TenantID); refusal != "" {
			plan.results[i] = BindMacResult{RefusalCode: refusal}
			continue
		}
		if refusal := deviceBaseRefusal(d, acc, j.req.Serial); refusal != "" {
			plan.results[i] = BindMacResult{RefusalCode: refusal}
			continue
		}
		if d.ACMEBoundAt == nil && len(d.CertKeySha256) > 0 {
			plan.results[i] = BindMacResult{RefusalCode: "device_key_bound"}
			continue
		}
		passed[i] = true
	}

	firstKey := make(map[string][]byte, len(jobs))
	conflict := make(map[string]bool)
	for i, j := range jobs {
		if !passed[i] {
			continue
		}
		if prev, ok := firstKey[j.req.DeviceID]; !ok {
			firstKey[j.req.DeviceID] = j.req.KeySha256
		} else if !bytes.Equal(prev, j.req.KeySha256) {
			conflict[j.req.DeviceID] = true
		}
	}

	queuedSet := make(map[string]bool)
	queuedClear := make(map[string]bool)
	clear := func(id string) {
		if !queuedClear[id] {
			queuedClear[id] = true
			plan.cleared = append(plan.cleared, id)
		}
	}
	for i, j := range jobs {
		if !passed[i] {
			continue
		}
		d := devices[j.req.DeviceID]
		switch {
		case conflict[d.ID]:
			clear(d.ID)
			plan.results[i] = BindMacResult{RefusalCode: "acme_key_conflict"}
		case d.ACMEBoundAt == nil:
			if !queuedSet[d.ID] {
				queuedSet[d.ID] = true
				plan.setIDs = append(plan.setIDs, d.ID)
				plan.setKeys = append(plan.setKeys, j.req.KeySha256)
			}
			plan.results[i] = BindMacResult{OK: true}
		case len(d.CertKeySha256) == 32 && bytes.Equal(d.CertKeySha256, j.req.KeySha256):
			plan.results[i] = BindMacResult{OK: true}
		default:
			clear(d.ID)
			plan.results[i] = BindMacResult{RefusalCode: "acme_key_conflict"}
		}
	}
	return plan
}

func setBatchTimeouts(ctx context.Context, tx pgx.Tx) error {
	// PG 18 supports transaction_timeout, lock_timeout, and statement_timeout locally.
	if _, err := tx.Exec(ctx, `SET LOCAL lock_timeout = '2000ms'`); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `SET LOCAL statement_timeout = '3500ms'`); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `SET LOCAL transaction_timeout = '4000ms'`); err != nil {
		return err
	}
	return nil
}

// lockAndLoadAccounts locks the batch's accounts (FOR SHARE, sorted by
// clerk_user_id) and reads every gate input of each into a projection.Account.
//
// ⚠ THROUGH authd.enroll_lock_gate_accounts, NOT A DIRECT `FOR SHARE`. Every
// row-locking clause, FOR SHARE included, needs UPDATE privilege on a column of
// the locked table, and `enroll_writer` has none on authd.accounts. The SECURITY
// DEFINER function takes the lock as its owner; the row locks still belong to
// this transaction, so they are held until the batch commits and block every
// UPDATE or DELETE of those accounts (a suspension, a deletion, an epoch bump)
// in the meantime. The domain gate is filled in by evaluateDomainsOnce.
func lockAndLoadAccounts(ctx context.Context, tx pgx.Tx, uids []string) (map[string]*projection.Account, error) {
	out := make(map[string]*projection.Account, len(uids))
	if len(uids) == 0 {
		return out, nil
	}
	rows, err := tx.Query(ctx, `SELECT * FROM authd.enroll_lock_gate_accounts($1::text[])`, uids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var a projection.Account
		var tenant, managedConn pgtype.Text
		if err := rows.Scan(
			&a.ClerkUserID, &a.Email, &a.Active, &tenant, &a.CredentialEpoch,
			&a.Suspended, &a.PaymentHold, &a.Deleting, &a.Banned, &a.Locked,
			&a.MailDomain, &a.Managed, &managedConn, &a.ConnectionInactive,
			&a.SSORequired, &a.SSOExempt,
		); err != nil {
			return nil, err
		}
		a.TenantID = tenant.String
		a.ManagedConnection = managedConn.String
		out[a.ClerkUserID] = &a
	}
	return out, rows.Err()
}

// evaluateDomainsOnce calls core.mailbox_domain_refused once per distinct
// (tenant_id, mail_domain) across the entire batch.
func evaluateDomainsOnce(ctx context.Context, tx pgx.Tx, accounts map[string]*projection.Account) error {
	if len(accounts) == 0 {
		return nil
	}
	seen := make(map[domainKey]struct{})
	var tenants []pgtype.Text
	var domains []string
	for _, a := range accounts {
		dk := domainKey{tenant: a.TenantID, domain: a.MailDomain}
		if _, ok := seen[dk]; ok {
			continue
		}
		seen[dk] = struct{}{}
		tenants = append(tenants, optText(a.TenantID))
		domains = append(domains, a.MailDomain)
	}
	rows, err := tx.Query(ctx, `
		SELECT coalesce(d.tenant_id::text, ''), d.domain, core.mailbox_domain_refused(d.tenant_id, d.domain)
		  FROM unnest($1::uuid[], $2::text[]) AS d(tenant_id, domain)
	`, tenants, domains)
	if err != nil {
		return err
	}
	refused := make(map[domainKey]bool, len(domains))
	for rows.Next() {
		var dk domainKey
		var r bool
		if err := rows.Scan(&dk.tenant, &dk.domain, &r); err != nil {
			rows.Close()
			return err
		}
		refused[dk] = r
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for _, a := range accounts {
		a.DomainNotHosted = refused[domainKey{tenant: a.TenantID, domain: a.MailDomain}]
	}
	return nil
}

// mintRefusal is apps/api/src/mail-devices/store.ts `mintRefusal` plus the
// session's email: the mint-specific checks here, then the ONE copy of the
// hold and route rules, gate.Refusal (internal/gate), on the locked row.
func mintRefusal(acc *projection.Account, req MintRequest) string {
	if acc == nil {
		return "account_not_found"
	}
	if acc.TenantID != derefOr(req.TenantID) {
		return "tenant_mismatch"
	}
	if !acc.Active {
		return "account_inactive"
	}
	if acc.CredentialEpoch != req.ExpectedEpoch {
		return "epoch_mismatch"
	}
	if req.Email != "" && strings.ToLower(acc.Email) != strings.ToLower(req.Email) {
		return "email_mismatch"
	}
	return gate.Refusal(acc)
}

// bindRefusal is store.ts `bindRefusal`: tenant and active here, then
// gate.Refusal for every hold and route rule.
func bindRefusal(acc *projection.Account, tenantID string) string {
	if acc == nil {
		return "account_not_found"
	}
	if acc.TenantID != tenantID {
		return "tenant_mismatch"
	}
	if !acc.Active {
		return "account_inactive"
	}
	return gate.Refusal(acc)
}

// deviceBaseRefusal is store.ts `deviceKeyRefusal` before the key-presence and
// #536 conflict checks (planBinds does those).
func deviceBaseRefusal(d *lockedDevice, acc *projection.Account, expectedSerial string) string {
	if d == nil {
		return "device_not_found"
	}
	if d.ClerkUserID != acc.ClerkUserID ||
		strings.ToLower(d.Email) != strings.ToLower(acc.Email) ||
		d.TenantID != acc.TenantID {
		return "device_mismatch"
	}
	if d.Platform != gate.Macos {
		return "device_not_macos"
	}
	if !d.Alive {
		return "device_expired"
	}
	if d.Serial == nil || *d.Serial == "" {
		return "device_serial_missing"
	}
	if *d.Serial != expectedSerial {
		return "serial_mismatch"
	}
	return ""
}

func derefOr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// optText is a nullable text parameter: "" is SQL NULL.
func optText(s string) pgtype.Text {
	return pgtype.Text{String: s, Valid: s != ""}
}

func distinctSortedUIDsFromMints(jobs []mintJob) []string {
	m := make(map[string]struct{}, len(jobs))
	for _, j := range jobs {
		m[j.req.ClerkUserID] = struct{}{}
	}
	out := make([]string, 0, len(m))
	for u := range m {
		out = append(out, u)
	}
	sort.Strings(out)
	return out
}

func distinctSortedDeviceIDs(jobs []bindJob) []string {
	m := make(map[string]struct{}, len(jobs))
	for _, j := range jobs {
		m[j.req.DeviceID] = struct{}{}
	}
	out := make([]string, 0, len(m))
	for id := range m {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

func pgErrCode(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code
	}
	return ""
}

func isDeadlockOrSerialization(err error) bool {
	code := pgErrCode(err)
	return code == "40P01" || code == "40001"
}

func isConstraintViolation(err error) bool {
	code := pgErrCode(err)
	return len(code) == 5 && strings.HasPrefix(code, "23")
}

func constraintRefusalCode(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		if pgErr.Code == "23505" {
			if pgErr.ConstraintName == "mail_devices_cert_key_sha256_unique" {
				return "key_in_use"
			}
			if pgErr.ConstraintName == "mail_devices_enrollment_id_unique" {
				return "enrollment_conflict"
			}
			return "unique_violation"
		}
		if pgErr.Code == "23503" {
			return "account_not_found"
		}
	}
	return "db_constraint_violation"
}
