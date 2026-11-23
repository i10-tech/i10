# PgBouncer in transaction mode

## What is deployed

- `infra/k8s/i10/platform-db/pooler.yaml`: CNPG `Pooler` `i10-platform-pooler`,
  one instance, `poolMode: transaction`, `max_client_conn: 200`,
  `default_pool_size: 20`. The PgBouncer version is whatever CNPG's default
  image is. The repo does not pin it, so do not depend on features of a
  specific version.
- Behind it: everything except migrations. The API, worker and CronJobs as
  `i10_api` (postgres.js, `max: 10` per process, `prepare: false`,
  `apps/api/src/db/client.ts`). authd as `authd` (pgxpool,
  `QueryExecModeExec`). Stalwart as `stalwart` (`poolMaxConnections: 5`).
  PowerDNS as `pdns`.
- Migrations connect to the primary directly (`i10-platform-rw`, the
  `i10-api-migrate` PreSync Job), because they need one session.

## What breaks in transaction mode

From PgBouncer's "SQL feature map for pooling modes". In transaction mode a client
holds a server connection only for one transaction. The next transaction can land
on a different backend.

| Feature | Transaction mode | What to do here |
| --- | --- | --- |
| `SET` / `RESET` (session) | Never | `set_config(name, value, true)` or `SET LOCAL` inside a transaction (`withTenant`) |
| `LISTEN` | Never | a dedicated direct connection to `i10-platform-rw`, never through the pooler. `NOTIFY` works through it |
| `WITH HOLD` cursors | Never | keyset pagination instead |
| SQL `PREPARE` / `DEALLOCATE` | Never | none needed |
| Protocol-level prepared statements | only with `max_prepared_statements` above 0 | keep them off on the client: `prepare: false` (postgres.js), `QueryExecModeExec` (pgx) |
| Temp tables `PRESERVE` / `DELETE ROWS` | Never | `CREATE TEMP TABLE ... ON COMMIT DROP` inside the transaction, or a CTE |
| `LOAD` | Never | none |
| Session advisory locks | Never | `pg_advisory_xact_lock` |

⚠ **A session `SET` is not "silently ignored", whatever older comments in this
repo say** (`pooler.yaml`, `db/client.ts`). For a parameter PgBouncer does not
track, the change stays on the server connection and leaks to the next client
that gets it, because `server_reset_query` runs only in session mode unless
`server_reset_query_always` is on. For a tracked parameter, PgBouncer restores
each client's own value. `search_path` is tracked on PostgreSQL 18 with a
recent PgBouncer (`track_extra_parameters`). Either way it is wrong here: use
transaction-local settings and schema-qualify every name.

⚠ **Do not pass settings as startup parameters** (postgres.js `connection: {
statement_timeout }`, pgx `RuntimeParams`, `options=-c ...`). PgBouncer rejects
a startup parameter it cannot track unless it is listed in
`ignore_startup_parameters`, and then the setting is ignored, not applied.

## Pool sizing

Two budgets, and a change that adds a process with a pool must state its share
of both.

- **Server connections** (Postgres backends): up to `default_pool_size` (20) per
  user and database pair. Four roles use the pooler, so up to 80. Direct
  connections (the migration Job, CNPG's own) also count. The total must stay
  under Postgres `max_connections`, which `cluster.yaml` does not set, so the
  server default applies (check it with `SHOW max_connections` on the same
  image). Each backend costs memory in a 1 GiB pod. More backends than CPU cores
  add contention, not throughput.
- **Client connections**: the sum of every process's client pool max (API pods
  times 10, worker pods times 10, CronJobs, authd, Stalwart 5, PowerDNS) must
  stay under `max_client_conn` (200). Client connections are cheap for PgBouncer
  (about 2 kB each), but a client pool larger than the server pool only queues
  inside PgBouncer.
- Keep client pools small. A sweep or job that runs one query at a time needs
  `max: 1` or `2`, not 10.
- A slow query holds its server connection for its whole duration. That is why
  section 9 of `docs/research/mail-device-binding.md` counts the sweep's "core
  share" as pooled connection time too.

## Timeouts per role

Nothing in the repo sets `statement_timeout`, `lock_timeout`,
`idle_in_transaction_session_timeout` or `transaction_timeout` today. Without
them one stuck transaction can hold locks and a pooled connection without
limit. Lock waits are unbounded by default (PostgreSQL docs 13.3.4).

- **Per transaction, works now:** `SET LOCAL statement_timeout = '2s'` (or
  `set_config('statement_timeout', '2s', true)`) as the first statement of a
  transaction that must be bounded. It travels with the transaction through
  PgBouncer.
- **Per role, the target:** `ALTER ROLE <role> IN DATABASE i10 SET
  statement_timeout = ...`, and the same for the other three. A role setting
  applies when the role starts a session. PgBouncer pools per user and database
  pair and logs server connections in as that user, so pooled sessions get it,
  unless the Pooler forces a single user. The running Pooler config was not
  checked for that: prove it on a scratch setup first. ⚠ Only a superuser, or a
  `CREATEROLE` role with `ADMIN OPTION` on the target, may set another role's
  defaults (ALTER ROLE, Notes). The migration owner `i10` is neither, and CNPG
  `managed.roles` has no field for settings. So this cannot ship as a plain
  migration. Raise it with the owner, and do not route around it.
- **On PgBouncer:** `query_wait_timeout` (default 120 s) bounds how long a client
  waits for a server connection. `idle_transaction_timeout` (default off)
  disconnects a client idle inside a transaction. Both are `pgbouncer.parameters`
  in the Pooler.
- Rules for values: `lock_timeout` well below `statement_timeout` (otherwise the
  statement timeout always fires first, docs 19.11.1). Interactive roles in
  seconds. Batch jobs set their own longer `SET LOCAL` per transaction. Never set
  them in `postgresql.conf` for everyone (the docs advise against it).

Sources: PgBouncer docs, "Features" (SQL feature map) and "Configuration"
(`max_prepared_statements`, `track_extra_parameters`,
`ignore_startup_parameters`, `server_reset_query_always`, `default_pool_size`,
`max_client_conn`, `query_wait_timeout`, `idle_transaction_timeout`);
PostgreSQL 18 docs 19.11.1 "Statement Behavior", ALTER ROLE, 13.3.4.
