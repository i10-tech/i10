/**
 * Records the SQL a real code path sends, without letting it write anything.
 *
 * The path runs against a Drizzle database whose client is one reserved
 * connection inside an outer transaction that is always rolled back. The
 * driver's `begin` and `savepoint` (what `db.transaction` and `withTenant` call)
 * become savepoints inside it, so the code runs unchanged, its own transactions
 * included, and every statement it sends through `unsafe` (all Drizzle traffic)
 * is recorded with its parameters. This is how the registry gets "the SQL as it
 * runs" rather than a retyped copy.
 */
import { drizzle } from "drizzle-orm/postgres-js"
import postgres, { type ReservedSql, type Sql } from "postgres"
import type { Database } from "../../src/db/client.js"

export type StatementKind = "context" | "read" | "write"

export interface Statement {
  sql: string
  params: unknown[]
  /** The `app.tenant_id` in force when it ran, for RLS on replay. */
  tenant: string | null
  kind: StatementKind
}

export interface Captured {
  statements: Statement[]
  /** What the code path returned, for a case's `expect`. */
  result: unknown
  error: string | null
}

const TENANT_SET = /set_config\(\s*'app\.tenant_id'/i

/** Write: DML, or a call to a function the database marks volatile. */
export function classify(sql: string, volatile: ReadonlySet<string>): StatementKind {
  if (TENANT_SET.test(sql)) return "context"
  const s = sql.trim().toLowerCase()
  if (/^(insert|update|delete|merge)\b/.test(s)) return "write"
  if (/^with\b/.test(s) && /\b(insert|update|delete)\b/.test(s)) return "write"
  for (const m of s.matchAll(/\b(core|identity|authd)\.([a-z_]+)\s*\(/g)) {
    if (volatile.has(`${m[1]}.${m[2]}`)) return "write"
  }
  if (/\bfor (update|no key update|share)\b/.test(s)) return "write"
  return "read"
}

export interface CaptureContext {
  db: Database
  /** For paths that speak plain SQL (the Go queries, raw postgres.js callers). */
  query: (text: string, params?: unknown[]) => Promise<unknown[]>
}

export async function capture(
  url: string,
  volatile: ReadonlySet<string>,
  fn: (ctx: CaptureContext) => Promise<unknown>,
): Promise<Captured> {
  const sql: Sql = postgres(url, {
    max: 1,
    prepare: false,
    onnotice: () => {},
    connect_timeout: 10,
  })
  const reserved: ReservedSql = await sql.reserve()
  const statements: Statement[] = []
  let tenant: string | null = null
  let depth = 0

  const record = (text: string, params: unknown[]) => {
    const kind = classify(text, volatile)
    if (kind === "context") tenant = String(params[0])
    statements.push({ sql: text, params, tenant, kind })
  }

  const savepoint = async (cb: (c: unknown) => Promise<unknown>) => {
    const name = `capture_${++depth}`
    await reserved.unsafe(`savepoint ${name}`)
    try {
      const out = await cb(client)
      await reserved.unsafe(`release savepoint ${name}`)
      return out
    } catch (err) {
      await reserved.unsafe(`rollback to savepoint ${name}`)
      throw err
    }
  }

  const client: ReservedSql = new Proxy(reserved, {
    get(target, prop, receiver) {
      if (prop === "unsafe") {
        return (text: string, params: unknown[] = [], opts?: object) => {
          record(text, params)
          return target.unsafe(text, params as never[], opts)
        }
      }
      if (prop === "begin" || prop === "savepoint") return savepoint
      // Drizzle installs its type parsers on `client.options`, which a reserved
      // connection does not carry; the pool's is the object it would mutate.
      if (prop === "options") return sql.options
      return Reflect.get(target, prop, receiver)
    },
  })

  await reserved.unsafe("begin")
  let error: string | null = null
  let result: unknown = undefined
  try {
    result = await fn({
      db: drizzle({ client }) as unknown as Database,
      query: async (text, params = []) => [
        ...(await client.unsafe(text, params as never[])),
      ],
    })
  } catch (err) {
    // A path that fails still sent what it sent; the report says it failed.
    error = err instanceof Error ? err.message : String(err)
  } finally {
    await reserved.unsafe("rollback").catch(() => {})
    reserved.release()
    await sql.end({ timeout: 2 })
  }
  return { statements, result, error }
}
