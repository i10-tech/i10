/**
 * Applies pending Drizzle migrations, then exits.
 *
 * Run as an Argo CD PreSync hook rather than on API startup. Migrating on boot
 * is simpler right up to the moment there are two replicas, at which point both
 * race for the same schema lock and one of them crash-loops. A PreSync hook runs
 * exactly once per sync, before any new pod starts, which is the ordering a
 * schema change actually needs.
 *
 * ⚠ THIS USES THE PRIMARY, NOT THE POOLER. Migrations run DDL inside a
 * transaction and take advisory locks; PgBouncer in transaction pooling mode can
 * hand consecutive statements to different backends, which breaks both. The
 * application connects through the pooler — this does not.
 */
import { drizzle } from "drizzle-orm/postgres-js"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import postgres from "postgres"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL
if (!url) {
  console.error("MIGRATE_DATABASE_URL (or DATABASE_URL) is required")
  process.exit(1)
}

// `max: 1` because a migration is a single serial conversation with the
// database; a pool would let drizzle take the lock on one connection and run
// statements on another.
const sql = postgres(url, { max: 1, prepare: false, connect_timeout: 15 })

// dist/migrate.js -> ../drizzle, which the Dockerfile copies alongside dist.
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle")

/**
 * ⚠ WAIT FOR THE DATABASE TO BE DIALABLE BEFORE MIGRATING, AND DO NOT REMOVE
 * THIS BECAUSE "the database is obviously up".
 *
 * A brand-new pod's FIRST outbound connection to a ClusterIP is refused while
 * kube-proxy and the CNI finish programming rules for it. postgres.js connects
 * LAZILY — the socket is opened by the first query — and it makes exactly one
 * attempt with no retry. So a refusal in that window surfaced as
 *
 *   migration failed: Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"
 *
 * which reads like a permissions problem against the first statement drizzle's
 * migrator runs, and sent us looking at GRANTs. Postgres never saw the packet:
 * there was no server-side error to find.
 *
 * ⚠ AND IT ONLY STARTED FAILING WHEN THE IMAGE GOT FASTER. Under Node the
 * process spent long enough loading files off disk that the window had closed
 * by the time it dialled; the bundled bun image starts in milliseconds and
 * lands inside it. The race was always there — nothing about it was introduced
 * by bun, and going back to a slower runtime would hide it rather than fix it.
 * Every attempt is a NEW pod, so `backoffLimit` does not help: each retry gets
 * its own fresh, unready network. The retry has to be in here.
 */
const CONNECT_ATTEMPTS = 10
const CONNECT_DELAY_MS = 1_000

async function waitForDatabase() {
  for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt++) {
    try {
      await sql`select 1`
      if (attempt > 1) console.log(`database reachable after ${attempt} attempts`)
      return
    } catch (err) {
      if (attempt === CONNECT_ATTEMPTS) throw err
      console.log(
        `database not reachable yet (attempt ${attempt}/${CONNECT_ATTEMPTS}): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      )
      await new Promise((resolve) => setTimeout(resolve, CONNECT_DELAY_MS))
    }
  }
}

/**
 * ⚠ THE WHOLE CHAIN, NOT `err.message`. drizzle wraps a driver error as
 * `Failed query: <sql>` and hangs the real one off `cause`, so printing only
 * the message reports the statement and discards the reason — the difference
 * between "ECONNREFUSED" and a silent wall. A migration that fails invisibly is
 * the worst outcome this file has.
 */
function describe(err: unknown): string {
  const parts: string[] = []
  let current: unknown = err
  for (let depth = 0; current && depth < 5; depth++) {
    if (current instanceof Error) {
      const code = (current as { code?: string }).code
      parts.push(`${current.message}${code ? ` [${code}]` : ""}`)
      current = current.cause
    } else {
      parts.push(String(current))
      break
    }
  }
  return parts.join("\n  caused by: ")
}

try {
  await waitForDatabase()
  console.log(`applying migrations from ${migrationsFolder}`)
  await migrate(drizzle(sql), { migrationsFolder })
  console.log("migrations applied")
} catch (err) {
  console.error("migration failed:", describe(err))
  process.exitCode = 1
} finally {
  await sql.end({ timeout: 5 })
}
