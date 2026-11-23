---
name: db-guard
description: Required procedure for ANY change in i10 that touches the database or Redis, or depends on them. Load it BEFORE writing or reviewing a change to apps/api/src/db (schema.ts, core.ts, identity.ts), anything under apps/api/drizzle, a Drizzle `sql` template or query builder call in TypeScript, a pgx query in Go (services/authd), a SQL or plpgsql function, a SECURITY DEFINER function, a trigger, an RLS policy, a role or grant, an index, a backfill, a connection pool, PgBouncer or CNPG settings, or a Redis cache, counter, rate limit, lock or queue. It says what evidence the PR must carry (EXPLAIN ANALYZE on a scale seed, query counts) and which designs are refused.
---

# db-guard

The database is the one part of i10 that more pods cannot scale: one CNPG
Postgres 18 primary (1 GiB memory limit), one PgBouncer in transaction mode, one
Redis with `noeviction` shared by queues and caches. Design every database change
so it still holds at 50,000 accounts and 20,000 domains, and costs close to
nothing at 10. Prove both with measurements. Argument is not evidence.

Why this skill exists: `core.mailbox_domain_settings` looked domains up by
`lower(name)` with no index on that expression, inside a `SECURITY DEFINER`
function, which Postgres never inlines. A per-row call scanned all 20,000 domains
at about 14 ms each. The mail front's sweep cost 1.4% of a core at 10 accounts and
2,800% at 50,000 (`docs/research/mail-device-binding.md` section 9, "Mail front
scale"). Nothing caught it because prod has no traffic yet, and prod will not
catch the next one either.

## Procedure

1. **Name the change.** Write down each query, function, index, migration and
   Redis key the change adds or alters, with its call site and how often it runs
   (per request, per bind, per message, per second, per hour).
2. **Read the reference for each area you touch** (table below). Each rule there
   comes from this repo's code or an incident, with a doc citation.
3. **Check the red flags below.** If one applies, redesign before you measure.
   If you cannot redesign, stop and ask the owner.
4. **Measure on a scale database** (`references/evidence.md`): `EXPLAIN (ANALYZE,
   BUFFERS)` for every new or changed query, with realistic parameters AND the
   worst-case distribution, plus the query count per request for API changes.
5. **Paste the checklist** from `references/pr-checklist.md` into the PR body,
   filled in, with the plans attached. An unfilled line is a failed review.

When you review someone else's diff, apply the same procedure. A database PR
without the evidence is not reviewable: ask for it, do not estimate it.

## Hard rules (each one has already broken something here)

- **Migrations are generated, never pushed.** Change `schema.ts`, run
  `bun run db:generate`, read the SQL. Hand-written SQL goes through
  `drizzle-kit generate --custom` and must leave `db:generate` answering "No
  schema changes". Never edit an applied migration under `apps/api/drizzle`, not
  even a comment: the hash is recorded, and an em dash sweep once broke the v1
  upgrade in prod.
- **Today every pending migration runs in ONE transaction**, so `CREATE INDEX
  CONCURRENTLY` cannot run in a migration, and every lock a migration takes is
  held until the whole deploy's batch commits. Until the migration-runner PR
  (#507) lands, an index on a large or frequently written table is NOT added
  through a normal migration: stop and ask. See `references/migrations.md`.
- **Every statement is schema-qualified** (`core.`, `authd.`, `identity.`).
  Nothing lives in `public`.
- **Tenant context goes through `withTenant`** (`set_config('app.tenant_id', $1,
  true)` inside a transaction). Never a session `SET`, never `set_config(...,
  false)`: through PgBouncer that leaks one tenant's id to the next client.
- **Never interpolate a JS array into a Drizzle `sql` template.** It renders as a
  row `($1, $2)`, not an array, and works until the second element. Use one of
  the forms in `references/queries.md` and pin the rendered SQL in a test with a
  one-element and a two-element case.
- **authd's Go SQL is plain text against Drizzle's tables.** A rename or type
  change in `schema.ts` must change `services/authd` in the same PR, through an
  expand-contract migration.
- **Every Redis key on `i10-redis` has a TTL.** The instance is `noeviction` and
  holds the send and webhook queues: a cache that only grows ends in queue writes
  refused with OOM.
- **Every path that removes access invalidates every cache of that access**, in
  the same change, with a test (`services/authd/README.md`, "The credential
  cache").

## Red flags: stop and redesign

- A sequential scan of a table that grows with customers (accounts, domains,
  messages, events, bodies, deliveries, audit rows) on a hot path, with no written
  reason.
- A function (`SECURITY DEFINER`, plpgsql, `SET` clause, `VOLATILE`) called once
  per row of a set that grows.
- A query whose buffers grow with table size while its result does not.
- N+1: a query inside a loop over rows from another query.
- `OFFSET` on a list that can grow past a few hundred rows.
- `count(*)` over a growing table to show a number in the UI on every request.
- A row that every request or every message updates (a global counter, a
  "last seen" on a shared row).
- A transaction that waits on the network (Clerk, SES, R2, Polar, a webhook)
  while it holds row locks.
- A new index with no query that its plan shows using it, or an index that
  duplicates the left prefix of another.
- A migration that rewrites or full-scans a large table, or takes `ACCESS
  EXCLUSIVE` on a hot table, inside the deploy.
- Session state through PgBouncer: `SET` without `LOCAL`, `LISTEN`, session
  advisory locks, SQL `PREPARE`, temp tables without `ON COMMIT DROP`.
- An access decision cached without instant invalidation, or state that exists
  only in Redis and is needed after a Redis restart.
- A periodic job that re-reads everything every tick when it only needs what
  changed.

## References

| Area | File |
| --- | --- |
| Evidence, the scale database, reading a plan | `references/evidence.md` |
| Indexes, query shapes, arrays, functions, CTEs, counting, JSONB, pgvector | `references/queries.md` |
| Transactions, locks, queues, upserts, hot rows, idempotency | `references/writes.md` |
| PgBouncer transaction mode, pool sizing, timeouts per role | `references/pgbouncer.md` |
| How migrations run today, zero-lock recipes, expand-contract | `references/migrations.md` |
| Retention, partitions, autovacuum, bloat, TOAST | `references/growth.md` |
| Redis: what belongs there, caches, stampedes, invalidation | `references/redis.md` |
| pg_stat_statements, auto_explain, what to watch | `references/observability.md` |
| The checklist to paste into the PR | `references/pr-checklist.md` |
