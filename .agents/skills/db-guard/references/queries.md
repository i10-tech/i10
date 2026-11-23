# Query design

Pinned versions: PostgreSQL 18.6 (CNPG image), drizzle-orm and drizzle-kit
1.0.0-rc.5 on postgres.js 3.4.9 (apps/api), pgx v5.10.0 (services/authd).

## Indexes: for the query actually run

An index serves the predicate as Postgres sees it, not the column you meant.

- **A wrapped column needs an expression index.** `WHERE lower(name) =
  lower($1)` cannot use an index on `name`. This is the `mailbox_domain_settings`
  bug. Prefer storing the value normalised once at write time (lowercase, with a
  `CHECK (name = lower(name))`) and comparing it plainly. Otherwise index the
  expression exactly as the query writes it:
  ```ts
  index("domains_name_lower_idx").on(sql`lower(${t.name})`)
  ```
  A new expression index has no statistics until `ANALYZE` runs (CREATE INDEX,
  Notes).
- **Composite order.** Equality columns first, then the range or sort column.
  On tenant-scoped tables `tenant_id` leads, because both the RLS policy and the
  query filter on it. An `ORDER BY` that matches the index order (direction
  included) needs no sort. PostgreSQL 18 can skip-scan a multicolumn B-tree
  without a predicate on its leading column (release notes E.7.3.1.2). That is
  only cheap when the leading column has few distinct values, so do not design
  around it.
- **Partial indexes for "active only".** `WHERE deleting_at IS NULL`, `WHERE
  status = 'verified'`, `WHERE examined_at IS NULL` (the content queues in
  `core.ts` do this). The planner uses a partial index only when it can prove the
  query's `WHERE` implies the index's. Write the same condition as a literal in
  the query. A bound parameter (`status = $1`) does not prove it.
- **Covering `INCLUDE`** turns a hot lookup into an index-only scan when the
  query reads a few extra columns. B-tree, GiST and SP-GiST only, no expressions
  (CREATE INDEX, `INCLUDE`). It pays only on a table that autovacuum keeps
  all-visible (`growth.md`).
- **Every index costs.** It is written on every `INSERT`, on every `UPDATE` that
  is not HOT, and on every `DELETE`'s later vacuum. It adds WAL. It competes for
  cache in a 1 GiB pod. An index on a column that updates often stops those
  updates being HOT (`writes.md`). So:
  - Add an index only with a plan that uses it, before and after.
  - An index on `(a)` is redundant next to `(a, b)` unless it enforces
    uniqueness or the size difference is measured to matter.
  - After traffic exists, `pg_stat_user_indexes.idx_scan = 0` over weeks means
    drop it (`observability.md`).
- **Keys.** Primary keys default to `uuidv7()` (time-ordered, native in
  PostgreSQL 18, release notes E.7.3.4). Keep that. A random v4 key scatters
  inserts across the whole B-tree, and the cache pays for it.

## Pagination: keyset, never `OFFSET` on large sets

`OFFSET n` reads and discards n rows on every page, and on a live log it shows
duplicates and skips rows. `apps/api/src/console/queries.ts` is the pattern:

```sql
WHERE tenant_id = $1 AND (created_at, id) < ($2, $3)
ORDER BY created_at DESC, id DESC
LIMIT $4
```

with an index on `(tenant_id, created_at DESC, id DESC)` (or the same columns
ascending, which a backward scan serves). The cursor is opaque to the client.
Cap the limit on the server (the console caps at 200).

## Batching and arrays

One statement for N keys, never N statements. Bound N (about 1,000 per
statement) so one call cannot hold a large lock set or build a huge parameter.

### Drizzle (drizzle-orm 1.0.0-rc.5)

⚠ **Never interpolate a JS array into a `sql` template.** `sql\`... =
any(${ids})\`` renders `($1, $2)`, a ROW constructor, not an array. With one
element it is a parenthesised scalar and works. With two it fails (`cannot cast
type record to uuid[]`). It shipped twice: billing reconcile failed 48 runs in 23
hours, and metering re-sent usage on every run.

The forms this repo uses, in order of preference:

1. **The query builder's `inArray(col, values)`**. It renders `col in ($1, $2,
   ...)` and renders `1 = 0` for an empty array (source:
   `drizzle-orm/sql/expressions/conditions.js`).
2. **Well-formed values (uuids, enum members, validated domain names): one
   parameter holding an array literal.** One statement text whatever the count:
   ```ts
   sql`... = any(${`{${ids.join(",")}}`}::uuid[])`   // billing/db.ts, webhooks/replay.ts
   ```
   Validate first. A comma, brace, quote or backslash in a value corrupts the
   literal.
3. **Arbitrary text: an `array[...]` of scalar parameters, or one jsonb
   parameter.**
   ```ts
   sql`... = any(array[${sql.join(xs.map((x) => sql`${x}`), sql`, `)}]::text[])`   // metering/ingest.ts
   sql`... from jsonb_array_elements_text(${sql.param(xs)}::jsonb)`               // domains/routing-settings.ts
   ```
4. **Array columns use containment.** `col @> array[$1]` can use a GIN index.
   `$1 = any(col)` cannot (`identity/store.ts`).

Decide the empty case before the query, in code.

**Pin the rendered SQL in a test**, with a one-element AND a two-element case,
because the one-element case hides the bug. The pattern is in
`apps/api/test/claim-sql.test.ts`:

```ts
const { sql, params } = new PgDialect().sqlToQuery(statement)
expect(sql).toContain("$1::uuid[]")
expect(sql).not.toContain("$2")
```

A fake database cannot catch this, because the defect is in what Postgres
receives.

### pgx (v5.10.0)

authd runs `QueryExecModeExec` (`projection/postgres.go`) because of PgBouncer.
That mode infers parameter types from Go types and sends text-format parameters
in one round trip (pgx `conn.go`, `QueryExecModeExec`). Pass a Go slice directly
and cast in SQL so the server never guesses:

```go
rows, err := pool.Query(ctx, `SELECT ... WHERE a.email = ANY($1::text[])`, emails)
```

Ambiguous Go types (a `map[string]string` could be json or hstore) are rejected
in this mode. Pass json as a `string` and cast `::jsonb`.

## No N+1

A query inside a loop over another query's rows makes the query count grow with
the data. Replace it with a join, a `= ANY` batch, or a `LATERAL` subquery. Prove
it with the per-request count in `evidence.md`.

## Functions in hot paths

A function call is not free just because it is SQL. Postgres either **inlines**
a SQL function into the calling query, where the planner can push predicates into
it and use indexes, or **runs it once per call**, as an opaque box.

PostgreSQL 18 source (`src/backend/optimizer/util/clauses.c`, `inline_function`
and `inline_set_returning_function`, REL_18_STABLE) never inlines a function that:

- is not `LANGUAGE sql` (plpgsql is never inlined),
- is `SECURITY DEFINER`,
- has a `SET` clause (`SET search_path`, `SET hnsw.ef_search`, ...).

A scalar SQL function is also refused when it returns a set or `record`, or when
its body is anything but one simple `SELECT expression` (no `FROM`, no
aggregates, no subqueries). A set-returning SQL function is also refused when it
is `VOLATILE` (the default for `CREATE FUNCTION`), `STRICT`, or its arguments
contain volatile expressions. The PostgreSQL wiki page "Inlining of SQL
functions" lists the full conditions.

Almost every function in this repo is `SECURITY DEFINER` with `SET search_path`,
for privilege reasons (the `authd` role may execute a definer and nothing else in
`core`). So treat each one as opaque:

- **Its body is a query and needs its own evidence.** Its `WHERE` must use its
  parameters against an index. `mailbox_domain_settings(p_name)` joined every
  domain to `name_holders(p_name)` without filtering `d` by `p_name`. The fix was
  `AND (p_name IS NULL OR lower(d.name) = lower(p_name))` plus the expression
  index.
- **Never call it once per row of a growing set.** Make it set-based: take an
  array, or judge each distinct key once and join back. `projection.SweepQuery`
  judges each (tenant, domain) once instead of once per account.
- **Mark volatility honestly.** `STABLE` for anything that reads tables,
  `IMMUTABLE` only for pure functions (required for use in an index
  expression). A function left `VOLATILE` runs once per row, and the planner
  can do nothing with it.
- **plpgsql caches plans per connection** and may switch to a generic plan once
  a statement has run several times (41.11.2 "Plan Caching"; the PREPARE page
  gives the rule: five custom plans, then a generic one if its estimated cost is
  close). A parameter-sensitive query inside plpgsql can get slower from the
  sixth call on. Measure past the fifth call.

## CTEs

Since PostgreSQL 12 a `WITH` query that is referenced once and has no side
effects is folded into the outer query. One referenced twice is computed once
(materialized). `MATERIALIZED` forces computation once, `NOT MATERIALIZED` forces
folding (PostgreSQL docs 7.8.3). Use `MATERIALIZED` on purpose to compute a small
key set once, for example the distinct domains of a batch. Use `NOT
MATERIALIZED` when a selective outer predicate must reach an index. A
data-modifying CTE always runs exactly once.

## `EXISTS` versus joins

When you only need to know a match exists, use `EXISTS (SELECT 1 ...)`: a
semi-join, which stops at the first match. A join to a one-to-many table
multiplies rows and then needs `DISTINCT`. Write `NOT EXISTS`, not `NOT IN`:
`NOT IN` returns no rows when the subquery yields a NULL, and it plans worse.

## Counting cheaply

`count(*)` scans everything it counts. On a growing table per request it is a
sequential cost that only rises. Choose by need:

- **A badge that says "1,000+":** `SELECT count(*) FROM (SELECT 1 FROM ... WHERE
  ... LIMIT 1001) s`.
- **An approximate size of a whole table:** `pg_class.reltuples`.
- **An exact number that is read often:** a counter maintained in the same
  transaction as the write, but read `writes.md` on hot rows first. A daily
  rollup row per tenant is usually better.

## JSONB and GIN

- Keep a field you filter or join on as a real column. JSONB has no per-key
  statistics, so its estimates are guesses.
- GIN serves containment (`@>`) and key existence (`?`) on jsonb, and `@>`
  and `&&` on arrays. The `jsonb_path_ops` operator class is smaller and faster
  but supports only `@>` (PostgreSQL docs 8.14.4 "jsonb Indexing").
- GIN is expensive to update. Avoid it on a column that changes often. Bind a
  jsonb value as one parameter, `${sql.param(v)}::jsonb`.

## pgvector

`core.behaviour_vectors` and `core.content_vectors` use HNSW, queried through
definer functions that `SET hnsw.iterative_scan = 'relaxed_order'` and
`hnsw.ef_search = 64`. HNSW filters after the index scan. With a selective
`WHERE` (one tenant), a plain scan returns fewer rows than `LIMIT`. Iterative
scans (pgvector 0.8.0+) keep scanning until enough rows match (pgvector README,
"Filtering", "Iterative Index Scans"). An HNSW build is slow and needs
`maintenance_work_mem` that this pod does not have to spare. On a table with
data it is a non-transactional runner job (`migrations.md`), not a deploy step.

Sources: PostgreSQL 18 docs, CREATE INDEX (Notes, `INCLUDE`), 11.8 "Partial
Indexes", 7.8.3 "Common Table Expression Materialization", 8.14.4, 41.11.2,
PREPARE; release notes E.7.3.1.2 and E.7.3.4; PostgreSQL wiki "Inlining of SQL functions"; PostgreSQL source
`clauses.c` at REL_18_STABLE; pgx v5.10.0 `conn.go`; pgvector README.
