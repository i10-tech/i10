/*
 * Re-wraps every message body key under the current `CONTENT_KEYS` key: the
 * tool for a rotation, so an old key can be retired without waiting for
 * retention to delete what it wrapped.
 *
 *   bun run --filter @i10/api rewrap-body-keys            (dry run: counts only)
 *   bun run --filter @i10/api rewrap-body-keys --apply
 *
 * It walks `core.message_bodies` through the parent table, in batches ordered
 * by the primary key (message_id, created_at), so every partition is read and
 * no batch holds more than `batchSize` rows. It prints counts and the ids of
 * keys that would not open; never a key or a body.
 *
 * ⚠ IT NEVER READS R2, AND NEEDS NO R2 SETTINGS. A record in a pack is sealed
 * with the body's own key, and that key does not change: only its wrapping in
 * `body_key` does.
 *
 * ⚠ SAFE TO STOP AND RUN AGAIN, AND BESIDE THE API AND THE CONTENT-STORE JOB.
 * Each write is guarded on the old `body_key`, so a row packed, deleted by
 * retention or shredded since it was read is left alone (and counted as
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
import { bodyKeyUnder, rewrapBodyKey, type BodyIds } from "../src/content/seal.js"
import { keyringFromEnv, type Keyring } from "../src/crypto/keyring.js"
import { unlockEnv } from "../src/crypto/unlock.js"
import { assertSeesEveryRow } from "./owner-role.js"

type Sql = ReturnType<typeof postgres>

const TABLE = "core.message_bodies"
/** Failed rows kept for the report; the count is always whole. */
const FAILED_SHOWN = 1000

export interface RewrapReport {
  current: string
  scanned: number
  nulls: number
  /** Body keys by the kid they are wrapped under. */
  kids: Record<string, number>
  failed: number
  /** The first `FAILED_SHOWN` rows whose key would not open. Ids only. */
  failedRows: BodyIds[]
  rewrapped: number
  /** Changed by somebody else between the read and the write. */
  skipped: number
}

interface Row {
  message_id: string
  /**
   * Postgres's own text: the key has microseconds a JS Date would drop.
   *
   * ⚠ SENT BACK AS `::text::timestamptz`. A bare `::timestamptz` parameter is
   * serialized by postgres.js through a Date, and the cursor then sits just
   * before the last row: that row comes back in every batch, for ever.
   */
  created_at: string
  tenant_id: string
  body_key: string | null
}

export const staleKeys = (r: RewrapReport) =>
  Object.entries(r.kids).reduce(
    (n, [kid, count]) => (kid === r.current ? n : n + count),
    0,
  )

export async function rewrapBodyKeys(
  sql: Sql,
  ring: Keyring,
  opts: { apply: boolean; batchSize?: number },
): Promise<RewrapReport> {
  await assertSeesEveryRow(sql, TABLE)
  const batchSize = opts.batchSize ?? 1000
  const report: RewrapReport = {
    current: ring.current,
    scanned: 0,
    nulls: 0,
    kids: {},
    failed: 0,
    failedRows: [],
    rewrapped: 0,
    skipped: 0,
  }

  let after: Row | undefined
  for (;;) {
    const rows: Row[] = await sql<Row[]>`
      select b.message_id::text as message_id, b.created_at::text as created_at,
             b.tenant_id::text as tenant_id, b.body_key
        from core.message_bodies b
       ${after ? sql`where (b.message_id, b.created_at) > (${after.message_id}::uuid, ${after.created_at}::text::timestamptz)` : sql``}
       -- ⚠ QUALIFIED: bare names would sort by the text aliases above, off
       -- the primary key index and in the wrong order for created_at.
       order by b.message_id, b.created_at
       limit ${batchSize}`
    if (rows.length === 0) break
    after = rows.at(-1)
    report.scanned += rows.length

    const writes: [string, string, string, string, string][] = []
    for (const row of rows) {
      if (row.body_key === null) {
        report.nulls++
        continue
      }
      const kid = bodyKeyUnder(row.body_key)
      if (kid) report.kids[kid] = (report.kids[kid] ?? 0) + 1
      const ids = { tenantId: row.tenant_id, messageId: row.message_id }
      let fresh: string
      try {
        fresh = rewrapBodyKey(ring, ids, row.body_key)
      } catch {
        report.failed++
        if (report.failedRows.length < FAILED_SHOWN) report.failedRows.push(ids)
        continue
      }
      if (opts.apply && fresh !== row.body_key) {
        writes.push([
          row.message_id,
          row.created_at,
          row.tenant_id,
          row.body_key,
          fresh,
        ])
      }
    }
    if (writes.length === 0) continue

    const updated = await sql`
      update core.message_bodies b set body_key = v.fresh
        from (values ${sql(writes)}) as v(message_id, created_at, tenant_id, old, fresh)
       where b.message_id = v.message_id::uuid
         and b.created_at = v.created_at::timestamptz
         and b.tenant_id = v.tenant_id::uuid
         and b.body_key = v.old
      returning b.message_id`
    report.rewrapped += updated.count
    report.skipped += writes.length - updated.count
  }
  return report
}

function print(r: RewrapReport, heading: string) {
  const kids = Object.entries(r.kids)
    .map(([kid, n]) => `${kid}=${n}`)
    .join(" ")
  console.log(`\n${heading}`)
  console.log(
    `  ${TABLE}.body_key: rows=${r.scanned} [${kids}] null=${r.nulls} failed=${r.failed}` +
      (r.rewrapped || r.skipped
        ? ` rewrapped=${r.rewrapped} skipped=${r.skipped}`
        : ""),
  )
  for (const f of r.failedRows)
    console.log(`    does not open: tenant ${f.tenantId} message ${f.messageId}`)
  if (r.failed > r.failedRows.length)
    console.log(`    and ${r.failed - r.failedRows.length} more`)
}

if (import.meta.main) {
  const apply = process.argv.includes("--apply")
  const url = process.env.MIGRATE_DATABASE_URL
  const value = (await unlockEnv(console)).CONTENT_KEYS
  if (!url) {
    console.error(
      "MIGRATE_DATABASE_URL is required: the owner role, which sees every workspace",
    )
    process.exit(1)
  }
  if (!value) {
    console.error("CONTENT_KEYS is required")
    process.exit(1)
  }
  const ring = keyringFromEnv("CONTENT_KEYS", value)

  const sql = postgres(url, { max: 2, onnotice: () => {} })
  try {
    const first = await rewrapBodyKeys(sql, ring, { apply })
    print(
      first,
      apply ? "re-wrapped" : `dry run (current key ${ring.current}; --apply writes)`,
    )
    // After writing, read everything again: the report that decides the exit
    // code is what is in the database now, not what this run meant to do.
    const final = apply ? await rewrapBodyKeys(sql, ring, { apply: false }) : first
    if (apply) print(final, "after")
    const failed = final.failed > 0
    const stale = apply && staleKeys(final) > 0
    if (failed) console.error("\nsome body keys do not open; see the ids above")
    if (stale) console.error(`\nsome body keys are still not under ${ring.current}`)
    process.exitCode = failed || stale ? 1 : 0
  } finally {
    await sql.end({ timeout: 5 })
  }
}
