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

try {
  console.log(`applying migrations from ${migrationsFolder}`)
  await migrate(drizzle(sql), { migrationsFolder })
  console.log("migrations applied")
} catch (err) {
  console.error("migration failed:", err instanceof Error ? err.message : err)
  process.exitCode = 1
} finally {
  await sql.end({ timeout: 5 })
}
