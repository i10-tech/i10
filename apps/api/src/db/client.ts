import { sql, type SQL } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres, { type Sql } from "postgres"
import * as schema from "./schema.js"

export type Database = ReturnType<typeof createDb>["db"]

/**
 * Opens the pool against CNPG, through PgBouncer.
 *
 * ⚠ `prepare: false` IS REQUIRED, NOT A TUNING KNOB. PgBouncer runs in
 * transaction pooling mode, where consecutive statements can land on different
 * backends. Server-side prepared statements do not survive that, and the
 * failure is not at startup — it is an intermittent "prepared statement does
 * not exist" under load, which looks like a database fault rather than a client
 * misconfiguration.
 *
 * The same property is why every statement must be schema-qualified: PgBouncer
 * accepts `SET search_path` and silently drops it.
 */
export function createDb(url: string) {
  const sql = postgres(url, {
    prepare: false,
    max: 10,
    idle_timeout: 30,
    connect_timeout: 10,
    // Errors carry the failing statement. That statement can contain a user's
    // address, so keep it out of logs by default.
    onnotice: () => {},
  })

  return { sql, db: drizzle(sql, { schema }) }
}

/**
 * Runs `fn` inside a transaction that carries the tenant's identity, which is
 * what every row level security policy in `core` reads.
 *
 * ⚠ `set_config(..., true)`, NOT `SET LOCAL`. `SET LOCAL app.tenant_id = $1` is
 * not valid — SET takes no bind parameters, and building the statement by
 * interpolation would put a caller-influenced value into SQL text. `set_config`
 * is the function form and takes the value as a parameter; its third argument
 * is `is_local`, which scopes it to this transaction.
 *
 * ⚠ THE TRANSACTION IS NOT OPTIONAL, FOR A REASON THAT IS NOT ISOLATION.
 * PgBouncer pools by transaction: outside one, the next statement can land on a
 * different backend that never saw the setting. A non-local `set_config` would
 * be worse than useless — it would leak one tenant's id onto a pooled
 * connection that the next request picks up, and the leak would look like
 * working software.
 */
/**
 * A timestamp parameter, serialised the only way the driver accepts.
 *
 * ⚠ THIS EXISTS BECAUSE THE SAME MISTAKE HAS SHIPPED THREE TIMES. postgres.js
 * binds a parameter by writing its bytes, and a `Date` is not a string, so
 * `sql\`... > ${'${someDate}'}\`` throws `ERR_INVALID_ARG_TYPE` from inside the driver
 * before the query is ever sent:
 *
 *   The "string" argument must be of type string or an instance of Buffer or
 *   ArrayBuffer. Received an instance of Date
 *
 * ⚠ AND IT FAILS AT RUN TIME, NOT AT COMPILE TIME, WHICH IS THE WHOLE PROBLEM.
 * A `Date` is a perfectly good template value as far as TypeScript is
 * concerned, so nothing catches it until the query runs — and each of the
 * three occurrences was found by a customer rather than by us. It stopped
 * usage reconciliation completing, then it made every metering read fall back
 * silently for weeks, then it 500'd the console's overview page.
 *
 * ⚠ THE CAST IS PART OF IT, NOT DECORATION. Without `::timestamptz` the bound
 * value is `text` and Postgres compares it as a string, which is wrong in
 * exactly the cases that matter — a different offset, or a different number of
 * fractional digits, orders incorrectly.
 */
export const ts = (value: Date): SQL => sql`${value.toISOString()}::timestamptz`

export async function withTenant<T>(
  db: Database,
  tenantId: string,
  fn: (tx: Parameters<Parameters<Database["transaction"]>[0]>[0]) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`)
    return fn(tx)
  })
}

/**
 * Waits until the database can actually be dialled.
 *
 * ⚠ A NEW POD'S FIRST CONNECTION TO A ClusterIP IS REFUSED while kube-proxy and
 * the CNI finish programming rules for it, and postgres.js makes exactly one
 * attempt. So a process that starts fast enough — every bun-built image here —
 * dies with `ECONNREFUSED` on a database that is perfectly healthy, and
 * Postgres logs nothing because the packet never arrived.
 *
 * ⚠ IT COST THE DOMAIN PROVER ITS RUNS. `domain-prove` starts a fresh pod every
 * minute, and the runs that lost this race exited at "refusing to start"
 * before selecting a single domain — which is how a freshly published domain
 * could sit unregistered for minutes with a sweep scheduled every sixty
 * seconds. `recheck`, `catch-up` and the reconciler failed the same way.
 * `migrate.ts` has had this fix since the bun move; nothing else did.
 *
 * ⚠ `backoffLimit` CANNOT DO THIS. Each Job retry is a new pod with its own
 * fresh, unready network. The wait has to be inside the process.
 *
 * ⚠ AND ONLY TRANSPORT FAILURES ARE RETRIED. A wrong password or a missing
 * database is a configuration, and ten seconds of retrying it would only delay
 * the error that says so.
 */
const TRANSPORT = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "CONNECT_TIMEOUT",
])

export async function dialable(
  sql_: Sql,
  log?: { warn: (o: object, m: string) => void },
  { attempts = 10, delayMs = 1_000 }: { attempts?: number; delayMs?: number } = {},
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await sql_`select 1`
      return
    } catch (err) {
      const code = (err as { code?: unknown }).code
      if (typeof code !== "string" || !TRANSPORT.has(code) || attempt >= attempts) {
        throw err
      }
      log?.warn(
        { attempt, of: attempts, code },
        "database not reachable yet — a new pod's first connection is often refused",
      )
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
}

/**
 * Refuses to start if the connection would bypass row level security.
 *
 * ⚠ THIS EXISTS BECAUSE THE FAILURE IS SILENT. Policies do not apply to a
 * table's owner, to a superuser, or to a role with BYPASSRLS. Point
 * `DATABASE_URL` at the `i10` owner — a copied connection string, a Doppler key
 * edited in the wrong config — and every query keeps working, every test keeps
 * passing, and the tenant boundary is simply gone. There is no error to notice
 * and nothing in the log.
 *
 * A connection string is the easiest thing in the system to get wrong and the
 * only one whose mistake is invisible, so it is checked once, at boot, where a
 * failure stops the rollout instead of reaching a customer.
 *
 * ⚠ AND BECAUSE IT IS THE FIRST QUERY EVERY PROCESS MAKES, IT IS ALSO WHERE THE
 * FIRST CONNECTION HAPPENS — which is what makes it the place to wait for one.
 * See `dialable` above. The role check itself is never retried: a role that
 * bypasses RLS is a configuration, and it will be the same configuration in a
 * second.
 */
export async function assertRlsSubject(
  sql_: Sql,
  log?: { warn: (o: object, m: string) => void },
): Promise<void> {
  await dialable(sql_, log)

  const [row] = await sql_<
    { role: string; superuser: boolean; bypassrls: boolean; owned: number }[]
  >`
    select current_user                                     as role,
           coalesce(r.rolsuper, false)                      as superuser,
           coalesce(r.rolbypassrls, false)                  as bypassrls,
           (select count(*)::int
              from pg_class c
              join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'core'
               and c.relkind in ('r', 'p')
               and c.relowner = r.oid)                      as owned
      from pg_roles r
     where r.rolname = current_user
  `

  if (!row) throw new Error("Could not determine the connected role")

  const reasons = [
    row.superuser && "it is a superuser",
    row.bypassrls && "it has BYPASSRLS",
    row.owned > 0 && `it owns ${row.owned} table(s) in core`,
  ].filter(Boolean)

  if (reasons.length > 0) {
    throw new Error(
      `Refusing to start: the database role "${row.role}" bypasses row level ` +
        `security because ${reasons.join(", and ")}. Every tenant policy would ` +
        `be a no-op. Connect as the application role, not the schema owner.`,
    )
  }
}
