# Writes and concurrency

## Keep transactions short, and off the network

Through PgBouncer in transaction mode, a transaction holds one server connection
from `BEGIN` to `COMMIT`. The pool has 20 per user and database
(`infra/k8s/i10/platform-db/pooler.yaml`). A Clerk, SES, R2, Polar or webhook
call inside `withTenant(...)` holds that connection, and every row lock taken so
far, for the length of the call. Ten slow calls at once and the API waits in
PgBouncer's queue.

- Do the network call first, then open the transaction and write the result.
  Or write an intent row, commit, call, then write the outcome. Never call out
  while holding locks.
- A transaction waits for a row or table lock without limit unless a timeout
  stops it (PostgreSQL docs 13.3.4). See `pgbouncer.md` for the timeouts this
  repo should set.

## Lock ordering and deadlocks

Two transactions that lock the same rows in different orders deadlock, and
Postgres aborts one of them (13.3.4). Prevent it:

- When one transaction locks several rows, lock them in a fixed order first:
  `SELECT ... WHERE id = ANY($1) ORDER BY id FOR UPDATE`. A plain `UPDATE ...
  WHERE id = ANY($1)` does not guarantee an order.
- To serialise work on something that has no single row (a workspace's role
  set), use a transaction-level advisory lock, as `console/roles-db.ts` does:
  `pg_advisory_xact_lock(hashtextextended('workspace_roles:' || id, 0))`. Never
  the session-level `pg_advisory_lock`, which PgBouncer breaks (`pgbouncer.md`).
- A trigger on a child table that updates its parent row makes every child
  insert lock the parent. That is a hot row and a deadlock source. Avoid it.
- Treat `40P01` (deadlock) and `40001` (serialization failure) as retryable:
  retry the whole transaction from the start a bounded number of times.

## Isolation

Read Committed is the default. Each statement sees a new snapshot, so two
statements in one transaction can see different data (13.2.1). A
read-then-write across two statements loses updates under concurrency. Fix it
with one of these, in order of preference:

1. Do it in one statement: `UPDATE ... SET n = n + 1`, `INSERT ... ON CONFLICT`,
   `UPDATE ... WHERE state = 'x' RETURNING` (a compare-and-set).
2. Lock what you read: `SELECT ... FOR UPDATE`.
3. Repeatable Read or Serializable, with a retry loop on `40001` (13.2.2,
   13.2.3). Use this only when 1 and 2 cannot express the rule.

## Queues in Postgres: `FOR UPDATE SKIP LOCKED`

The send and webhook queues are groupmq in Redis. The Postgres row is the
record, and sweeps re-enqueue what no job points at. `db/claim.ts` is the
other half: Redis decides who tries, a compare-and-set `UPDATE` in Postgres
decides who sends. Background work queued in tables uses `SKIP LOCKED`
(`content/attachments.ts`, `content/packs.ts`, `webhooks/health.ts`). The
shape:

```sql
UPDATE core.x SET claimed_at = now(), claimed_by = $1
WHERE id IN (
  SELECT id FROM core.x
  WHERE claimed_at IS NULL AND due_at <= now()
  ORDER BY due_at
  LIMIT $2
  FOR UPDATE SKIP LOCKED
)
RETURNING ...
```

- A partial index on the pending state (`WHERE claimed_at IS NULL`), ordered by
  the `ORDER BY` column. Without it, every claim scans the finished rows too.
- A stale-claim sweep returns the rows of a crashed worker.
- `SKIP LOCKED` gives an inconsistent view of the data on purpose. Use it for
  queues only (SELECT, "The Locking Clause").

## Upserts

- `INSERT ... ON CONFLICT (cols) DO UPDATE` needs a unique index or constraint
  on exactly those columns. For a partial unique index, repeat its predicate:
  `ON CONFLICT (cols) WHERE <predicate>` (INSERT, `conflict_target`).
- Skip identical writes: `DO UPDATE SET ... WHERE (t.a, t.b) IS DISTINCT FROM
  (excluded.a, excluded.b)`. An update that changes nothing still writes a new
  row version, WAL, and later vacuum work. Redelivered webhooks do this often.
- `ON CONFLICT DO NOTHING RETURNING` returns no row for the existing one. Use
  PostgreSQL 18 `RETURNING old.*, new.*` (release notes E.7.3.2), or select
  afterwards, when you need it.

## Hot rows

One row that every request, bind or message updates serialises all of them on
its row lock. Each update also leaves a dead row version behind. The designs
that scale:

- **Append, then roll up.** Insert one row per event (`core.meter_events` is
  append-only with `ingested_at`) and aggregate on a schedule or on read with an
  index on `(tenant_id, time)`.
- **Spread the counter.** N rows per key, update a random one, sum on read.
- **Count in Redis** when losing a few seconds of counts on a Redis crash is
  acceptable (rate limits, not billing). See `redis.md`.

## HOT updates

An update that changes no indexed column, and whose new version fits on the same
page, skips every index write ("heap-only tuple", docs 66.7). On an
update-heavy table:

- Do not index a column that changes on most updates (`updated_at`,
  `last_seen_at`, counters) unless a measured query needs it.
- Lower `fillfactor` (for example 90) to leave room on each page.
- Check `n_tup_hot_upd` against `n_tup_upd` in `pg_stat_user_tables`.

## Sequences, counters and ids

- Ids come from `uuidv7()` or a sequence, never `max(id) + 1` or a counter row.
  A sequence is not transactional: it has gaps after rollbacks, and it never
  blocks.
- A gapless number (an invoice number) needs a counter row locked per tenant.
  That serialises the tenant's writes, so accept it only where the law or the
  product demands gaplessness.

## Idempotency

A retried request, a redelivered webhook or a replayed job must not apply twice.

- The guarantee is a unique constraint, for example `(tenant_id,
  idempotency_key)` or a provider's event id, with `INSERT ... ON CONFLICT DO
  NOTHING RETURNING`. A `SELECT` before the `INSERT` races.
- groupmq's `:unique:` keys and Polar's `external_id` dedupe are
  conveniences on top. The database constraint is the guarantee.
- A handler must be safe to run twice. `infra/k8s/i10/redis/redis.yaml` depends
  on that.

## Triggers

A row trigger runs inside the writer's transaction, once per row. A trigger that
writes another table doubles the write cost of every statement on its table, and
creates a hot row if many writers touch the same target. The
`plan_assignments_plan_since` trigger
(`apps/api/drizzle/20260929035747_plan_since_trigger`) is the cheap kind: a
`BEFORE UPDATE` that only edits `NEW`. For bulk statements, prefer a
statement-level trigger with transition tables.

## Bulk writes

One `INSERT ... VALUES (...), (...)` or `INSERT ... SELECT FROM unnest($1::uuid[],
$2::text[])`, in batches of about 1,000. Never one statement per row in a loop.

Sources: PostgreSQL 18 docs, 13.2 "Transaction Isolation", 13.3.4 "Deadlocks",
13.3.5 "Advisory Locks", SELECT ("The Locking Clause"), INSERT (`ON CONFLICT`),
66.7 "Heap-Only Tuples (HOT)", release notes E.7.3.2.
