/**
 * The migration runner itself, shared by the PreSync entry point (migrate.ts)
 * and by `scripts/check-migrations.ts`, which drives it once per migration so
 * that what CI proves is the code production runs, not a copy of it.
 *
 * ⚠ THIS USES THE PRIMARY, NOT THE POOLER. Migrations run DDL inside a
 * transaction and take advisory locks; PgBouncer in transaction pooling mode can
 * hand consecutive statements to different backends, which breaks both. The
 * application connects through the pooler - this does not.
 */
import { drizzle } from "drizzle-orm/postgres-js"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import postgres from "postgres"

type Sql = ReturnType<typeof postgres>

/**
 * ⚠ WAIT FOR THE DATABASE TO BE DIALABLE BEFORE MIGRATING, AND DO NOT REMOVE
 * THIS BECAUSE "the database is obviously up".
 *
 * A brand-new pod's FIRST outbound connection to a ClusterIP is refused while
 * kube-proxy and the CNI finish programming rules for it. postgres.js connects
 * LAZILY - the socket is opened by the first query - and it makes exactly one
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
 * lands inside it. The race was always there - nothing about it was introduced
 * by bun, and going back to a slower runtime would hide it rather than fix it.
 * Every attempt is a NEW pod, so `backoffLimit` does not help: each retry gets
 * its own fresh, unready network. The retry has to be in here.
 */
const CONNECT_ATTEMPTS = 10
const CONNECT_DELAY_MS = 1_000

async function waitForDatabase(sql: Sql) {
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
 * ⚠ LOAD pgvector INTO THE SESSION BEFORE ANY MIGRATION RUNS, OR AN
 * INCREMENTAL DEPLOY CANNOT CREATE A FUNCTION WITH `SET hnsw.*`.
 *
 * `hnsw.iterative_scan` and `hnsw.ef_search` are pgvector's own settings, and
 * Postgres only knows them once the pgvector shared library is loaded in the
 * current session. Until then they are unknown placeholders, and only a
 * superuser may attach an unknown parameter to a function - so `i10`, which
 * owns the database but is not a superuser, gets
 *
 *   permission denied to set parameter "hnsw.iterative_scan" [42501]
 *
 * ⚠ AND IT WORKED FOR MONTHS BY SESSION LUCK. Migrating an empty database
 * passes, because an earlier migration in the same run touches a vector and
 * loads the library as a side effect. A deploy that starts a fresh session at a
 * later migration has nothing to load it, which is how 0155 failed in
 * production while every migration before it had "always worked".
 *
 * Casting a literal to the extension's type calls its input function, which
 * loads the library. The schema is looked up and quoted rather than trusted to
 * `search_path`. No row means the extension does not exist yet, and whatever
 * migration creates it loads the library in doing so.
 *
 * ⚠ THIS ONLY HELPS ON THE CONNECTION THE MIGRATIONS USE. A loaded library is
 * per backend, so this relies on `max: 1` below: one connection, one session,
 * for the whole run.
 */
async function loadPgvector(sql: Sql) {
  const [vector] = await sql<{ schema: string }[]>`
    select n.nspname as schema
    from pg_extension e
    join pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'vector'
  `
  if (vector) await sql`select '[1]'::${sql(vector.schema)}.vector`
}

/**
 * ⚠ TWO APPLIED MIGRATIONS CHANGED THEIR BYTES AFTER THEY RAN, AND v1's TABLE
 * UPGRADE CANNOT NAME THEIR ROWS WITHOUT THIS.
 *
 * Commit 12421fa0 (2026-09-28, "replace every em dash with a hyphen") edited
 * comments in already-applied migrations, so every database migrated before it
 * holds the old file hashes. The 0.x migrator never compared them. v1's upgrade
 * names each old row by its second-truncated timestamp and falls back to the
 * hash only when two folders share a second; these two are the later of such a
 * pair, matched nothing, and aborted the run:
 *
 *   ... we found 2 migrations (ids: 8, 10) in the database that do not match
 *
 * The schema they produced is the same either way. Each update needs BOTH the
 * exact timestamp and the exact old hash, so it can only rewrite the known
 * case, and it is a no-op everywhere else - including after it has run once.
 * Delete it once every environment has migrated under v1.
 */
const PRE_HYPHEN_HASHES = [
  {
    migration: "20260902190025_sweep_respects_schedule",
    createdAt: 1788375625045,
    old: "9ef228aa70188162b3fe0672532e33c40dd0e09b7b8f371dd3e02ecb90277356",
    current: "50719f47785a16006cbed3b37c57f233178831cdf65fd020fb3a72b007274626",
  },
  {
    migration: "20260902232057_webhook_rls",
    createdAt: 1788391257954,
    old: "36114632ee5c3665853e3ca64c582283979488be9f320e47d9f3e9f21f00708c",
    current: "c5ea7873ed50dd5c4a35779164e3ecf3c13f108e8a0f703abfc1c4f96c9aac21",
  },
] as const

async function reconcilePreHyphenHashes(sql: Sql) {
  const [table] = await sql<{ exists: boolean }[]>`
    select to_regclass('drizzle.__drizzle_migrations') is not null as exists
  `
  if (!table?.exists) return
  for (const row of PRE_HYPHEN_HASHES) {
    const updated = await sql`
      update drizzle.__drizzle_migrations set hash = ${row.current}
      where created_at = ${row.createdAt} and hash = ${row.old}
    `
    if (updated.count > 0) {
      console.log(`reconciled the pre-2026-09-28 hash of ${row.migration}`)
    }
  }
}

/**
 * Applies every pending migration in `migrationsFolder` on one new connection,
 * then closes it. Throws on failure; the caller decides what that means.
 */
export async function applyMigrations(
  url: string,
  migrationsFolder: string,
): Promise<void> {
  // `max: 1` because a migration is a single serial conversation with the
  // database; a pool would let drizzle take the lock on one connection and run
  // statements on another - and would lose the pgvector load above, which lives
  // in one backend.
  const sql = postgres(url, { max: 1, prepare: false, connect_timeout: 15 })
  try {
    await waitForDatabase(sql)
    await loadPgvector(sql)
    await reconcilePreHyphenHashes(sql)
    // ⚠ `drizzle({ client })`, NOT `drizzle(sql)`: v1 reads a lone argument as a
    // config, finds neither `client` nor `connection` on a postgres.js client,
    // and dials the driver's defaults (localhost, PG* variables) instead of ours.
    //
    // ⚠ THE FIRST RUN AFTER THE 0.x -> v1 UPGRADE ALSO UPGRADES
    // `drizzle.__drizzle_migrations` IN PLACE, in its own transaction before any
    // migration runs: it adds `name` and `applied_at` and names each old row by
    // matching its timestamp to a migration folder, then by hash. A row that
    // matches no folder throws here, which fails the hook with nothing changed.
    // No separate `drizzle-kit up` against the database is needed or exists.
    // scripts/prove-migrations.ts proves it against a 0.x table.
    await migrate(drizzle({ client: sql }), { migrationsFolder })
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/**
 * ⚠ THE WHOLE CHAIN, NOT `err.message`. drizzle wraps a driver error as
 * `Failed query: <sql>` and hangs the real one off `cause`, so printing only
 * the message reports the statement and discards the reason - the difference
 * between "ECONNREFUSED" and a silent wall. A migration that fails invisibly is
 * the worst outcome this file has.
 */
export function describe(err: unknown): string {
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
