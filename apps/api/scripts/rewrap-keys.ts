/*
 * Re-wraps every stored data key under the current key of its keyring: the
 * tool for a rotation, so an old master key can be retired without waiting for
 * retention to delete what it wrapped.
 *
 *   bun run --filter @i10/api rewrap-keys            (dry run: counts only)
 *   bun run --filter @i10/api rewrap-keys --apply
 *
 * `rewrap-body-keys` is the same command under its old name.
 *
 *   CONTENT_KEYS  core.message_bodies.body_key
 *   OBJECT_KEYS   core.content_objects.sealed_key, core.mailbox_jobs.sealed_key
 *
 * Each table whose keyring is set is walked in batches ordered by its primary
 * key; a partitioned table through its parent, so every partition is read. It
 * prints counts and the ids of keys that would not open; never a key or any
 * content.
 *
 * ⚠ IT NEVER READS R2, AND NEEDS NO R2 SETTINGS. What is in R2 is sealed with
 * its own data key, and that key does not change: only its wrapping does.
 *
 * ⚠ SAFE TO STOP AND RUN AGAIN, AND BESIDE THE API, THE WORKER AND THE
 * CONTENT-STORE JOB. Each write is guarded on the old value, so a row changed,
 * deleted or shredded since it was read is left alone (and counted as
 * skipped); a deleted key is never written back. A reader holding the old
 * value still opens it while the old key is in the ring. A row written behind
 * the cursor under an old key (a process not yet on the new ring) is what the
 * second scan after `--apply` is for.
 *
 * ⚠ THE OWNER ROLE (`MIGRATE_DATABASE_URL`), BECAUSE IT READS EVERY WORKSPACE.
 *
 * Exits 1 when a key would not open, and after `--apply` also when any key is
 * still under a kid that is not the current one.
 */
import postgres from "postgres"
import { BODY_KEY } from "../src/content/seal.js"
import { OBJECT_KEY } from "../src/content/objects.js"
import { keyUnder, rewrapKey, type KeyPurpose } from "../src/crypto/envelope.js"
import { keyringFromEnv, type Keyring } from "../src/crypto/keyring.js"
import { unlockEnv } from "../src/crypto/unlock.js"
import { EXPORT_KEY } from "../src/mailboxes/sealed-stream.js"
import { assertSeesEveryRow } from "./owner-role.js"

type Sql = ReturnType<typeof postgres>
type Row = Record<string, string | null>

/**
 * One column of wrapped keys. `primaryKey` is the table's real one, in index
 * order, with the type each part is cast back to.
 *
 * ⚠ EVERY KEY PART TRAVELS AS POSTGRES'S OWN TEXT and is cast back with
 * `::text::<type>`. A timestamptz through a JS Date loses its microseconds, and
 * the cursor then sits just before the last row: that row comes back in every
 * batch, for ever.
 */
export interface Target {
  variable: "CONTENT_KEYS" | "OBJECT_KEYS"
  table: string
  column: string
  primaryKey: readonly (readonly [
    name: string,
    type: "uuid" | "text" | "timestamptz",
  ])[]
  /** Other columns the ids need. */
  extra: readonly string[]
  purpose: KeyPurpose<never>
  /** The ids the key is bound to, from the row. Also what a failure prints. */
  ids(row: Row): Record<string, string>
}

const target = <Ids>(
  t: Omit<Target, "purpose" | "ids"> & {
    purpose: KeyPurpose<Ids>
    ids(row: Row): Ids & Record<string, string>
  },
): Target => t as unknown as Target

export const TARGETS: readonly Target[] = [
  target({
    variable: "CONTENT_KEYS",
    table: "core.message_bodies",
    column: "body_key",
    primaryKey: [
      ["message_id", "uuid"],
      ["created_at", "timestamptz"],
    ],
    extra: ["tenant_id"],
    purpose: BODY_KEY,
    ids: (r) => ({ tenantId: r.tenant_id!, messageId: r.message_id! }),
  }),
  target({
    variable: "OBJECT_KEYS",
    table: "core.content_objects",
    column: "sealed_key",
    primaryKey: [
      ["tenant_id", "uuid"],
      ["sha256", "text"],
    ],
    extra: [],
    purpose: OBJECT_KEY,
    ids: (r) => ({ tenantId: r.tenant_id!, sha256: r.sha256! }),
  }),
  target({
    variable: "OBJECT_KEYS",
    table: "core.mailbox_jobs",
    column: "sealed_key",
    primaryKey: [["id", "uuid"]],
    extra: ["tenant_id"],
    purpose: EXPORT_KEY,
    ids: (r) => ({ tenantId: r.tenant_id!, jobId: r.id! }),
  }),
]

/** Failed rows kept for the report; the count is always whole. */
const FAILED_SHOWN = 1000

export interface RewrapReport {
  table: string
  column: string
  current: string
  scanned: number
  nulls: number
  /** Keys by the kid they are wrapped under. */
  kids: Record<string, number>
  failed: number
  /** The first `FAILED_SHOWN` rows whose key would not open. Ids only. */
  failedRows: Record<string, string>[]
  rewrapped: number
  /** Changed by somebody else between the read and the write. */
  skipped: number
}

export const staleKeys = (r: RewrapReport) =>
  Object.entries(r.kids).reduce(
    (n, [kid, count]) => (kid === r.current ? n : n + count),
    0,
  )

export async function rewrapTarget(
  sql: Sql,
  t: Target,
  ring: Keyring,
  opts: { apply: boolean; batchSize?: number },
): Promise<RewrapReport> {
  await assertSeesEveryRow(sql, t.table)
  const batchSize = opts.batchSize ?? 1000
  const report: RewrapReport = {
    table: t.table,
    column: t.column,
    current: ring.current,
    scanned: 0,
    nulls: 0,
    kids: {},
    failed: 0,
    failedRows: [],
    rewrapped: 0,
    skipped: 0,
  }
  const pk = t.primaryKey.map(([name]) => name)
  const cast = (at: number) => `::text::${t.primaryKey[at]![1]}`
  // ⚠ QUALIFIED IN THE ORDER BY: bare names would sort by the text aliases,
  // off the primary key index and in the wrong order for a timestamp.
  const select = [...pk, ...t.extra].map((c) => `t.${c}::text as ${c}`).join(", ")
  const order = pk.map((c) => `t.${c}`).join(", ")

  let after: Row | undefined
  for (;;) {
    const params = after ? pk.map((c) => after![c]!) : []
    const where = after
      ? `where (${order}) > (${pk.map((_, i) => `$${i + 1}${cast(i)}`).join(", ")})`
      : ""
    const rows = await sql.unsafe<Row[]>(
      `select ${select}, t.${t.column} as wrapped from ${t.table} t ${where}
        order by ${order} limit ${batchSize}`,
      params,
    )
    if (rows.length === 0) break
    after = rows.at(-1)
    report.scanned += rows.length

    const writes: { row: Row; fresh: string }[] = []
    for (const row of rows) {
      const wrapped = row.wrapped
      if (wrapped === null || wrapped === undefined) {
        report.nulls++
        continue
      }
      const kid = keyUnder(wrapped)
      if (kid) report.kids[kid] = (report.kids[kid] ?? 0) + 1
      const ids = t.ids(row)
      let fresh: string
      try {
        fresh = rewrapKey(t.purpose, ring, ids as never, wrapped)
      } catch {
        report.failed++
        if (report.failedRows.length < FAILED_SHOWN) report.failedRows.push(ids)
        continue
      }
      if (opts.apply && fresh !== wrapped) writes.push({ row, fresh })
    }
    if (writes.length === 0) continue

    const width = pk.length + 2
    const values = writes
      .map(
        (_, w) =>
          `(${Array.from({ length: width }, (_, i) => `$${w * width + i + 1}`).join(", ")})`,
      )
      .join(", ")
    const match = pk.map((c, i) => `t.${c} = v.${c}${cast(i)}`).join(" and ")
    const updated = await sql.unsafe(
      `update ${t.table} t set ${t.column} = v.fresh
         from (values ${values}) as v(${pk.join(", ")}, old, fresh)
        where ${match} and t.${t.column} = v.old
       returning 1`,
      writes.flatMap(({ row, fresh }) => [
        ...pk.map((c) => row[c]!),
        row.wrapped!,
        fresh,
      ]),
    )
    report.rewrapped += updated.count
    report.skipped += writes.length - updated.count
  }
  return report
}

function print(r: RewrapReport) {
  const kids = Object.entries(r.kids)
    .map(([kid, n]) => `${kid}=${n}`)
    .join(" ")
  console.log(
    `  ${r.table}.${r.column}: rows=${r.scanned} [${kids}] null=${r.nulls} failed=${r.failed}` +
      (r.rewrapped || r.skipped
        ? ` rewrapped=${r.rewrapped} skipped=${r.skipped}`
        : ""),
  )
  for (const f of r.failedRows)
    console.log(
      `    does not open: ${Object.entries(f)
        .map(([k, v]) => `${k} ${v}`)
        .join(" ")}`,
    )
  if (r.failed > r.failedRows.length)
    console.log(`    and ${r.failed - r.failedRows.length} more`)
}

if (import.meta.main) {
  const apply = process.argv.includes("--apply")
  const url = process.env.MIGRATE_DATABASE_URL
  const env = await unlockEnv(console)
  if (!url) {
    console.error(
      "MIGRATE_DATABASE_URL is required: the owner role, which sees every workspace",
    )
    process.exit(1)
  }
  const rings = new Map<Target["variable"], Keyring>()
  for (const name of ["CONTENT_KEYS", "OBJECT_KEYS"] as const) {
    const value = env[name]
    if (value) rings.set(name, keyringFromEnv(name, value))
    else console.log(`${name} is not set: its keys are not re-wrapped`)
  }
  if (rings.size === 0) {
    console.error("CONTENT_KEYS or OBJECT_KEYS is required")
    process.exit(1)
  }

  const sql = postgres(url, { max: 2, onnotice: () => {} })
  let failed = false
  let stale = false
  try {
    for (const t of TARGETS) {
      const ring = rings.get(t.variable)
      if (!ring) continue
      const first = await rewrapTarget(sql, t, ring, { apply })
      console.log(
        apply
          ? `\nre-wrapped (${t.variable})`
          : `\ndry run (${t.variable}, current key ${ring.current}; --apply writes)`,
      )
      print(first)
      // After writing, read everything again: the report that decides the exit
      // code is what is in the database now, not what this run meant to do.
      const final = apply ? await rewrapTarget(sql, t, ring, { apply: false }) : first
      if (apply) {
        console.log("after")
        print(final)
      }
      failed ||= final.failed > 0
      stale ||= apply && staleKeys(final) > 0
    }
    if (failed) console.error("\nsome keys do not open; see the ids above")
    if (stale) console.error("\nsome keys are still not under the current key")
    process.exitCode = failed || stale ? 1 : 0
  } finally {
    await sql.end({ timeout: 5 })
  }
}
