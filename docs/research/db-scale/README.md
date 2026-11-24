# Database scale harness (#507, phase 1)

A realistic data generator, a registry of every hot query found in the code, a measurement run over that registry, and a way to plan queries with production's statistics without production's rows. This is measurement only. No pass or fail gate exists yet: the CI gate with hard limits is built later from these numbers. The fixes belong to the #507 audit, and nothing here changes the schema.

Everything runs on loopback docker containers named `dbscale-*`. Nothing here can reach the cluster or a real account.

Artifacts in this directory include the large-profile measurement from 2026-11-22 and the small-profile chaos run from 2026-11-23:

| File                                                           | What it is                                                                         |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [report-2026-11-22.md](report-2026-11-22.md)                   | The measurement report: wrong answers, flagged plans, every statement, index facts |
| [chaos-2026-11-23.md](chaos-2026-11-23.md)                     | Schema-derived chaos candidates, registry row coverage, and findings               |
| [measure-2026-11-22.csv](measure-2026-11-22.csv)               | One row per (entry, case, statement), every number in the report                   |
| `plans-2026-11-22.jsonl`                                       | The analysed plan of every statement, and of every statement inside a function     |
| [stats-roundtrip-2026-11-22.md](stats-roundtrip-2026-11-22.md) | The scrubbed-statistics round trip                                                 |

## Findings, ranked by risk

Measured on main as it is, `large` profile, warm cache, through PgBouncer in transaction mode. The `lower(name)` index on `core.domains` and `core.join_domains` that #383's mail front PR adds is not on main, so finding 2 is measured without it.

1. **Every authd lookup by address reads all of `authd.accounts`.** `authd.accounts_by_address` (services/authd/internal/projection/postgres.go `AccountsByAddress`) runs for every IMAP and SMTP sign-in and every LDAP search Stalwart makes for a recipient. At 300,000 mailboxes it takes 262 ms p50 for one address and 823 ms for a 50-recipient delivery. It reads and discards 300,001 rows, and it hashes all 40,222 rows of `authd.managed_accounts` for the left join. The cause is in the plan: `a.email = ANY($1) OR EXISTS (alias ...)` is one OR with a correlated subquery, so `accounts_email_unique` cannot be used and the planner filters every active row. The cost grows linearly with the number of mailboxes, not with the size of the tenant. **A lookup for an address that does not exist costs the same full scan (206 ms)**, so mail sent to random addresses at a few dozen recipients a second would keep a database core busy. pg_stat_statements ranks it first by total time.

   **Fixed (2026-11-24).** The statement now turns the addresses into account ids first, `accounts_email_unique` for primaries `UNION` the `authd.aliases` primary key for aliases, then reads each account by `accounts_pkey` and probes `managed_accounts_pkey` per account found. It returns the same accounts: the Go DB tests in `services/authd/internal/projection/postgres_test.go` compare it with the old statement on a random fixture. Measured with `cli.ts measure --only authd.` on the same `large` seed (seed 1), main's code first and then the fix, warm, through PgBouncer as `authd`:

   | Case                          | p50 before | p50 after | p95 before | p95 after | Buffers before (hit + read) | Buffers after |
   | ----------------------------- | ---------- | --------- | ---------- | --------- | --------------------------- | ------------- |
   | 1 address (huge tenant login) | 300.7 ms   | 1.94 ms   | 370.3 ms   | 3.50 ms   | 7,503                       | 38            |
   | 1 missing address             | 245.3 ms   | 1.35 ms   | 257.8 ms   | 1.90 ms   | 6,936                       | 6             |
   | 50 addresses (50 recipients)  | 508.6 ms   | 13.3 ms   | 528.5 ms   | 19.0 ms   | 343,914                     | 1,301         |

   About half of what is left is `core.mailbox_domain_refused`, called once per account returned (finding 2): 0.56 ms of 1.0 ms for one address and 7.5 ms of 14.3 ms for 50, measured by EXPLAIN with the call replaced by a constant. The rest of the statement no longer grows with the number of mailboxes. The SSO columns still read `authd.required_domains` and `authd.required_exempt` whole once per statement when many accounts come back (a hashed SubPlan, 34 buffers today), which grows with SSO-required domains, not mailboxes.

2. **`core.mailbox_domain_refused` scans `core.domains` three times a call.** It goes through `core.mailbox_domain_settings` and `core.name_holders`, about 8 to 13 ms a call at 30,000 domains. It is the entire cost of `authd.account_by_uid` (8.2 ms p50 for a real account against 0.74 ms for a missing one), and it runs once per row wherever a list carries it. The console Mailboxes page (`consoleMailboxStore.list`) calls it 52 times for a page of 50, taking 458 ms p50. The mail domain reconcile (`mailbox_domain_settings()`) takes 18.6 ms. This is the class section 9 of mail-device-binding.md found, now measured on every path that reaches it.
3. **The console home page reads a month of events for the huge tenant.** `console.overview` calls `core.message_stats`, which reads about 1,017,000 rows of `core.message_events` (a seq scan of the 1.56 million row November partition, with the rest discarded by the filter) for the 30-day chart, then sorts. It takes 366 ms p50 and 806 ms p95, and touches 231 MB. The median tenant takes 0.46 ms. The cost grows with the tenant's own volume, so the largest customer gets the slowest home page.
4. **The send path sums a month of usage on every send.** `send.metering_used_in` (`usedInStatement`, apps/api/src/metering/postgres.ts) takes 22.9 ms p50 for the huge tenant's month window and touches 12,644 buffers (99 MB). The median tenant's day window takes 0.47 ms. Every accepted send pays it, and it grows linearly with the tenant's monthly volume. A tenant sending a million emails a month would read a million rows per send.
5. **The hourly retention scan reads every message partition.** `scheduled.retention_due` (`core.retention_due`) takes 680 ms p50 and touches 254,069 buffers (1.98 GB). It seq scans `core.plan_assignments` and runs a nested loop over 12,757 tenants. It runs hourly, so this is cost, not latency, but it grows with tenants times retained months.
6. **Lookups by message id probe every partition.** `api.get_email`, `console.email_detail`, `worker.claim`, the list queries' second statement and `console.count_shapes` name `id` without `created_at`, so the plan has an index probe per monthly partition (13 to 19 today, including 11 empty future months and the default). It costs 1 to 2.6 ms now. The cost grows with the months kept, not with rows. `webhooks.message_owner` avoids this by bounding `created_at` from the uuidv7 timestamp, which shows the fix is known.
7. **Filtering the email list by API key discards rows.** `console.list_emails` with an API key and a 7-day window takes 12 ms p50 and 17.4 ms p95, and discards 56,140 rows of the November partition: no index leads with `api_key_id`. The search case is 2.5 ms p50 but 11.5 ms p95.
8. **Case-sensitive comparisons that only work because every writer lowercases (latent bugs, found at low volume by the fixtures).** All three are correct today: `domains/store.ts:414`, `suppressions/store.ts:135`, `webhooks/events.ts:217` and `mailboxes/aliases.ts:164` lowercase before writing. No constraint enforces it, though, and a single row with capitals breaks the feature silently:
   - `send.sendable_from` compares `core.domains.name` to a lowercased name, so a verified `MixedCase.Example` is not sendable.
   - `send.suppressed_for` compares `core.suppressions.address` byte for byte, so a suppression stored as `Bob@Example.test` does not stop mail to `bob@example.test`. That means mail to an address that bounced or complained, which is reputation damage.
   - `authd.accounts_by_address` compares `authd.aliases.address` byte for byte with the lowercased login, so an alias stored as `Sales@...` receives nothing.
   - `authd.groups_by_address` does the opposite: it wraps the column in `lower()` and so works, at the cost of an index it cannot use (1,198 groups today).
9. **Webhook fan-out does one foreign-key check per endpoint.** `webhooks.record_event` inserts one delivery per subscribed endpoint, and each insert runs an FK lookup on `core.webhook_endpoints`: 133 for the huge tenant's single event, 25.6 ms p50 for that insert. The endpoint `UPDATE` relies on RLS for its tenant filter and uses `webhook_endpoints_tenant_idx`. Low risk unless one workspace has hundreds of endpoints.
10. **Indexes.** `core.domains_tenant_idx` is redundant: its column leads `domains_tenant_name_unique`. No registry query used the three secondary indexes on `core.webhook_attempts` (678 MB, 662 MB and 608 MB at 10 million attempts) or `webhook_deliveries_endpoint_idx` (471 MB). Their write cost lands on the two largest tables. Check them against the non-hot queries (history, replay, stats) before anything else.
11. **What is fine at this scale.** API key resolution (0.44 ms), the send gate's suppression and domain checks (under 0.6 ms for 50 recipients), `send.persist` (0.5 ms for a batch of 100), the delivery sweep (1.4 ms for 500 due), the message owner lookup (0.7 ms), the console list's first page (1.4 ms for the huge tenant), and every authd group query (under 4 ms).

Plans that change with the case (see "Plan stability" in the report): `authd.accounts_by_address`, `authd.groups_for_member`, `send.metering_used_in`, `worker.claim` and `send.persist` each have two shapes. The shape follows the size of the answer, as expected, and neither shape is a risk the findings above do not already cover.

## What was built and where

The code is in `apps/api/scripts/scale/`, and the tests are in `apps/api/test/scale-*.test.ts`. They live inside the API package for three reasons. The registry has to call the API's real store functions and statement builders, so it imports `apps/api/src`. It needs the API's own `drizzle-orm` and `postgres`. And the package's `tsconfig.json` and lint already cover `scripts/**`, so CI type-checks and lints the harness with no new workspace and no lockfile change. `tools/` would have been outside the workspaces and outside turbo, so nothing would check it.

| File                            | Role                                                                                                     |
| ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `cli.ts`                        | `up`, `reset`, `seed`, `measure`, `stats-roundtrip`, `down`                                              |
| `scratch.ts`                    | The docker Postgres and PgBouncer, migrated by the production runner (`src/migrate-run.ts`)              |
| `profiles.ts`                   | `small` and `large`, with the assumption behind every number                                             |
| `rng.ts`, `values.ts`           | Deterministic randomness, Zipf weights, and values with real-world variety                               |
| `seed-world.ts`                 | Tenants, members, domains, mailboxes, SSO, keys, plans, webhook endpoints                                |
| `seed-mail.ts`                  | Messages, bodies, events, deliveries, attempts, metering, request log, suppressions, contacts, templates |
| `fixtures.ts`                   | Hand-written rows, one risk each                                                                         |
| `bulk.ts`                       | Batched inserts through `json_populate_recordset`                                                        |
| `registry.ts`, `pickers.ts`     | The hot queries and their parameter pickers                                                              |
| `capture.ts`, `go-sql.ts`       | Recording the SQL a real code path sends; reading authd's SQL from its Go source                         |
| `measure.ts`, `plan.ts`         | EXPLAIN, timing, plan rules, index facts                                                                 |
| `report.ts`                     | The markdown report                                                                                      |
| `chaos.ts`, `chaos-coverage.ts` | Schema-derived candidate generation and registry primary-key coverage                                    |
| `stats.ts`, `scrub.ts`          | Statistics export, scrub, load, pad, round trip                                                          |

## How to run it

From `apps/api`, with docker running and `pg_dump` 18 on PATH (`PG_DUMP` overrides it):

```sh
bun scripts/scale/cli.ts up
bun scripts/scale/cli.ts seed --profile large --seed 1
bun scripts/scale/cli.ts measure
bun scripts/scale/cli.ts seed --scratch dev --profile small --seed 7 --chaos
bun scripts/scale/cli.ts coverage --scratch dev --seed 7
bun scripts/scale/cli.ts stats-roundtrip
bun scripts/scale/cli.ts down
```

- `up` starts `dbscale-main-pg` on 127.0.0.1:55491 and `dbscale-main-pooler` on 55492 (`DB_SCALE_PORT` moves both), creates the database `i10` owned by a plain, non-superuser `i10` role (as production has it; `postgres` is the bootstrap superuser and only sets the server up and pads the stats twin), creates the five roles the migrations grant to (`authd`, `i10_api`, `pdns`, `stalwart`, `mailfront`), creates `vector` and `pg_stat_statements` as CNPG would, applies every migration, and keeps a migrated template. `reset` restores the empty migrated database from that template in about a second. `--scratch dev` makes a second, independent pair on 55511 and 55512.
- `seed` refuses a database that already has a workspace, and any host but loopback. `--anchor` fixes "now" for the data; it defaults to the start of the current hour. `--no-fixtures` leaves the fixtures out.
- `seed --chaos` runs deterministic edge cases for every eligible column in the registry tables and writes the full candidate corpus to `/tmp/db-scale-chaos-<seed>.json`. It reads types, nullability, CHECKs, foreign keys, primary keys, and partition bounds from the migrated catalog. Values for a table-column pair go on distinct rows, preferring rows used by the registry pickers: huge and median tenants, SSO tenant, fixture tenants, and authd lookup values. Remaining rows use deterministic offsets. Rejected updates roll back to savepoints. With the flag off, normal seed rows remain byte-for-byte unchanged. The 2026-11-23 small run generated 1,550 candidates, recorded 1,271 database rejections, and skipped 4,238 candidates with no source row or no unused source row. Its corpus is not kept in this directory; see the report for category counts, protected columns, and findings.
- `coverage --scratch dev --seed 7` runs every case in the registry against that chaos seed and counts returned chaos primary keys. Its JSON detail goes to `/tmp/db-scale-chaos-coverage-<seed>.json`. The report lists entries and cases with no returned chaos keys as uncovered by row identity, even though the code path ran. To regenerate the chaos run: `up --scratch dev`, seed the `small` profile with seed `7` and anchor `2026-11-20T12:00:00Z` first without `--chaos` for a control, run measurement, reset the dev scratch, reseed with `--chaos`, then run `coverage` and `measure`; finish with `down --scratch dev`. The report records the exact commands and outputs.
- `measure` takes `--runs` (default 30), `--only <prefix>` (for example `--only authd.`) and `--out <dir>`.
- `stats-roundtrip` starts `dbscale-stats-pg` on 55501 (no pooler, autovacuum off), then exports, scrubs, loads, pads and compares.
- `stats-export --source <url> --out <file>` writes the scrubbed statistics of any database to a file. It is read-only on the source (`pg_dump` and two catalog queries). The raw dump never touches disk, and nothing is written if a value survived the scrub. `stats-load --in <file>` starts a fresh twin on 55501 and loads and pads the file into it. These two are the pieces CI will run against production's statistics; on 2026-11-22 they were run against the seeded scratch only.

The end-to-end run on 2026-11-22, from `down` to the round trip on a fresh scratch, took 1,497 s on an 8-core laptop: 1,296 s to seed `large`, 107 s to measure, and 86 s for the round trip.

The tests: `bun test test/scale-scrub.test.ts test/scale-plan.test.ts` needs no database. `DB_SCALE_TEST_PORT=55511 bun test test/scale-generator-db.test.ts` needs a scratch from `cli.ts up --scratch dev`, resets it twice, and skips without the variable, like the other `-db` tests.

## The scratch database, against production

The scratch matches production in these ways:

- The image is `ghcr.io/cloudnative-pg/postgresql:18.6-standard-bookworm` (infra/k8s/i10/platform-db/cluster.yaml).
- The container has a 1 GiB memory limit and default `shared_buffers` (128 MB), so the large tables do not fit in cache, as they will not in production.
- `full_page_writes` is off and the locale is C (CNPG's default).
- The `vector` extension comes from database.yaml.
- PgBouncer runs from CNPG's image (1.25.1), with `pool_mode = transaction`, `default_pool_size = 20` and `max_client_conn = 200` (pooler.yaml).

It differs in these ways: `pg_stat_statements` and `auto_explain` are preloaded and `track_io_timing` is on, because the measurement needs them, and authentication is `trust` on loopback.

## What the numbers mean

- **p50, p95, max** are client-side round trips in milliseconds through PgBouncer, as the application role (`i10_api` or `authd`, so RLS applies). Each comes from 30 executions after one warm-up; a statement slower than 200 ms gets 10 runs, slower than 2 s gets 3. Each execution is its own transaction, rolled back, so writes write nothing. The cache is warm, so these are best cases for latency. `shared_read` in the CSV shows what a cold cache would add. `cli.ts` has no cold-cache mode yet; `restart` in scratch.ts is the hook for one.
- **The statements** are what the real code path sent. Each registry entry calls the application's own function: a store method, a statement builder, or for authd the SQL text read out of `postgres.go`. Drizzle's client is one reserved connection inside a transaction that is always rolled back, and `db.transaction` and `withTenant` become savepoints inside it, so the code runs unchanged and writes nothing. Two entries (`mail.domain_settings`, `scheduled.retention_due`) are one-line SQL function calls inside CronJob mains that export nothing callable. They are copied with their call site and marked `call-text`.
- **Statement replay.** Before measuring statement N of a path, the statements before it that set context or write are replayed in the same transaction, so each statement sees the state the path gave it.
- **Inside functions.** `EXPLAIN` shows a call of a SQL or `SECURITY DEFINER` function as one node. auto_explain is switched on for the EXPLAIN's transaction only (`log_nested_statements`, `log_analyze`, `log_buffers`), so every statement inside a function is planned too. "Called 52x" means it ran 52 times for one outer statement.
- **Flags** (plan.ts): a seq scan of a table over 10,000 rows; 10,000 or more rows read and discarded by a filter; a SubPlan run 100 times or more; a nested loop whose inner side ran 1,000 times or more; a sort or hash that spilled to disk; a node whose actual rows are 100 times its estimate; an Append over more than 6 partitions; 10,000 or more buffers touched. A flag is a property that grows with data. It is not a verdict. A seq scan under a `LIMIT` that stops at the first row is cheap, which is why `console.count_shapes` is flagged at 1.8 ms.
- **Wrong answers** come from cases with an `expect`: a fixture whose correct result is known.
- **Plan stability** counts the distinct plan shapes per statement across an entry's cases. Partition names are folded, so a plan over different months is one shape.
- **Unused indexes** are those with `idx_scan = 0` after the run (statistics are reset at its start). The registry covers hot paths, not every query, so this list is for checking, not for dropping.

## The `large` profile and its assumptions

The profile represents a successful first year: 20,000 workspaces, most of them free and idle, one very large customer, and six months of mail from a few hundred paying senders. Activity per workspace follows a Zipf curve (s = 1.05). Workspace 0 is the huge one and also takes 25% of all mail, like a marketplace sending its users' notifications. Most other tables spread with a flatter power of the same weights.

| Table                                      | Rows            | Assumption                                                                                                                                                                                                            |
| ------------------------------------------ | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core.tenants`                             | 20,008          | 40% personal (no organization), 96% active, 2% suspended, 2% deleted                                                                                                                                                  |
| `core.workspace_roles`                     | 60,009          | 3 members on average, thousands in the huge one; 10% of seats are people in several workspaces                                                                                                                        |
| `core.domains`                             | 30,005          | 60% verified, 15% pending, 10% not started, 10% failed, 5% temporary failure; 3% of unverified names are claimed by a second workspace; 1% stored with capitals                                                       |
| `authd.accounts`                           | 300,002         | 15 mailboxes a workspace on average, about 40,000 in the huge one, 5,000 on i10.tech with no tenant; 8% inactive, 1% suspended, 1% on payment hold, 0.5% deleting, a few banned or locked                             |
| `authd.aliases`                            | 236,037         | 40% of mailboxes have 1 to 3, from Clerk, a directory or the console                                                                                                                                                  |
| `identity.connections`                     | 703             | 600 workspaces with SSO; 70% active; half of the enforcement settings require it                                                                                                                                      |
| `identity.managed_accounts`                | 40,222          | A third of an active connection's mailboxes                                                                                                                                                                           |
| `core.api_keys`                            | 39,301          | 20% revoked, 5% expiring, 20% scoped to a domain                                                                                                                                                                      |
| `core.messages`                            | 3,000,002       | 500,000 a month, three times as many in the last month as in the first; daily cycle, quieter weekends, 8 campaign bursts; 95.5% sent, 3% failed, 1% canceled, the rest queued or sending; 15% with 2 to 50 recipients |
| `core.message_bodies`                      | 3,000,000       | One per message; older than 30 days marked compacted                                                                                                                                                                  |
| `core.message_events`                      | 9,591,172       | Queued, sent, then delivered 95%, bounced 2.5%, complained 0.2%; 25% opened, a quarter of those clicked                                                                                                               |
| `core.webhook_endpoints`                   | 14,724          | 92% HTTP, 5% polling, 3% SQS; 7% failing, 3% disabled; 20% ordered                                                                                                                                                    |
| `core.webhook_deliveries`                  | 7,029,450       | One per event for a workspace's first endpoint, and for its second on 30% of events; 95% delivered, 3% failed, 2% pending                                                                                             |
| `core.webhook_attempts`                    | 10,017,076      | One per attempt, derived from the deliveries in SQL                                                                                                                                                                   |
| `core.api_requests`                        | 3,252,489       | One POST per API send, plus a GET for 30% of them                                                                                                                                                                     |
| `core.meter_events`                        | 2,878,705       | One per sent message; the last 5 minutes not yet shipped                                                                                                                                                              |
| `core.suppressions`                        | 300,001         | From bounces and complaints, then imports and unsubscribes, half in the huge workspace                                                                                                                                |
| `core.contacts`                            | 1,000,002       | 30% in the huge workspace; 10% stored with the capitals people typed                                                                                                                                                  |
| `core.templates`, `core.template_versions` | 50,000, 124,497 | 1 to 4 versions each                                                                                                                                                                                                  |
| `core.identity_events`                     | 500,000         | Sign-in history over the 180 days                                                                                                                                                                                     |

Variety lives in `values.ts`: Arabic and Hebrew (right to left), CJK, Cyrillic, Greek, Thai, combining marks that are not NFC, emoji and ZWJ sequences, a bidi override, very long names and subjects, look-alike and punycode domains, 63-character labels, plus-addressing, and the empty string where a column allows it. Timestamps cover six months with growth and bursts, and every id is version 7 from its row's time where production's default is `uuidv7()`, so physical order follows time as it does after real inserts.

`small` has the same shapes and states at 60 workspaces and 4,000 messages, and seeds in about two seconds.

**The fixtures** (`fixtures.ts`) are loaded on top of any profile, and each one is checked to be present after loading:

- an empty workspace
- a verified mail domain stored as `MixedCase.Example`, with a mailbox, an alias and a team inbox address stored with capitals
- a second workspace claiming the same name
- contacts that differ only in case
- a suppression stored with capitals
- RTL and emoji names
- a deleted workspace that still has mail
- a suspended workspace with a live key
- a mailbox with every gate set at once on an SSO-required domain, exempt from it
- the longest legal addresses with 50 recipients and a 998-character subject
- a key that is both revoked and expired
- a polling endpoint, and a message scheduled a year out

**What the generator guarantees** (tested in `scale-generator-db.test.ts`):

- **Determinism.** The same seed and anchor give byte-identical tables, except the columns filled by volatile defaults the generator does not set. The two `large` runs of 2026-11-22 gave identical row counts.
- **Validity.** Every row went through every constraint, foreign key and trigger, because the seed inserts with them enabled.
- **States.** Every lifecycle state is present.
- **Skew.** The top tenant has more than 10 times the median tenant's mail.
- **Variety.** Each kind of variety above is present.
- **Invariants.** Mailbox addresses are lowercase, no message uses another tenant's domain, and no name is verified twice.

## Production statistics, scrubbed

`stats-roundtrip` runs the whole pipeline that CI will later run against production's statistics.

1. **Export.** `pg_dump --statistics-only --schema core --schema identity --schema authd` (PostgreSQL 18), which produces `pg_restore_relation_stats` and `pg_restore_attribute_stats` calls.
2. **Scrub** (`scrub.ts`). `most_common_vals`, `histogram_bounds` and `most_common_elems` hold real values: the email histogram is email addresses. The scrubber collects every original value of a kind across the whole dump, sorts them, and gives value i of N a generated value i of N with the same byte length. Histograms stay sorted, counts and frequencies stay exact, and the same tenant id stays one id in every table, which keeps join estimates honest. The mapping exists only in memory, where the round trip uses it to translate its query parameters. Numbers, times, booleans and enum labels are kept. So are text columns whose CHECK constraint fixes their vocabulary, because those words are schema, and SQL compares them as literals. Value lists of other types (jsonb, inet, bytea, pgvector, ranges) are dropped, with their frequencies; 36 columns on this run.
3. **Load** into an empty, migrated twin that has the source's monthly partitions.
4. **Pad.** Restored statistics alone do not reproduce a plan. The planner takes a heap's and an index's size from the file, not from `pg_class.relpages` (`table_block_relation_estimate_size`). An empty twin is estimated at 0 rows whatever `reltuples` says: a probe on 2026-11-21 planned `rows=1` for a 200,000-row table's twin. So every table and index file is extended to its restored `relpages` with a sparse `truncate -s`, splitting at 1 GB segments. Postgres reads a never-initialised page as empty, the files use almost no disk (16.6 GiB of sparse files took 114 MB on the twin, schema and statistics included), and the planner sees the source's sizes. The twin runs with autovacuum off and holds no rows.
5. **Compare.** Every registry statement is planned (plain `EXPLAIN`) on the source and on the twin, with parameters translated by the mapping.

The result on `large`: **145 of 147 statements plan the same on the twin, against 52 of 147 with statistics alone**, and **0 of 44,190 original values survive in the scrubbed statistics**. The leak test checks every value list for every original, whole or as a substring of six characters or more, and the scrub test proves it catches one. The two differences are a merge join where the twin picks a nested loop (`authd.accounts_by_address` with 50 addresses, same row estimate) and an index-only scan where the twin picks a seq scan under a `LIMIT 1` (`console.count_shapes`). Details are in [stats-roundtrip-2026-11-22.md](stats-roundtrip-2026-11-22.md).

**Limits:**

- **Extended statistics are not dumped** by PostgreSQL 18's `pg_dump`. The schema defines none today (`pg_statistic_ext` is empty), but any later `CREATE STATISTICS` will not reach the twin.
- **A padded index looks empty to the parts of the planner that read the index itself.** Its btree metapage says height 0, so index descents cost slightly less than on the source. `get_actual_variable_range` (used for range conditions near a histogram's ends) finds no rows, so estimates there can differ. This is the likely cause of the two differences above.
- **Only parameters are translated.** A real value written as a literal in SQL text is not mapped. In CI, the pickers should take their values from the scrubbed statistics (the most common tenant id is the huge tenant) instead.
- **Generated values keep order, not distribution.** A range condition on scrubbed text or uuid columns is estimated against evenly spread values.
- **Sorted order assumes C collation**, which is CNPG's default. The export does not check it yet.
- **A twin is for planning only.** It must never be written to, vacuumed or analyzed, or the padding and the restored statistics are gone. `n_live_tup` and the other cumulative statistics are not part of the dump; the planner does not read them.

## What is not covered, and why

- **The mail front's sweep** (section 9 of mail-device-binding.md) is not on main. Its query and `sweep-seed.sql` exist only on an unmerged branch, so it is not in the registry. `core.mailbox_domain_refused`, the part that dominated it, is measured here through authd and the console.
- **PowerDNS** answers every DNS query from `pdns.records` with its own SQL (gpgsql), which is not i10's code. It is not in the registry, and `pdns.*` is not seeded.
- **Stalwart's own database** (the `stalwart` database) is not in scope.
- **Paths whose SQL needs an external service in the loop**: domain proof and recheck (SES, DNS), risk scoring (the model), the content store jobs (R2), billing webhooks (Polar), SCIM and directory syncs, and the SSO sign-in flow. Their scheduled `*_due` functions are the next registry entries to add. `webhook_deliveries_due`, `webhook_health_unfanned`, `retention_due`, `unshipped_meter_events`, `mailbox_jobs_lost` and the stuck-message sweep are in.
- **Concurrency.** One client at a time. Lock waits, PgBouncer pool saturation, and write amplification under sustained load are not measured.
- **Cold cache.** Times are warm; see "What the numbers mean".
- **`worker.claim` won no rows** in the large run. The queued messages the picker found were not yet due, so the claim measured its plan with zero rows won.
- **The CI gate.** Deliberately not built. The registry, the plan rules and these numbers are what it will be built from.
