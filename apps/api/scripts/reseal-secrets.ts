/*
 * Re-seals every sealed column under the current `SEAL_KEYS` key: the tool
 * for a key rotation.
 *
 *   bun run --filter @i10/api reseal-secrets            (dry run: counts only)
 *   bun run --filter @i10/api reseal-secrets --apply
 *
 * It walks `SEALED_COLUMNS`, so a column cannot be sealed without being on this
 * job's list. A value under a key that is not the current one is opened and
 * sealed again for its own row. It prints counts and the
 * row ids of values that would not open; never a value.
 *
 * ⚠ SAFE TO STOP AND RUN AGAIN. Each write is guarded on the old ciphertext,
 * so a value somebody changed since it was read is left alone (and counted),
 * and a value already current is never touched.
 *
 * ⚠ THE OWNER ROLE (`MIGRATE_DATABASE_URL`), BECAUSE IT READS EVERY WORKSPACE.
 * Row level security does not apply to a table's owner. As `i10_api` some of
 * these tables would answer with no rows rather than an error, and a job that
 * sees nothing reports "nothing left to do". It checks the role before reading.
 *
 * Exits 1 when a value would not open.
 */
import postgres from "postgres"
import {
  SEALED_COLUMNS,
  sealedUnder,
  sealerFromEnv,
  type SealPurpose,
  type Sealer,
} from "../src/crypto/sealer.js"

type Sql = ReturnType<typeof postgres>

export interface ColumnReport {
  purpose: SealPurpose
  nulls: number
  /** Values by the kid they are sealed under. */
  kids: Record<string, number>
  /** Rows whose value would not open. Ids only, never content. */
  failed: { tenantId: string; rowId: string }[]
  resealed: number
  /** Changed by somebody else between the read and the write. */
  skipped: number
}

interface RetiringEntry {
  ciphertext: string
  [field: string]: unknown
}

/** Refuses a role that row level security would quietly filter. */
async function assertSeesEveryRow(sql: Sql, table: string) {
  const [schema, name] = table.split(".") as [string, string]
  const [row] = await sql<{ ok: boolean }[]>`
    select (c.relowner = r.oid or r.rolsuper or r.rolbypassrls) as ok
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_roles r on r.rolname = current_user
     where n.nspname = ${schema} and c.relname = ${name}`
  if (!row?.ok) {
    throw new Error(
      `${current(sql)} cannot see every row of ${table}: run as the owner role (MIGRATE_DATABASE_URL)`,
    )
  }
}

const current = (sql: Sql) => sql.options.user

export async function resealSecrets(
  sql: Sql,
  box: Sealer,
  opts: { apply: boolean },
): Promise<ColumnReport[]> {
  const reports: ColumnReport[] = []

  for (const [purpose, spec] of Object.entries(SEALED_COLUMNS) as [
    SealPurpose,
    (typeof SEALED_COLUMNS)[SealPurpose],
  ][]) {
    await assertSeesEveryRow(sql, spec.table)
    const report: ColumnReport = {
      purpose,
      nulls: 0,
      kids: {},
      failed: [],
      resealed: 0,
      skipped: 0,
    }
    reports.push(report)

    const rows = await sql<{ row_id: string; tenant_id: string; value: unknown }[]>`
      select ${sql(spec.row)}::text as row_id, tenant_id::text as tenant_id,
             ${sql(spec.column)} as value
        from ${sql(spec.table)}`

    for (const row of rows) {
      const context = { purpose, tenantId: row.tenant_id, rowId: row.row_id }
      const values =
        spec.shape === "retiring"
          ? (row.value as RetiringEntry[]).map((e) => e.ciphertext)
          : row.value === null
            ? []
            : [row.value as string]
      if (values.length === 0) {
        report.nulls++
        continue
      }

      // Each value is counted and opened; a row is rewritten only if one of
      // its values is stale and every one of them opened.
      let stale = false
      const opened: string[] = []
      for (const value of values) {
        const kid = sealedUnder(value)
        if (kid) report.kids[kid] = (report.kids[kid] ?? 0) + 1
        if (kid !== box.currentKid) stale = true
        try {
          opened.push(box.open(context, value))
        } catch {
          if (
            !report.failed.some(
              (f) => f.rowId === row.row_id && f.tenantId === row.tenant_id,
            )
          )
            report.failed.push({ tenantId: row.tenant_id, rowId: row.row_id })
        }
      }
      if (!opts.apply || !stale || opened.length !== values.length) continue

      const fresh = opened.map((plain) => box.seal(context, plain))
      const next =
        spec.shape === "retiring"
          ? sql.json(
              (row.value as RetiringEntry[]).map((e, i) => ({
                ...e,
                ciphertext: fresh[i]!,
              })) as never,
            )
          : fresh[0]!
      const old =
        spec.shape === "retiring"
          ? sql`${sql.json(row.value as never)}::jsonb`
          : sql`${row.value as string}`
      const updated = await sql`
        update ${sql(spec.table)} set ${sql(spec.column)} = ${next}
         where ${sql(spec.row)}::text = ${row.row_id}
           and tenant_id::text = ${row.tenant_id}
           and ${sql(spec.column)} = ${old}`
      if (updated.count === 1) report.resealed++
      else report.skipped++
    }
  }
  return reports
}

function print(reports: ColumnReport[], heading: string) {
  console.log(`\n${heading}`)
  for (const r of reports) {
    const kids = Object.entries(r.kids)
      .map(([kid, n]) => `${kid}=${n}`)
      .join(" ")
    console.log(
      `  ${r.purpose}: [${kids}] null=${r.nulls} failed=${r.failed.length}` +
        (r.resealed || r.skipped ? ` resealed=${r.resealed} skipped=${r.skipped}` : ""),
    )
    for (const f of r.failed)
      console.log(`    does not open: tenant ${f.tenantId} row ${f.rowId}`)
  }
}

if (import.meta.main) {
  const apply = process.argv.includes("--apply")
  const url = process.env.MIGRATE_DATABASE_URL
  const box = sealerFromEnv({ SEAL_KEYS: process.env.SEAL_KEYS })
  if (!url) {
    console.error(
      "MIGRATE_DATABASE_URL is required: the owner role, which sees every workspace",
    )
    process.exit(1)
  }
  if (!box) {
    console.error("SEAL_KEYS is required")
    process.exit(1)
  }

  const sql = postgres(url, { max: 2, onnotice: () => {} })
  try {
    const first = await resealSecrets(sql, box, { apply })
    print(
      first,
      apply ? "re-sealed" : `dry run (current key ${box.currentKid}; --apply writes)`,
    )
    // After writing, read everything again: the report that decides the exit
    // code is what is in the database now, not what this run meant to do.
    const final = apply ? await resealSecrets(sql, box, { apply: false }) : first
    if (apply) print(final, "after")
    const failed = final.some((r) => r.failed.length > 0)
    if (failed) console.error("\nsome values do not open; see the row ids above")
    process.exitCode = failed ? 1 : 0
  } finally {
    await sql.end({ timeout: 5 })
  }
}
