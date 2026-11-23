# Observability

## What exists today

Nothing in `infra/` enables `pg_stat_statements`, `auto_explain` or a metrics
stack for Postgres. The cluster has no Prometheus. Prod also has no traffic yet,
so production statistics cannot prove a query is cheap. That is why the
evidence in `evidence.md` comes from a scale seed, not from prod.

Turning either module on is a `cluster.yaml` change that restarts Postgres. It is
the owner's decision, so propose it in the PR. Do not apply it.

## pg_stat_statements

What it gives: calls, total and mean time, rows, and shared buffer hits and reads
per normalised statement. It is the first place to look for the statements that
cost the most in total (`total_exec_time`), not only the slowest single call.

- **On CNPG:** setting any `pg_stat_statements.*` parameter under
  `spec.postgresql.parameters` makes the operator add the library to
  `shared_preload_libraries` and run `CREATE EXTENSION IF NOT EXISTS
  pg_stat_statements` in every database that accepts connections (CNPG 1.30
  docs, "PostgreSQL Configuration", "Managed extensions").
- It needs shared memory in proportion to `pg_stat_statements.max` (default
  5,000), and loading it needs a restart (PostgreSQL docs F.32).
- `pg_stat_statements.track = top` (the default) counts only client statements.
  Statements inside SECURITY DEFINER functions are invisible unless it is set to
  `all`, and this repo's hot paths run through such functions. Use `all` when
  auditing them.
- Prefer one statement text for any batch size (`= any($1::uuid[])`). An `IN
  ($1, ..., $n)` list renders differently for each n.

Queries worth keeping in a runbook:

```sql
-- what costs the most in total
SELECT calls, round(total_exec_time) AS total_ms, round(mean_exec_time::numeric, 2) AS mean_ms,
       rows, shared_blks_hit, shared_blks_read, left(query, 120)
FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 20;

-- what reads the most pages per call (the scaling risks)
SELECT calls, (shared_blks_hit + shared_blks_read) / greatest(calls, 1) AS blks_per_call, left(query, 120)
FROM pg_stat_statements ORDER BY blks_per_call DESC LIMIT 20;
```

## auto_explain

It logs the plan of any statement slower than a threshold, including statements
nested in functions (`log_nested_statements`). It is not on CNPG's managed list,
so it needs `spec.postgresql.shared_preload_libraries: [auto_explain]` plus its
parameters. Every one of its settings is superuser-only (PostgreSQL docs F.3).

If it is turned on in prod: `log_min_duration` in the hundreds of milliseconds,
`log_analyze` on with `log_timing` off (per-node timing has overhead on some
systems), and `sample_rate` below 1 on a busy server. On a throwaway server, use
it with `log_min_duration = 0` to see function internals (`evidence.md`).

## What to watch (system views, no extension needed)

| View | Watch for |
| --- | --- |
| `pg_stat_user_tables` | `seq_scan` and `seq_tup_read` rising on a growing table; `n_dead_tup` against `n_live_tup`; `last_autovacuum`; `n_tup_hot_upd` / `n_tup_upd` |
| `pg_stat_user_indexes` | `idx_scan = 0` over weeks of real traffic: a drop candidate |
| `pg_index` | `indisvalid = false`: an invalid index from a failed concurrent build, still costing writes |
| `pg_stat_activity` | `state = 'idle in transaction'` for more than seconds; `wait_event_type = 'Lock'`; long `xact_start` |
| `pg_locks` with `pg_blocking_pids(pid)` | who blocks whom during a migration |
| `pg_statio_user_tables` | heap and index hit ratio for the hot tables |
| PgBouncer `SHOW POOLS` | `cl_waiting` above 0 means clients are queueing for a server connection |

Sources: PostgreSQL 18 docs F.32 pg_stat_statements, F.3 auto_explain, 27.2
"The Cumulative Statistics System"; CNPG 1.30 docs "PostgreSQL Configuration";
PgBouncer docs "Usage" (`SHOW POOLS`).
