# Growth: tables that never stop growing

Every new table answers one question in its PR: **how big does it get, and what
removes rows from it?** "Nothing, ever" is an answer only for configuration and
for records the law or billing needs (`core.meter_events` is never deleted by
retention).

## Retention and partitions in this repo

- `core.messages` and `core.message_bodies` are `PARTITION BY RANGE
  (created_at)`, and `core.message_events` is `PARTITION BY RANGE (occurred_at)`
  (migration `20260901141742_tenancy`), with monthly partitions.
- The hourly retention job (`apps/api/src/retention.ts`) keeps a year of
  partitions ahead (`core.ensure_message_partitions(12)`), deletes each
  workspace's mail older than its plan keeps it (leaving a tombstone), and drops
  a partition only once it is empty (`core.drop_empty_message_partitions`).
  Retention differs by plan (Free 3 days, Pro 30), so a whole month cannot be
  dropped while any workspace still keeps it. That makes retention a `DELETE`,
  and deletes leave dead rows for autovacuum.
- RLS on a partitioned table applies only through the parent. Every new
  partition must be locked down like migration 0064's, and `assertRlsSubject` in
  `db/client.ts` refuses to start if a partition is readable directly.
- A partitioned parent is `relkind = 'p'`, not `'r'`. A catalog query that
  filters `relkind = 'r'` silently misses the message tables.

## When to partition

Partition when old data leaves in time-sized chunks and the hot queries filter on
the partition key. Then pruning skips old partitions, and removing a month is
`DROP` or `DETACH PARTITION ... CONCURRENTLY` instead of a `DELETE`. Do not
partition a table that is queried mostly by something other than the key: every
query then touches every partition. A unique constraint on a partitioned table
must include the partition key (PostgreSQL docs 5.12.2.3, "Limitations").

## When not to keep it at all

- Ephemeral state (sessions, one-time codes, rate windows, locks) belongs in
  Redis with a TTL (`redis.md`), or in a table with an `expires_at`, a partial
  or plain index on it, and a sweep that deletes in batches.
- Logs that nothing reads after a week get a retention rule in the same PR that
  creates them.

## Autovacuum on churny tables

Autovacuum vacuums a table once its dead rows pass `autovacuum_vacuum_threshold
+ autovacuum_vacuum_scale_factor * reltuples` (24.1.6). With the default scale
factor (0.2), a 10 million row table waits for 2 million dead rows. PostgreSQL 18
caps that with `autovacuum_vacuum_max_threshold` (default 100,000,000, release
notes E.7.3.1.6), which only matters for very large tables.

For a table with heavy updates or deletes (queues, claims, retention deletes,
counters), set per-table storage parameters in the migration that creates or
changes it, and say why:

```sql
ALTER TABLE core.x SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 1000);
```

Insert-only tables get vacuumed by the insert threshold (default scale factor
0.2), which also keeps the visibility map fresh for index-only scans (24.1.4).
Check the effect after traffic with `n_dead_tup`, `last_autovacuum` and
`n_tup_hot_upd` in `pg_stat_user_tables`.

## Bloat

Dead rows and index entries that vacuum frees are reused, not returned to the
OS (24.1.2). A table that a backfill rewrote, or that lost most of its rows, stays
its old size. `VACUUM FULL` takes `ACCESS EXCLUSIVE` and rewrites everything, so
it is never a production step. Prevent bloat instead: no no-op updates
(`writes.md`), HOT-friendly updates, batched deletes, partitions for time-based
removal.

## TOAST

A row wider than about 2 kB has its large values compressed and moved
out-of-line into the TOAST table (66.2). Reading a toasted column costs extra
reads, and updating any column of a row rewrites the row but keeps the toasted
values unless they change.

- Do not `SELECT *` on tables with large columns (bodies, jsonb payloads,
  attachments lists) in list queries. Name the columns you show.
- Keep large, rarely read values in their own table or in R2. This repo keeps
  full bodies sealed in R2 packs and only compacted ones in Postgres.

Sources: PostgreSQL 18 docs, 5.12 "Table Partitioning", 24.1 "Routine
Vacuuming" (24.1.2, 24.1.4, 24.1.6), 19.10.1 "Automatic Vacuuming", 66.2 "TOAST",
release notes E.7.3.1.6.
