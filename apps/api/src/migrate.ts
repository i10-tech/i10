/**
 * Applies pending Drizzle migrations, then exits.
 *
 * Run as an Argo CD PreSync hook rather than on API startup. Migrating on boot
 * is simpler right up to the moment there are two replicas, at which point both
 * race for the same schema lock and one of them crash-loops. A PreSync hook runs
 * exactly once per sync, before any new pod starts, which is the ordering a
 * schema change actually needs.
 *
 * The runner itself (connection, wait for the database, pgvector load) lives in
 * migrate-run.ts, so `scripts/check-migrations.ts` can prove every migration
 * through the same code.
 */
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { applyMigrations, describe } from "./migrate-run.js"

const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL
if (!url) {
  console.error("MIGRATE_DATABASE_URL (or DATABASE_URL) is required")
  process.exit(1)
}

// dist/migrate.js -> ../drizzle, which the Dockerfile copies alongside dist.
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle")

try {
  console.log(`applying migrations from ${migrationsFolder}`)
  await applyMigrations(url, migrationsFolder)
  console.log("migrations applied")
} catch (err) {
  console.error("migration failed:", describe(err))
  process.exitCode = 1
}
