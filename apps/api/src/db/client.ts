import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
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
