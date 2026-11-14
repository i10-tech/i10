/*
 * Proves that EVERY migration applies on its own, in a brand-new session, as
 * the non-superuser database owner, through the real runner (`applyMigrations`
 * in src/migrate-run.ts). That is the worst case of how production applies
 * them: a deploy starts a fresh PreSync session at whatever migration is first
 * pending, as `i10`, which owns the database but is not a superuser.
 *
 *   CHECK_MIGRATIONS_ADMIN_URL=postgres://<superuser>:<pw>@127.0.0.1:5432/postgres \
 *     bun run --filter @i10/api check-migrations
 *
 * Migrating an empty database in one run cannot see the failure this exists
 * for: a migration that only works because an earlier one in the same session
 * left something behind (0155 needed pgvector's library loaded, and only got it
 * by luck), or only works as a superuser. So migration N is applied by a run
 * whose journal stops at N, on its own connection, N times over.
 *
 * Setup mirrors infra/k8s/i10/platform-db/cluster.yaml: the managed login roles,
 * database `i10` owned by `i10` (0001 grants on it BY NAME), and pgvector
 * created by the superuser, as CNPG does declaratively.
 *
 * ⚠ POINT IT AT A THROWAWAY SERVER. It creates roles and a database and never
 * drops anything; if a database called `i10` already exists it refuses rather
 * than migrate something that may be real.
 */
import { mkdtemp, readFile, rm, symlink, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import postgres from "postgres"
import { applyMigrations, describe } from "../src/migrate-run.js"

// ⚠ NO DEFAULT AND NO SKIP. A check that quietly passes when it is not
// configured is a check that has stopped running without anyone noticing.
const adminUrl = process.env.CHECK_MIGRATIONS_ADMIN_URL
if (!adminUrl) {
  console.error(
    "CHECK_MIGRATIONS_ADMIN_URL is required: a SUPERUSER url to a throwaway Postgres with pgvector",
  )
  process.exit(1)
}

const DATABASE = "i10"
const OWNER = "i10"
// Everything cluster.yaml creates, because migrations grant to them by name.
const ROLES = [OWNER, "authd", "i10_api", "pdns", "stalwart"]

const drizzleFolder = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle")

type JournalEntry = { tag: string }
type Journal = { entries: JournalEntry[] }

/** The admin url pointed at `i10`, as `as` (a role whose password is its name) or as the admin. */
function i10Url(as?: string): string {
  const url = new URL(adminUrl!)
  if (as) {
    url.username = as
    url.password = as
  }
  url.pathname = `/${DATABASE}`
  return url.toString()
}

async function setUp() {
  const admin = postgres(adminUrl!, { max: 1, prepare: false, onnotice: () => {} })
  try {
    const [me] = await admin<{ rolsuper: boolean }[]>`
      select rolsuper from pg_roles where rolname = current_user
    `
    if (!me?.rolsuper)
      throw new Error("CHECK_MIGRATIONS_ADMIN_URL must connect as a superuser")

    const [existing] =
      await admin`select 1 from pg_database where datname = ${DATABASE}`
    if (existing) {
      throw new Error(
        `database "${DATABASE}" already exists on this server. This check creates it fresh ` +
          "and never drops anything - point CHECK_MIGRATIONS_ADMIN_URL at a throwaway server " +
          "(or drop it there yourself).",
      )
    }

    for (const role of ROLES) {
      const [found] = await admin`select 1 from pg_roles where rolname = ${role}`
      if (!found) {
        // A role's password cannot be a bind parameter; these are constants.
        await admin.unsafe(`create role ${role} login password '${role}'`)
      }
    }
    await admin`create database ${admin(DATABASE)} owner ${admin(OWNER)}`
  } finally {
    await admin.end({ timeout: 5 })
  }

  const adminOnI10 = postgres(i10Url(), { max: 1, prepare: false })
  try {
    await adminOnI10`create extension vector`
  } finally {
    await adminOnI10.end({ timeout: 5 })
  }
}

async function assertNotSuperuser(url: string) {
  const sql = postgres(url, { max: 1, prepare: false })
  try {
    const [me] = await sql<{ rolsuper: boolean }[]>`
      select rolsuper from pg_roles where rolname = current_user
    `
    if (me?.rolsuper !== false) {
      throw new Error(
        `role "${OWNER}" is a superuser here, so this check would prove nothing`,
      )
    }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

async function countApplied(): Promise<number> {
  const sql = postgres(i10Url(OWNER), { max: 1, prepare: false })
  try {
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from drizzle.__drizzle_migrations
    `
    return row?.n ?? 0
  } finally {
    await sql.end({ timeout: 5 })
  }
}

const started = performance.now()
const journal = JSON.parse(
  await readFile(join(drizzleFolder, "meta", "_journal.json"), "utf8"),
) as Journal

// drizzle's readMigrationFiles reads exactly two things: meta/_journal.json and
// `<tag>.sql` for each journal entry. So one folder of symlinks serves every
// step; only the journal is rewritten, one entry longer each time.
const work = await mkdtemp(join(tmpdir(), "i10-check-migrations-"))
let current = ""
try {
  await setUp()
  const ownerUrl = i10Url(OWNER)
  await assertNotSuperuser(ownerUrl)

  await mkdir(join(work, "meta"))
  for (const { tag } of journal.entries) {
    await symlink(join(drizzleFolder, `${tag}.sql`), join(work, `${tag}.sql`))
  }

  for (let i = 1; i <= journal.entries.length; i++) {
    current = journal.entries[i - 1]!.tag
    await writeFile(
      join(work, "meta", "_journal.json"),
      JSON.stringify({ ...journal, entries: journal.entries.slice(0, i) }),
    )
    await applyMigrations(ownerUrl, work)
  }
  current = ""

  // ⚠ drizzle SKIPS rather than fails a migration whose `when` is not later
  // than the last one applied, so a passing run could still have applied fewer
  // than it read. Counting the rows is what rules that out.
  const applied = await countApplied()
  if (applied !== journal.entries.length) {
    throw new Error(
      `applied ${applied} migrations but the journal has ${journal.entries.length}`,
    )
  }

  const seconds = ((performance.now() - started) / 1000).toFixed(1)
  console.log(
    `all ${applied} migrations applied one at a time, each in a fresh session as ${OWNER} (${seconds}s)`,
  )
} catch (err) {
  console.error(
    current ? `migration ${current} failed on its own:` : "check-migrations failed:",
    describe(err),
  )
  process.exitCode = 1
} finally {
  await rm(work, { recursive: true, force: true })
}
