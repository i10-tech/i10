# Migrations that never lock production

## How migrations run today (read from the code, 2026-11-21)

**Where they run.** The `i10-api-migrate` Job in
`infra/k8s/i10/workloads/api.yaml` is an Argo CD `PreSync` hook (wave 0, after
`check-env` at wave -1), with `backoffLimit: 2` and `activeDeadlineSeconds:
300`. It runs `bun dist/migrate.js` (`apps/api/src/migrate.ts`), which calls
`applyMigrations()` in `apps/api/src/migrate-run.ts`. It connects as the owner
`i10` to the primary (`i10-platform-rw`), never through PgBouncer.

**The runner.** One postgres.js connection (`max: 1, prepare: false`). It waits
for the database to accept connections, loads pgvector into the session,
rewrites two known pre-2026-09-28 hashes, then calls Drizzle's
`migrate(drizzle({ client: sql }), { migrationsFolder })` from
`drizzle-orm/postgres-js/migrator`.

**Drizzle's migrator, drizzle-orm 1.0.0-rc.5** (read in `node_modules`:
`pg-core/async/session.js` `migrate`, `migrator.js` `readMigrationFiles`,
`migrator.utils.js` `getMigrationsToRun`):

- `MigrationConfig` has three fields: `migrationsFolder`, `migrationsTable`,
  `migrationsSchema`. There is no per-migration option and no way to run a
  migration outside a transaction.
- It reads `<folder>/migration.sql` from every subfolder, sorted by folder name,
  and splits each file on `--> statement-breakpoint`. `hash` is the SHA-256 of
  the whole file, and `created_at` is the UTC time in the first 14 characters of
  the folder name, in milliseconds.
- It records applied migrations in **`drizzle.__drizzle_migrations`** (`id
  serial`, `hash text not null`, `created_at bigint`, `name text`, `applied_at
  timestamptz default now()`). It creates the table if missing and upgrades a
  0.x table in place first.
- A migration is pending when its folder **name** is not in the table. The hash
  is written but not compared.
- **All pending migrations run inside ONE transaction**, statement by
  statement, with one `INSERT` into the table per migration, then one commit.
- **It takes no advisory lock.** Comments in `migrate-run.ts` and `api.yaml` say
  migrations "take advisory locks". The code does not. One run at a time is
  guaranteed only by the PreSync hook running once per sync.

**What follows from that:**

- `CREATE INDEX CONCURRENTLY`, `DROP INDEX CONCURRENTLY`, `REINDEX ...
  CONCURRENTLY`, `DETACH PARTITION ... CONCURRENTLY` and `VACUUM` fail: they
  cannot run inside a transaction block (CREATE INDEX, ALTER TABLE).
- drizzle-kit 1.0.0-rc.5 does emit `CREATE INDEX CONCURRENTLY` for an index
  marked `.concurrently()` in `schema.ts`. Today that migration fails at deploy.
  Do not use `.concurrently()` until the runner PR lands.
- **Locks pile up across the batch.** A lock taken by the first pending
  migration is held while every later one runs, until the single commit.
- **No `lock_timeout` is set.** A DDL statement waiting for a lock behind a long
  transaction queues, and every later query on that table queues behind the
  DDL. The table is effectively down until the lock is granted or the 300 s
  deadline kills the Job.
- **It is all or nothing.** A failure in migration n rolls back 1 to n-1 too,
  and the Job retries twice.
- **`NOT VALID` then `VALIDATE` in the same deploy gains nothing**, because the
  first statement's lock is held through the validation scan. They must land in
  separate deploys until the runner PR.
- **A backfill cannot commit in batches** inside a migration (see the note in
  `20260916164236_route_split/migration.sql`).

**Proof in CI.** `bun run --filter @i10/api check-migrations`
(`apps/api/scripts/check-migrations.ts`) applies each migration on its own in a
fresh session, as the non-superuser owner, through the same runner.
`scripts/prove-migrations.ts` proves the 0.x to v1 table upgrade. A runner change
must keep both passing.

## Coming in the migration-runner PR (#507): not built yet

The owner decided to change how migrations run, so that `CREATE INDEX
CONCURRENTLY` and other non-transactional DDL work, rather than working around
it. Target design, for that PR to build:

- A migration folder can be **marked non-transactional**. The marker's exact
  form is defined by that PR. Read its documentation when it lands, and do not
  guess a syntax before then.
- **Each normal migration runs in its own transaction**, not one shared batch,
  with `lock_timeout` set.
- **A marked migration runs outside any transaction, statement by statement**
  (on `--> statement-breakpoint`), with `lock_timeout` set on the session.
- Every applied migration is **recorded in `drizzle.__drizzle_migrations`**, in
  the same columns Drizzle writes (`hash`, `created_at`, `name`), so drizzle-kit
  and Drizzle's own migrator stay compatible.
- On a failed concurrent build, the runner **finds the INVALID index left
  behind** (`pg_index.indisvalid = false`), drops it, and retries. A failed
  `CREATE INDEX CONCURRENTLY` leaves an invalid index that is ignored by queries
  but still costs every write (CREATE INDEX, "Building Indexes Concurrently").

### Until that PR merges

**An index on a table that is large or written often is NOT added through a
normal migration. Stop and ask the owner.** "Large or written often" means any
table that grows with customers or traffic, or that a hot path writes:
messages and their events and bodies, webhook deliveries and attempts,
`authd.accounts`, domains, meter events, audit and identity logs. Exceptions: an
index created in the same migration as its brand-new, empty table, and bounded
configuration tables (`core.plans`, `core.routing_settings`).

## Rules for every migration

- Change `schema.ts`, then `cd apps/api && bun run db:generate`, and read the
  SQL. For what Drizzle does not model (a function, a trigger, a grant, a
  backfill), use `bunx drizzle-kit generate --custom --name <name>`. After
  either, `bun run db:generate` must answer "No schema changes"
  (`apps/api/drizzle.config.ts`).
- **Never edit an applied migration**, not even a comment. Fix forward with a
  new migration.
- Name folders so that name order is the order you mean. Two migrations in the
  same second sort by name.
- **Set a lock timeout** as the first statement of any migration that alters an
  existing table: `SET LOCAL lock_timeout = '5s';`. Today it covers the rest of
  the shared batch transaction. A migration that cannot get its lock in 5
  seconds then fails and retries, instead of taking the table down.
- State in the PR which lock each statement takes and for how long
  (PostgreSQL docs 13.3.1, the lock-mode list; ALTER TABLE gives each form's
  lock).

## Recipes

| Change | Cost | Safe way |
| --- | --- | --- |
| Add a nullable column, or one with a non-volatile default (a constant, `now()`) | metadata only, a brief `ACCESS EXCLUSIVE` | plain `generate`, with the lock timeout |
| Add a column with a volatile default (`uuidv7()`, `gen_random_uuid()`, `clock_timestamp()`), a stored generated column or an identity column | **rewrites the table and its indexes** | add it nullable, `SET DEFAULT` for new rows, backfill in batches, then NOT NULL as below. A virtual generated column (the PostgreSQL 18 default) never rewrites |
| `SET NOT NULL` on an existing column | full scan under `ACCESS EXCLUSIVE` | add `CHECK (col IS NOT NULL) NOT VALID`, then in a LATER deploy `VALIDATE CONSTRAINT` (`SHARE UPDATE EXCLUSIVE`), then `SET NOT NULL`, which skips the scan because a valid CHECK proves it (ALTER TABLE, `SET NOT NULL`). PostgreSQL 18 also takes `ADD CONSTRAINT ... NOT NULL col NOT VALID` |
| Add a foreign key | scans the table and locks both tables | `ADD CONSTRAINT ... NOT VALID`, then `VALIDATE CONSTRAINT` in a later deploy. Index the referencing column too, or every parent delete scans the child |
| Add a unique constraint | builds an index under lock | after the runner PR: `CREATE UNIQUE INDEX CONCURRENTLY`, then `ADD CONSTRAINT ... UNIQUE USING INDEX` |
| Change a column's type | rewrites the table, unless the old type is binary-coercible to the new one (`varchar` to `text`) | expand-contract (below). `int` to `bigint` always rewrites |
| Add an index | `SHARE` lock: blocks writes for the whole build | today: see "Until that PR merges". After it: `CREATE INDEX CONCURRENTLY IF NOT EXISTS`, one per marked migration |
| Index a partitioned table (the message tables) | `CONCURRENTLY` is not supported on the parent | `CREATE INDEX ... ON ONLY parent` (invalid), `CREATE INDEX CONCURRENTLY` on each partition, then `ALTER INDEX parent_idx ATTACH PARTITION part_idx` for each (CREATE INDEX, Notes) |
| Drop an index | `ACCESS EXCLUSIVE`, brief | lock timeout. `DROP INDEX CONCURRENTLY` after the runner PR |
| Add an enum value | fast | `ALTER TYPE ... ADD VALUE` works in a transaction, but nothing in the same transaction can use the new value (ALTER TYPE, Notes). Today that means no later migration in the same deploy either |
| Change a function | `CREATE OR REPLACE` cannot rename a parameter or change the return type | keep the signature, or add a new function, switch callers, drop the old one later |
| Backfill | one unbounded `UPDATE` holds row locks and writes WAL for the whole table | never inside a migration on a large table. Write a one-off job (below) |

### Backfills

Write them as a script or job, never as a migration statement on a large table:

- Walk by key: `WHERE id > $last ORDER BY id LIMIT 5000`, one transaction per
  batch.
- The predicate is idempotent (`WHERE new_col IS NULL`), so a rerun only
  touches what is left.
- Pause between batches, and watch WAL. The WAL volume is 2 GiB
  (`cluster.yaml` `walStorage`), and a backfill that outruns the archiver fills
  it.
- Run it as the owner only when it must cross tenants. Otherwise run it per
  tenant through `withTenant`.

### Renames: expand, migrate, contract

**authd's Go SQL (`services/authd/internal/projection`, `budgetstore`) is plain
text against Drizzle's tables.** Nothing fails to compile when a column is
renamed. The authd image also deploys on its own pinned SHA, so the API and
authd always run against each other's old schema for a while. SECURITY DEFINER
functions and RLS policies hold column names in SQL text too. So never `RENAME
COLUMN` in one step on anything authd or a function reads:

1. **Expand:** add the new column or table. The API writes both.
2. **Backfill** the new one in batches.
3. **Switch reads:** authd, the API and every function read the new one.
   Deploy, and confirm authd's pinned SHA includes it.
4. **Stop writing the old one.**
5. **Contract:** drop it in a later release.

Before step 5, search for the old name in `services/`, in
`apps/api/src`, and in the latest definition of every function in
`apps/api/drizzle`.

Sources: drizzle-orm and drizzle-kit 1.0.0-rc.5 source in `node_modules`;
PostgreSQL 18 docs: ALTER TABLE (Description, Notes), CREATE INDEX ("Building
Indexes Concurrently", Notes), ALTER TYPE (Notes), 13.3.1 "Table-Level Locks",
release notes E.7.3.2.1.
