# Evidence

A database change is accepted on measurements taken on a scale database. This
file says what to measure, how to build the database, and how to read the result.

## What the PR carries

For every new or changed query: in TypeScript, Go, or the body of a SQL function
or trigger:

1. **The statement as Postgres receives it**, with its parameters. Do not quote
   the Drizzle source. Render it:
   ```ts
   import { PgDialect } from "drizzle-orm/pg-core"
   const { sql, params } = new PgDialect().sqlToQuery(statement)
   ```
   For a query-builder chain, `.toSQL()` gives the same.
2. **`EXPLAIN (ANALYZE, BUFFERS)` output** on the scale database, run as the role
   production uses (see "Run it as production does" below), with:
   - realistic parameters: a typical tenant, a typical account, and
   - the worst case: the largest tenant, the most-spread distribution (one row
     per tenant or domain), the rarest state the query filters on, and the
     biggest array the caller can pass.
   Run each one twice and report the second run (warm cache). Note the first
   run's `shared read` count if it is large.
3. **From the plan:** the top node types, estimated and actual rows, `shared
   hit` and `read` buffers, and execution time. Buffers are what you compare,
   because they do not depend on the machine. Milliseconds on a laptop do not
   carry over to a 1 GiB pod.
4. **The call rate:** how often it runs (per request, per bind, per message, per
   sweep tick) and the resulting load, as in section 9 of
   `docs/research/mail-device-binding.md` ("core share at 1 Hz").
5. **For writes:** `EXPLAIN (ANALYZE, BUFFERS, WAL)` on a representative
   `INSERT`, `UPDATE` or `DELETE` (it rolls back if you wrap it in `BEGIN;` ...
   `ROLLBACK;`), the number of indexes on the table, and whether updates stay HOT
   (see `writes.md`).
6. **For API changes:** the number of queries per request, measured, not
   counted by reading code (see "Counting queries per request").

PostgreSQL 18 adds `BUFFERS` to `EXPLAIN ANALYZE` by default (release notes
E.7.3.2.3). Write it out anyway, so the command reads the same in every PR.

## Getting a scale database

> **PLACEHOLDER: scale seed tooling (#507), not built yet.**
> The seed tooling being built for #507 will live at
> `TODO(#507): path of the scale seed`. When it merges, replace this block with
> its exact command and remove the manual steps below. Until then there is no
> seed command: do not invent one. Use the manual steps.

Never measure on the cluster, on prod, or on the shared dev database on port
5433. Use a throwaway server.

1. **Start a throwaway Postgres 18** from the image production runs,
   `ghcr.io/cloudnative-pg/postgresql:18.6-standard-bookworm` (pinned in both
   `infra/k8s/i10/platform-db/cluster.yaml` and `compose.dev.yaml`), on a free
   port. `pgvector/pgvector:pg18` also works. Either needs pgvector, because the
   risk engine's migrations create vector columns.
2. **Create what CNPG creates in prod**, because migrations grant to these roles
   by name: login roles `i10` (owner, NOT a superuser), `authd`, `i10_api`,
   `pdns`, `stalwart`; database `i10` owned by `i10` (migration 0001 grants on it
   by name); `create extension vector` in `i10` as the superuser. `setUp()` in
   `apps/api/scripts/check-migrations.ts` is the reference for this list.
3. **Migrate as the owner, through the real runner:**
   ```sh
   cd apps/api
   MIGRATE_DATABASE_URL=postgres://i10:<password>@127.0.0.1:<port>/i10 bun src/migrate.ts
   ```
   It prints `migrations applied`.
4. **Seed with SQL built on `generate_series`**, in the shape of
   `docs/research/mail-device-binding/sweep-seed.sql`. That file lands with the
   I10-62 mail front PR (branch `feat/i10-62-mail-front` until then). Rules for
   a seed:
   - At least 10 times the largest live set you can name, and at least the
     scale in the brief: 500,000 `authd.accounts` over 20,000 tenants is the
     current reference.
   - Two distributions. Clustered: many rows per tenant or domain, like a
     company. Spread: one per tenant, the worst case for anything grouped by
     tenant or domain.
   - The minority states the query filters on (suspended, payment hold,
     deleting, SSO-required, managed) at realistic rates, because a partial index
     or a selective filter only shows its value against them.
   - Rows in every message partition the query can touch, not only the
     current month.
5. **`ANALYZE` after seeding.** Without it the planner plans on empty-table
   guesses, and the plan you record is not the plan prod will run.

### Run it as production does

- **API queries on `core` and `identity`:** connect as `i10_api` and run inside a
  transaction with the tenant set, because RLS policies are part of the plan:
  ```sql
  BEGIN;
  SELECT set_config('app.tenant_id', '<tenant uuid>', true);
  EXPLAIN (ANALYZE, BUFFERS) <the query>;
  ROLLBACK;
  ```
- **authd queries:** connect as `authd`.
- **Migrations, backfills and definer functions:** the owner `i10`.
- **A function's inside.** `EXPLAIN` of a caller shows a function that is not
  inlined as one opaque node (`Function Scan`, or a filter that calls it). To see
  its own plan, on the throwaway server only, as a superuser:
  ```sql
  LOAD 'auto_explain';
  SET auto_explain.log_min_duration = 0;
  SET auto_explain.log_analyze = on;
  SET auto_explain.log_buffers = on;
  SET auto_explain.log_nested_statements = on;
  ```
  then run the caller and read the plans from the server log. `LOAD` and these
  settings need a superuser (PostgreSQL docs F.3, auto_explain).

### Counting queries per request

On the throwaway server, start Postgres with
`-c shared_preload_libraries=pg_stat_statements` and run `CREATE EXTENSION
pg_stat_statements` in `i10`. Point a local API at it, then:

```sql
SELECT pg_stat_statements_reset();
-- make exactly one request
SELECT calls, rows, query FROM pg_stat_statements
WHERE dbid = (SELECT oid FROM pg_database WHERE datname = 'i10')
ORDER BY calls DESC;
```

The sum of `calls` is the query count for that request. A number that grows with
the size of the page or the number of items is N+1 (`queries.md`). A plainer
alternative is `log_statement = 'all'` on the throwaway server and counting the
log lines.

## Reading a plan: what fails review

| In the plan | Meaning | Usual fix |
| --- | --- | --- |
| `Seq Scan` on a growing table in a hot path | no usable index for the predicate as written | index the expression the query uses (`queries.md`), or rewrite the predicate |
| `loops=N` on a `Function Scan`, `SubPlan` or index scan under a nested loop, N growing with input | per-row work | batch it, inline the function, or judge each distinct key once |
| Buffers that grow with table size, flat result size | the query reads what it then throws away | index or partial index, keyset, tighter predicate |
| `Rows Removed by Filter` large on an index scan | the index finds candidates, the filter rejects most | add the filter column to the index, or make it a partial index |
| Estimated rows 10 times off actual, or worse | bad statistics | `ANALYZE`; `CREATE STATISTICS` for correlated columns; avoid wrapping columns in functions the stats do not know |
| `Sort Method: external merge`, `Batches` above 1 on a hash | spilled to disk | return fewer rows, index the order, never raise `work_mem` globally |
| `Index Only Scan` with high `Heap Fetches` | the visibility map is stale | autovacuum on that table (`growth.md`) |
| A row-level `Filter` with `current_setting(...)` on every row of a big table | an RLS policy the planner cannot use an index for | make the policy's column the leading column of an index |

Sources: PostgreSQL 18 docs, 14.1 "Using EXPLAIN", EXPLAIN reference page, F.3
auto_explain, F.32 pg_stat_statements, release notes E.7.3.2.3.
