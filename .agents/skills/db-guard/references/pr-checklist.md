# PR checklist

Paste this into the PR body and fill in every line. Write "n/a" with a reason
where a line does not apply. Attach the plans (a `<details>` block or a file
under `docs/research/`).

```markdown
### Database (db-guard)

**Scale database:** seed and sizes used (rows per table, clustered and spread):
**Roles used for EXPLAIN:** (i10_api with tenant set / authd / owner)

| Query or function | Call site | Runs how often | Plan (top nodes) | Rows est./actual | Buffers hit/read | Time (warm) | Worst case: buffers, time |
| --- | --- | --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |  |  |

- [ ] Every new or changed query has EXPLAIN (ANALYZE, BUFFERS) on the scale seed, typical AND worst-case parameters
- [ ] No sequential scan of a growing table on a hot path (or the reason is written here)
- [ ] No function called per row of a growing set; every definer function's body is index-backed
- [ ] API change: queries per request measured: before __ / after __, flat in page size
- [ ] Arrays bound as one array parameter or `inArray`, never `${array}` in `sql`; rendered SQL pinned in a test (1 and 2 elements)
- [ ] Every new index: the query that uses it, before/after plan, and its write cost (indexes on the table: __, HOT updates kept?)
- [ ] Lists are keyset paginated; no unbounded `count(*)` on a request path
- [ ] Transactions make no network calls while holding locks; lock order is fixed where several rows are locked
- [ ] No hot row (a row every request or message updates)
- [ ] Nothing that breaks PgBouncer transaction mode (session SET, LISTEN, session advisory locks, SQL PREPARE, temp tables without ON COMMIT DROP)
- [ ] Migration: generated from schema.ts (or `--custom` for what Drizzle does not model); `db:generate` says "No schema changes"; no applied migration edited
- [ ] Migration: lock taken per statement and for how long; `SET LOCAL lock_timeout` first; no rewrite or full scan of a large table; no index on a large or busy table (stop and ask until the #507 runner lands)
- [ ] Rename or type change: expand-contract, authd's Go SQL and every function updated in step
- [ ] Growth: how big each new table gets and what removes rows (retention, partition drop, TTL)
- [ ] Redis: every key has a TTL; key count and bytes at scale; nothing needed after a Redis restart lives only there
- [ ] Access removed anywhere: every cache of that access is invalidated in this change, with a test
```
