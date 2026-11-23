/* eslint-disable turbo/no-undeclared-env-vars -- run by hand, never a turbo task, so no cache key to poison */
/**
 * Proves a drizzle upgrade against a scratch Postgres, from the 0.x migrator's
 * state to the current tree's.
 *
 *   PROOF_ADMIN_URL=postgres://i10:i10@127.0.0.1:55471/scratch \
 *     bun scripts/prove-migrations.ts
 *
 * PROOF_ADMIN_URL is a SUPERUSER on a throwaway server and must be loopback;
 * the script drops and recreates a database named `i10` there, because
 * migration 0001 hard-codes that name. It refuses to drop an `i10` it did not
 * create. Needs `pg_dump` on PATH (PG_DUMP overrides), git, and bun.
 *
 * Optional: OLD_REF (default origin/main) is the commit before the upgrade;
 * PROOF_OLD_TREE reuses an already extracted and installed copy of it.
 *
 * Steps, each printed as PASS or FAIL:
 *   a  the current migrator applies every migration to an empty database
 *   b  a database migrated by the OLD migrator, then the current one: nothing
 *      re-applied, the tracking table upgraded in place, and again when two
 *      migrations are still pending, and again when the old table holds the
 *      hashes applied migrations had before 12421fa0 edited them
 *   c  the schema dumps of a, b and the old migrator's own are identical
 *   d  `drizzle-kit generate` finds no schema changes and `check` is clean
 *   e  the *-db tests run, none skipped, and fail exactly where the old tree's
 *      do
 */
import { createHash } from "node:crypto"
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import postgres from "postgres"

const api = join(dirname(fileURLToPath(import.meta.url)), "..")
const repo = join(api, "..", "..")
const migrations = join(api, "drizzle")
const MARK = "i10-migration-proof"
const PG_DUMP = process.env.PG_DUMP ?? "pg_dump"
const OLD_REF = process.env.OLD_REF ?? "origin/main"
const LAG = 2
// The commit before 12421fa0 edited applied migrations; see b4.
const PRE_HYPHEN_REF = "12421fa0^"

const adminUrl = process.env.PROOF_ADMIN_URL
if (!adminUrl) {
  console.error("PROOF_ADMIN_URL (superuser, loopback, throwaway) is required")
  process.exit(2)
}
const admin = new URL(adminUrl)
if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(admin.hostname)) {
  console.error(
    `refusing ${admin.hostname}: the proof drops databases and runs on loopback only`,
  )
  process.exit(2)
}
const urlFor = (db: string, user = admin.username, pass = admin.password) => {
  const u = new URL(adminUrl)
  u.pathname = `/${db}`
  u.username = user
  u.password = pass
  return u.toString()
}
if (admin.pathname === "/i10") {
  console.error(
    "PROOF_ADMIN_URL must connect to another database: the script drops i10",
  )
  process.exit(2)
}
const OWNER = urlFor("i10")
const API_ROLE = urlFor("i10", "i10_api", "i10_api")

type Run = { code: number; out: string }
async function run(
  cmd: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<Run> {
  const proc = Bun.spawn(cmd, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out: out + err }
}

const results: { step: string; ok: boolean; detail: string }[] = []
function record(step: string, ok: boolean, detail: string) {
  results.push({ step, ok, detail })
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? `  -  ${detail}` : ""}`)
}
const tail = (text: string, n = 12) => text.trim().split("\n").slice(-n).join("\n")

const adminSql = postgres(adminUrl, { max: 1, onnotice: () => {} })

async function resetDatabase() {
  const [existing] = await adminSql`select shobj_description(oid, 'pg_database') as note
                                      from pg_database where datname = 'i10'`
  if (existing && existing.note !== MARK) {
    throw new Error("a database named i10 exists here that this script did not create")
  }
  await adminSql.unsafe("drop database if exists i10 with (force)")
  await adminSql.unsafe("create database i10")
  await adminSql.unsafe(`comment on database i10 is '${MARK}'`)
  for (const role of ["authd", "i10_api", "pdns", "stalwart", "mailfront"]) {
    const [found] = await adminSql`select 1 from pg_roles where rolname = ${role}`
    if (!found) await adminSql.unsafe(`create role ${role} login password '${role}'`)
  }
  const inside = postgres(OWNER, { max: 1, onnotice: () => {} })
  try {
    await inside.unsafe("create extension vector")
  } finally {
    await inside.end()
  }
}

async function ownerRows<T extends object>(query: string): Promise<T[]> {
  const sql = postgres(OWNER, { max: 1, onnotice: () => {} })
  try {
    return (await sql.unsafe(query)) as unknown as T[]
  } finally {
    await sql.end()
  }
}

type Tracking = {
  id: number
  hash: string
  created_at: string
  name: string | null
  applied_at: string | null
}
async function trackingColumns(): Promise<string[]> {
  const rows = await ownerRows<{ column_name: string }>(
    `select column_name from information_schema.columns
      where table_schema = 'drizzle' and table_name = '__drizzle_migrations' order by ordinal_position`,
  )
  return rows.map((r) => r.column_name)
}
async function tracking(): Promise<Tracking[]> {
  const columns = await trackingColumns()
  const name = columns.includes("name") ? "name" : "null::text as name"
  const appliedAt = columns.includes("applied_at")
    ? "applied_at::text"
    : "null::text as applied_at"
  return ownerRows<Tracking>(
    `select id, hash, created_at::text, ${name}, ${appliedAt}
       from drizzle.__drizzle_migrations order by id`,
  )
}

async function dump(): Promise<string> {
  const r = await run(
    [PG_DUMP, "--schema-only", "-n", "authd", "-n", "core", "-n", "identity", OWNER],
    api,
  )
  if (r.code !== 0) throw new Error(`pg_dump failed: ${tail(r.out)}`)
  return r.out
    .split("\n")
    .filter((l) => !/^\\(un)?restrict /.test(l) && !/^-- Dumped (from|by)/.test(l))
    .join("\n")
}

const migrateNew = () =>
  run(["bun", "src/migrate.ts"], api, { MIGRATE_DATABASE_URL: OWNER })

const expected = readdirSync(migrations)
  .filter((d) => existsSync(join(migrations, d, "migration.sql")))
  .sort()

async function main() {
  console.log(`${expected.length} migration folders in ${migrations}`)

  const treeEnv = process.env.PROOF_OLD_TREE
  const oldRoot = treeEnv ?? mkdtempSync(join(tmpdir(), "i10-drizzle-old-"))
  if (!treeEnv) {
    const archive = Bun.spawn(
      ["sh", "-c", `git archive ${OLD_REF} | tar -x -C ${oldRoot}`],
      {
        cwd: repo,
      },
    )
    if ((await archive.exited) !== 0) throw new Error(`git archive ${OLD_REF} failed`)
    const install = await run(["bun", "install", "--frozen-lockfile"], oldRoot)
    if (install.code !== 0)
      throw new Error(`old tree install failed: ${tail(install.out)}`)
    const build = await run(
      ["bunx", "turbo", "run", "build", "--filter=@i10/api^..."],
      oldRoot,
    )
    if (build.code !== 0) throw new Error(`old tree build failed: ${tail(build.out)}`)
  }
  const oldApi = join(oldRoot, "apps", "api")
  const oldOrm = JSON.parse(
    readFileSync(join(oldRoot, "node_modules", "drizzle-orm", "package.json"), "utf8"),
  ) as { version: string }
  if (!oldOrm.version.startsWith("0.")) {
    throw new Error(
      `the old tree has drizzle-orm ${oldOrm.version}; set OLD_REF to a commit before the upgrade`,
    )
  }
  console.log(`old tree: drizzle-orm ${oldOrm.version} at ${oldRoot}`)

  // Migrations the upgrade itself adds exist only in the current tree, so the
  // old migrator never applies them and the current one always does.
  const oldCount = (
    JSON.parse(
      readFileSync(join(oldApi, "drizzle", "meta", "_journal.json"), "utf8"),
    ) as { entries: unknown[] }
  ).entries.length
  const added = expected.slice(oldCount)

  const migrateOld = () =>
    run(["bun", "src/migrate.ts"], oldApi, { MIGRATE_DATABASE_URL: OWNER })

  // a
  await resetDatabase()
  const a = await migrateNew()
  const aRows = a.code === 0 ? await tracking() : []
  const aNames = aRows.map((r) => r.name)
  record(
    "a  fresh database, current migrator",
    a.code === 0 &&
      a.out.includes("migrations applied") &&
      aNames.length === expected.length &&
      expected.every((name, i) => aNames[i] === name) &&
      aRows.every((r) => r.applied_at !== null),
    a.code === 0 ? `${aRows.length} rows, names match the folders` : tail(a.out),
  )
  const dumpA = await dump()

  // b: production as the 0.x migrator left it
  await resetDatabase()
  const old = await migrateOld()
  const oldRows = old.code === 0 ? await tracking() : []
  const oldColumns = await trackingColumns()
  record(
    "b0 old migrator on an empty database (production's table)",
    old.code === 0 &&
      oldRows.length === oldCount &&
      oldColumns.join(",") === "id,hash,created_at",
    `${oldRows.length} rows, columns ${oldColumns.join(",")}`,
  )
  const dumpOld = await dump()

  const first = await migrateNew()
  const afterFirst = await tracking()
  const columnsAfter = await trackingColumns()
  const carried = afterFirst.slice(0, oldCount)
  const sameIdentity =
    afterFirst.length === expected.length &&
    oldRows.every(
      (o, i) =>
        carried[i]?.id === o.id &&
        carried[i]?.hash === o.hash &&
        carried[i]?.created_at === o.created_at,
    )
  record(
    `b1 current migrator over the old table: upgraded in place, nothing re-applied, ${added.length} added by the upgrade applied`,
    first.code === 0 &&
      sameIdentity &&
      carried.every((r) => r.applied_at === null) &&
      afterFirst.slice(oldCount).every((r) => r.applied_at !== null) &&
      afterFirst.every((r, i) => r.name === expected[i]) &&
      columnsAfter.join(",") === "id,hash,created_at,name,applied_at",
    `exit ${first.code}, ${afterFirst.length} rows, max id ${afterFirst.at(-1)?.id}, ` +
      `columns ${columnsAfter.join(",")}, applied_at set on ${afterFirst.filter((r) => r.applied_at !== null).length}`,
  )
  console.log(`      migrate.ts output: ${tail(first.out, 4).replace(/\n/g, " | ")}`)
  const dumpB = await dump()

  const second = await migrateNew()
  const afterSecond = await tracking()
  record(
    "b2 the PreSync hook run twice: second run changes nothing",
    second.code === 0 && JSON.stringify(afterSecond) === JSON.stringify(afterFirst),
    `exit ${second.code}`,
  )

  // b3: production a couple of migrations behind the image
  await resetDatabase()
  const lagFolder = join(oldApi, "drizzle-lag")
  rmSync(lagFolder, { recursive: true, force: true })
  cpSync(join(oldApi, "drizzle"), lagFolder, { recursive: true })
  const journalPath = join(lagFolder, "meta", "_journal.json")
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: { tag: string }[]
  }
  journal.entries.splice(-LAG)
  writeFileSync(journalPath, JSON.stringify(journal, null, 2))
  const lagScript = join(oldApi, "migrate-lag.ts")
  writeFileSync(
    lagScript,
    `import { drizzle } from "drizzle-orm/postgres-js"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import postgres from "postgres"
const sql = postgres(process.env.MIGRATE_DATABASE_URL!, { max: 1, prepare: false })
await migrate(drizzle(sql), { migrationsFolder: "./drizzle-lag" })
await sql.end()
`,
  )
  const lag = await run(["bun", "migrate-lag.ts"], oldApi, {
    MIGRATE_DATABASE_URL: OWNER,
  })
  const lagRows = lag.code === 0 ? await tracking() : []
  const heal = await migrateNew()
  const healed = await tracking()
  const fresh = healed.filter((r) => r.applied_at !== null).map((r) => r.name)
  record(
    `b3 old migrator ${LAG} migrations behind, then current: applies exactly those ${LAG} and the ${added.length} added`,
    lag.code === 0 &&
      lagRows.length === oldCount - LAG &&
      heal.code === 0 &&
      healed.length === expected.length &&
      healed.every((r, i) => r.name === expected[i]) &&
      fresh.join(",") === expected.slice(oldCount - LAG).join(","),
    `old left ${lagRows.length} rows, now ${healed.length}, newly applied: ${fresh.join(", ")}`,
  )
  const dumpLag = await dump()
  rmSync(lagFolder, { recursive: true, force: true })
  rmSync(lagScript, { force: true })

  // b4: production as it really is. Building the old table from today's files
  // gives every row today's hash, which is how b1 missed that 12421fa0
  // (2026-09-28) changed the bytes of migrations already applied. Put back the
  // hashes those files had before it, read from git rather than from the fix,
  // so this proves the fix against history and not against itself.
  await resetDatabase()
  const preHyphen = await migrateOld()
  const journalBefore = await run(
    ["git", "show", `${PRE_HYPHEN_REF}:apps/api/drizzle/meta/_journal.json`],
    repo,
  )
  if (journalBefore.code !== 0)
    throw new Error(`git show failed: ${tail(journalBefore.out)}`)
  const tagAt = new Map(
    (
      JSON.parse(journalBefore.out) as { entries: { when: number; tag: string }[] }
    ).entries.map((e) => [String(e.when), e.tag]),
  )
  let rewound = 0
  for (const row of preHyphen.code === 0 ? await tracking() : []) {
    const tag = tagAt.get(row.created_at)
    if (!tag) continue
    const file = await run(
      ["git", "show", `${PRE_HYPHEN_REF}:apps/api/drizzle/${tag}.sql`],
      repo,
    )
    if (file.code !== 0) throw new Error(`git show ${tag} failed: ${tail(file.out)}`)
    const hash = createHash("sha256").update(file.out).digest("hex")
    if (hash === row.hash) continue
    await ownerRows(
      `update drizzle.__drizzle_migrations set hash = '${hash}' where id = ${row.id}`,
    )
    rewound++
  }
  const upgraded = await migrateNew()
  const afterRewind = await tracking()
  const nameAt = (createdAt: string) =>
    afterRewind.find((r) => r.created_at === createdAt)?.name
  record(
    "b4 old table with the pre-2026-09-28 hashes, then current: upgraded, every row named",
    preHyphen.code === 0 &&
      rewound > 0 &&
      upgraded.code === 0 &&
      afterRewind.length === expected.length &&
      afterRewind.every((r, i) => r.name === expected[i]) &&
      nameAt("1788375625045") === "20260902190025_sweep_respects_schedule" &&
      nameAt("1788391257954") === "20260902232057_webhook_rls",
    upgraded.code === 0
      ? `${rewound} hashes rewound, ${afterRewind.length} rows named`
      : (upgraded.out.match(/^migration failed: .*$/m)?.[0] ?? tail(upgraded.out, 2)),
  )

  // c
  const same = dumpA === dumpB && dumpB === dumpOld && dumpOld === dumpLag
  record(
    "c  schema parity: fresh-new, old-then-new, old fresh, old-behind-then-new",
    same,
    same
      ? `${dumpA.split("\n").length} lines each, identical`
      : "dumps differ (diff them: set PROOF_KEEP=1)",
  )
  if (!same && process.env.PROOF_KEEP) {
    const keep = mkdtempSync(join(tmpdir(), "i10-drizzle-dumps-"))
    writeFileSync(join(keep, "fresh-new.sql"), dumpA)
    writeFileSync(join(keep, "old-then-new.sql"), dumpB)
    writeFileSync(join(keep, "old-fresh.sql"), dumpOld)
    writeFileSync(join(keep, "old-behind-then-new.sql"), dumpLag)
    console.log(`      dumps kept in ${keep}`)
  }

  // d
  const before = readdirSync(migrations).sort().join("\n")
  const gen = await run(["bunx", "drizzle-kit", "generate"], api)
  const afterGen = readdirSync(migrations).sort()
  const created = afterGen.filter((d) => !before.split("\n").includes(d))
  const clean =
    gen.code === 0 && created.length === 0 && gen.out.includes("No schema changes")
  record(
    "d  db:generate reports no schema changes",
    clean,
    clean ? "" : tail(gen.out, 3),
  )
  for (const dir of created) {
    console.log(`      generate proposed ${dir}/migration.sql (removed again):`)
    console.log(
      readFileSync(join(migrations, dir, "migration.sql"), "utf8")
        .split("\n")
        .map((l) => `        ${l}`)
        .join("\n"),
    )
    rmSync(join(migrations, dir), { recursive: true, force: true })
  }
  const check = await run(["bunx", "drizzle-kit", "check"], api)
  record(
    "d2 drizzle-kit check is clean",
    check.code === 0,
    check.code === 0 ? "" : tail(check.out, 3),
  )

  // e
  const dbEnv = () => ({
    TEMPLATES_TEST_DATABASE_URL: OWNER,
    STORAGE_TEST_DATABASE_URL: OWNER,
    STORAGE_TEST_API_DATABASE_URL: API_ROLE,
    MAILBOX_AUTH_TEST_DATABASE_URL: OWNER,
    MAILBOX_AUTH_TEST_API_DATABASE_URL: API_ROLE,
    MAILBOX_QUOTA_TEST_DATABASE_URL: OWNER,
    MAILBOX_ROUTE_TEST_DATABASE_URL: OWNER,
    METERING_TEST_DATABASE_URL: OWNER,
    METERING_TEST_API_DATABASE_URL: API_ROLE,
    RISK_TEST_DATABASE_URL: OWNER,
    RISK_TEST_API_DATABASE_URL: API_ROLE,
    TEAM_INBOX_TEST_DATABASE_URL: OWNER,
    WEBHOOKS_TEST_DATABASE_URL: OWNER,
  })
  const dbTests = async (cwd: string) => {
    const files = readdirSync(join(cwd, "test"))
      .filter((f) => f.endsWith("-db.test.ts"))
      .map((f) => `test/${f}`)
    const r = await run(["bun", "test", ...files], cwd, dbEnv())
    const count = (word: string) =>
      Number(new RegExp(`^\\s*(\\d+) ${word}$`, "m").exec(r.out)?.[1] ?? 0)
    const failed = [...r.out.matchAll(/^\(fail\) (.*?)(?: \[[\d.]+m?s\])?$/gm)]
      .map((m) => m[1]!)
      .sort()
    return {
      pass: count("pass"),
      skip: count("skip"),
      fail: count("fail"),
      errors: count("errors?"),
      failed,
      tail: tail(r.out, 6),
    }
  }

  await resetDatabase()
  const migratedOld = await migrateOld()
  const oldRun = migratedOld.code === 0 ? await dbTests(oldApi) : null
  await resetDatabase()
  const migratedNew = await migrateNew()
  const newRun = migratedNew.code === 0 ? await dbTests(api) : null
  if (!oldRun || !newRun) {
    record("e  DB-backed tests", false, "a migration failed before the tests could run")
  } else {
    const onlyNew = newRun.failed.filter((f) => !oldRun.failed.includes(f))
    const onlyOld = oldRun.failed.filter((f) => !newRun.failed.includes(f))
    record(
      "e  DB-backed tests: none skipped, failures identical to the old tree's",
      oldRun.skip === 0 &&
        newRun.skip === 0 &&
        newRun.errors === 0 &&
        onlyNew.length === 0 &&
        onlyOld.length === 0 &&
        newRun.pass === oldRun.pass,
      `old ${oldRun.pass} pass / ${oldRun.fail} fail / ${oldRun.skip} skip; ` +
        `new ${newRun.pass} pass / ${newRun.fail} fail / ${newRun.skip} skip / ${newRun.errors} errors`,
    )
    for (const f of onlyNew) console.log(`      fails only on the new tree: ${f}`)
    for (const f of onlyOld) console.log(`      fails only on the old tree: ${f}`)
    for (const f of newRun.failed) console.log(`      (fails on both: ${f})`)
  }

  if (!treeEnv && !process.env.PROOF_KEEP)
    rmSync(oldRoot, { recursive: true, force: true })
}

try {
  await main()
} catch (err) {
  record("script", false, err instanceof Error ? err.message : String(err))
} finally {
  await adminSql.end({ timeout: 5 })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} steps passed`)
process.exit(failed.length === 0 ? 0 : 1)
