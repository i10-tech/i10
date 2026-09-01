import { sql } from "drizzle-orm"
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
 */
export async function assertRlsSubject(sql_: Sql): Promise<void> {
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
