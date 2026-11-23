/* eslint-disable turbo/no-undeclared-env-vars -- run by hand, never a turbo task */
/**
 * Production planner statistics without production rows.
 *
 *   export  `pg_dump --statistics-only` of core, identity and authd (PostgreSQL 18)
 *   scrub   every real value replaced (scrub.ts); the mapping stays in memory
 *   load    into an empty, migrated twin: `pg_restore_relation_stats` and
 *           `pg_restore_attribute_stats`, then PAD the files (below)
 *   compare the registry's statements planned on the source and on the twin
 *
 * ⚠ RESTORED STATISTICS ALONE DO NOT REPRODUCE A PLAN. The planner reads a heap's
 * size from the file, not from `pg_class.relpages` (table_block_relation_estimate_size:
 * an empty file is estimated at 0 rows whatever `reltuples` says), and an index's
 * page count likewise. Measured 2026-11-21 on this harness: a 200,000 row table's
 * twin planned `rows=1` from the same statistics. So `pad` extends every table and
 * index file of the twin to its restored `relpages` with a SPARSE `truncate -s`:
 * the pages are all zeros (Postgres reads a never-initialised page as empty), use no
 * disk, and make the planner see the source's sizes. The twin runs with autovacuum
 * off so nothing rewrites them. A twin is for planning only: it has no rows.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import postgres, { type Sql } from "postgres"
import { capture, type Statement } from "./capture.js"
import { REPO } from "./go-sql.js"
import { shapeOf, type ExplainRoot } from "./plan.js"
import { Pickers } from "./pickers.js"
import { REGISTRY } from "./registry.js"
import { ensurePastPartitions } from "./seed-mail.js"
import {
  columnKey,
  kindFor,
  leaks,
  scrub,
  type ColumnKinds,
  type Mapping,
  type ScrubResult,
} from "./scrub.js"
import { directUrl, pgName, poolerUrl, up, type Scratch } from "./scratch.js"

const SCHEMAS = ["core", "identity", "authd"]
const PG_DUMP = process.env.PG_DUMP ?? "pg_dump"
const SEGMENT_BLOCKS = 131_072 // 1 GB of 8 KB blocks: Postgres splits relation files there

export async function exportStats(url: string): Promise<string> {
  const args = [
    PG_DUMP,
    "--statistics-only",
    ...SCHEMAS.flatMap((s) => ["--schema", s]),
    "--dbname",
    url,
  ]
  const r = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" })
  if (r.exitCode !== 0) throw new Error(`pg_dump: ${r.stderr.toString()}`)
  return r.stdout.toString()
}

/**
 * How the scrubber treats each column, from the source's catalog. A text column
 * whose CHECK constraint fixes its vocabulary (`status in ('active', ...)`) is
 * kept: those words are the schema's, and SQL compares them as literals.
 */
export async function columnKinds(
  sql: Sql,
): Promise<{ kinds: ColumnKinds; attnames: Map<string, string> }> {
  const rows = await sql<
    {
      schema: string
      rel: string
      att: string
      attnum: number
      cat: string
      typ: string
      ecat: string | null
      etyp: string | null
      vocab: boolean
      isindex: boolean
    }[]
  >`
    select n.nspname as schema, c.relname as rel, a.attname as att, a.attnum, t.typcategory as cat, t.typname as typ,
           et.typcategory as ecat, et.typname as etyp, c.relkind = 'i' or c.relkind = 'I' as isindex,
           exists (select 1 from pg_constraint k where k.conrelid = c.oid and k.contype = 'c' and k.conkey = array[a.attnum]
                    and pg_get_constraintdef(k.oid) ~ '= ANY \\(ARRAY\\[') as vocab
      from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
      join pg_type t on t.oid = a.atttypid left join pg_type et on et.oid = t.typelem and t.typcategory = 'A'
     where n.nspname = any(${SCHEMAS}) and a.attnum > 0 and not a.attisdropped`
  const kinds = new Map<
    string,
    { kind: ReturnType<typeof kindFor>["kind"]; array: boolean }
  >()
  const attnames = new Map<string, string>()
  for (const r of rows) {
    const k = kindFor(r.cat, r.typ, r.ecat, r.etyp)
    kinds.set(
      columnKey(r.schema, r.rel, r.att),
      r.vocab ? { kind: "keep", array: k.array } : k,
    )
    if (r.isindex) attnames.set(`${r.schema}.${r.rel}.${r.attnum}`, r.att)
  }
  return { kinds, attnames }
}

export async function scrubFrom(
  source: Sql,
  dump: string,
): Promise<{ result: ScrubResult; kinds: ColumnKinds }> {
  const { kinds, attnames } = await columnKinds(source)
  const result = scrub(dump, kinds, (s, r, n) => attnames.get(`${s}.${r}.${n}`))
  return { result, kinds }
}

/** Loads scrubbed statistics into the twin. Plans still see empty files until `pad`. */
export async function loadStats(twin: Scratch, scrubbed: string): Promise<void> {
  const sql = postgres(directUrl(twin), { max: 1, onnotice: () => {} })
  try {
    // psql meta-commands (`\restrict`) are not SQL; everything else is.
    await sql.unsafe(
      scrubbed
        .split("\n")
        .filter((l) => !l.startsWith("\\"))
        .join("\n"),
    )
  } finally {
    await sql.end()
  }
}

/** Extends every table and index file of the twin to its restored size, sparsely (see the header). */
export async function pad(
  twin: Scratch,
): Promise<{ relations: number; paddedBytes: number }> {
  const sql = postgres(directUrl(twin), { max: 1, onnotice: () => {} })
  try {
    await sql`checkpoint`
    const rels = await sql<{ path: string; pages: number }[]>`
      select pg_relation_filepath(c.oid) as path, c.relpages as pages
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = any(${SCHEMAS}) and c.relkind in ('r', 'i', 'm', 't') and c.relpages > 0`
    let paddedBytes = 0
    const commands: string[] = []
    for (const r of rels) {
      for (let seg = 0; seg * SEGMENT_BLOCKS < r.pages; seg++) {
        const blocks = Math.min(SEGMENT_BLOCKS, r.pages - seg * SEGMENT_BLOCKS)
        const file = `/tmp/pgdata/${r.path}${seg === 0 ? "" : `.${seg}`}`
        // Never shrink: a file already longer (an index metapage) stays as it is.
        commands.push(
          `[ $(stat -c %s ${file} 2>/dev/null || echo 0) -ge ${blocks * 8192} ] || truncate -s ${blocks * 8192} ${file}`,
        )
        paddedBytes += blocks * 8192
      }
    }
    const r = Bun.spawnSync(
      [
        "docker",
        "exec",
        "-u",
        "postgres",
        pgName(twin),
        "bash",
        "-c",
        commands.join("\n") || "true",
      ],
      { stderr: "pipe" },
    )
    if (r.exitCode !== 0) throw new Error(`padding: ${r.stderr.toString()}`)
    return { relations: rels.length, paddedBytes }
  } finally {
    await sql.end()
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A parameter as the twin should see it: real values translated by the scrub
 * mapping. A uuid-shaped string goes only through the uuid map (the same id may
 * also be text somewhere); literal syntax (`{...}`, `[...]`) and enum labels
 * (`failed` is a delivery status and also free text in another table) are never
 * mapped.
 */
export function mapParam(
  v: unknown,
  m: Mapping,
  labels: ReadonlySet<string> = new Set(),
): unknown {
  if (typeof v === "string") {
    if (UUID.test(v)) return m.uuid.get(v) ?? v
    if (/^[{[]/.test(v) || labels.has(v)) return v
    return m.text.get(v) ?? v
  }
  if (Array.isArray(v)) return v.map((x) => mapParam(x, m, labels))
  return v
}

async function plan(
  url: string,
  statements: Statement[],
  k: number,
  map: (v: unknown) => unknown,
): Promise<ExplainRoot> {
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} })
  const r = await sql.reserve()
  try {
    await r.unsafe("begin")
    // Only the tenant context: plans, not results, so the earlier writes are not replayed.
    for (const s of statements.slice(0, k))
      if (s.kind === "context") await r.unsafe(s.sql, s.params.map(map) as never[])
    const s = statements[k]!
    const [row] = await r.unsafe(
      `explain (format json) ${s.sql}`,
      s.params.map(map) as never[],
    )
    const p = (row as Record<string, unknown>)["QUERY PLAN"]
    return (Array.isArray(p) ? p[0] : JSON.parse(String(p))[0]) as ExplainRoot
  } finally {
    await r.unsafe("rollback").catch(() => {})
    r.release()
    await sql.end()
  }
}

/**
 * The earliest monthly partition the statistics name (`messages_2026_05`), so a
 * twin can be given the same partitions: statistics are per partition.
 */
export function firstPartition(dump: string): Date | null {
  let first: Date | null = null
  for (const m of dump.matchAll(/'relname', 'messages_(\d{4})_(\d{2})'/g)) {
    const at = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1))
    if (!first || at < first) first = at
  }
  return first
}

/** Gives the twin the dump's partitions, then loads the (scrubbed) statistics. */
export async function prepareTwin(twin: Scratch, scrubbed: string): Promise<void> {
  const from = firstPartition(scrubbed)
  if (from) {
    const sql = postgres(directUrl(twin), { max: 1, onnotice: () => {} })
    try {
      await ensurePastPartitions(sql, from)
    } finally {
      await sql.end()
    }
  }
  await loadStats(twin, scrubbed)
}

/**
 * `stats-export`: the scrubbed statistics of any database, to a file. Read-only
 * on the source (pg_dump and two catalog queries). ⚠ THE RAW DUMP NEVER TOUCHES
 * DISK: it is scrubbed in memory, and nothing is written if a value leaked.
 */
export async function exportScrubbed(o: {
  source: string
  out: string
  log: (m: string) => void
}): Promise<void> {
  const sql = postgres(o.source, { max: 1, onnotice: () => {} })
  try {
    const { result, kinds } = await scrubFrom(sql, await exportStats(o.source))
    const leaked = leaks(result, kinds)
    if (leaked.length)
      throw new Error(
        `refusing to write: ${leaked.length} original values survived the scrub`,
      )
    writeFileSync(o.out, result.sql)
    o.log(
      `wrote ${o.out}: ${result.scrubbed.length} columns generated, ${result.dropped.length} value lists dropped, ${result.originals.length} values replaced, 0 leaked`,
    )
  } finally {
    await sql.end()
  }
}

/** `stats-load`: a fresh twin (migrated, autovacuum off) with the statistics loaded and padded. */
export async function loadScrubbed(o: {
  twin: Scratch
  file: string
  log: (m: string) => void
}): Promise<void> {
  await up(o.twin, { postgresArgs: ["autovacuum=off"] })
  await prepareTwin(o.twin, readFileSync(o.file, "utf8"))
  const padded = await pad(o.twin)
  o.log(
    `twin ready on ${directUrl(o.twin)}: ${padded.relations} relations padded to ${(padded.paddedBytes / 2 ** 30).toFixed(2)} GiB (sparse); plan only, never write to it`,
  )
}

export interface Comparison {
  entry: string
  case: string
  statement: number
  same: boolean
  source: string
  twin: string
  sourceRows: number
  twinRows: number
  error: string | null
}

export async function roundTrip(o: {
  source: Scratch
  twin: Scratch
  out?: string
  log: (m: string) => void
}): Promise<void> {
  const date = new Date().toISOString().slice(0, 10)
  o.log("twin: migrating an empty database, autovacuum off")
  await up(o.twin, { postgresArgs: ["autovacuum=off"] })
  const owner = postgres(directUrl(o.source), { max: 2, onnotice: () => {} })
  try {
    const dump = await exportStats(directUrl(o.source))
    const { result, kinds } = await scrubFrom(owner, dump)
    const leaked = leaks(result, kinds)
    o.log(
      `scrubbed ${result.scrubbed.length} columns, dropped values of ${result.dropped.length}, ${result.originals.length} originals replaced, ${leaked.length} leaked`,
    )
    if (leaked.length)
      throw new Error(
        `scrub leaked ${leaked.length} values, first: ${leaked.slice(0, 3).join(", ")}`,
      )
    await prepareTwin(o.twin, result.sql)

    const volatile = new Set(
      (
        await owner<
          { f: string }[]
        >`select n.nspname || '.' || p.proname f from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.provolatile = 'v'`
      ).map((r) => r.f),
    )
    const pickers = new Pickers(owner)
    const labels = new Set(
      (await owner<{ l: string }[]>`select enumlabel as l from pg_enum`).map(
        (r) => r.l,
      ),
    )
    const captured: {
      entry: string
      case: string
      role: "i10_api" | "authd"
      statements: Statement[]
    }[] = []
    for (const e of REGISTRY) {
      for (const c of e.cases) {
        let arg: unknown
        try {
          arg = await c.arg(pickers)
        } catch {
          continue
        }
        const cap = await capture(poolerUrl(o.source, e.role), volatile, (ctx) =>
          e.run(ctx, arg),
        )
        captured.push({
          entry: e.name,
          case: c.name,
          role: e.role,
          statements: cap.statements,
        })
      }
    }
    const compareAll = async (): Promise<Comparison[]> => {
      const out: Comparison[] = []
      for (const c of captured) {
        for (const [k, s] of c.statements.entries()) {
          if (s.kind === "context") continue
          const n = c.statements
            .slice(0, k + 1)
            .filter((x) => x.kind !== "context").length
          try {
            const a = await plan(poolerUrl(o.source, c.role), c.statements, k, (v) => v)
            const b = await plan(directUrl(o.twin, c.role), c.statements, k, (v) =>
              mapParam(v, result.mapping, labels),
            )
            const sa = shapeOf(a.Plan)
            const sb = shapeOf(b.Plan)
            out.push({
              entry: c.entry,
              case: c.case,
              statement: n,
              same: sa === sb,
              source: sa,
              twin: sb,
              sourceRows: a.Plan["Plan Rows"] ?? 0,
              twinRows: b.Plan["Plan Rows"] ?? 0,
              error: null,
            })
          } catch (err) {
            out.push({
              entry: c.entry,
              case: c.case,
              statement: n,
              same: false,
              source: "",
              twin: "",
              sourceRows: 0,
              twinRows: 0,
              error: (err as Error).message,
            })
          }
        }
      }
      return out
    }
    const unpadded = await compareAll()
    o.log(
      `before padding: ${unpadded.filter((r) => r.same).length} of ${unpadded.length} statements plan the same on the twin`,
    )
    const loaded = await pad(o.twin)
    o.log(
      `padded ${loaded.relations} relations to ${(loaded.paddedBytes / 2 ** 30).toFixed(2)} GiB (sparse)`,
    )
    const out = await compareAll()
    o.log(
      `after padding: ${out.filter((r) => r.same).length} of ${out.length} statements plan the same on the twin`,
    )
    const dir = o.out ?? join(REPO, "docs", "research", "db-scale")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `stats-roundtrip-${date}.md`),
      renderRoundTrip(
        out,
        unpadded.filter((r) => r.same).length,
        result,
        leaked,
        loaded,
        date,
      ),
    )
  } finally {
    await owner.end()
  }
}

const cell = (v: unknown) => String(v ?? "").replace(/\|/g, "\\|")

function renderRoundTrip(
  rows: Comparison[],
  sameUnpadded: number,
  r: ScrubResult,
  leaked: string[],
  loaded: { relations: number; paddedBytes: number },
  date: string,
): string {
  const same = rows.filter((x) => x.same).length
  const lines = [
    `# Scrubbed statistics round trip, ${date}`,
    "",
    "Generated by `bun scripts/scale/cli.ts stats-roundtrip` (apps/api): planner statistics exported from the seeded database, scrubbed, loaded into an empty migrated twin whose files were padded to the restored sizes, and every registry statement planned on both. See [README.md](README.md).",
    "",
    "## Result",
    "",
    `- Plans with the same shape on the twin: **${same} of ${rows.length}** (${sameUnpadded} of ${rows.length} before the files were padded, statistics alone).`,
    `- Columns whose values were generated: ${r.scrubbed.length}; columns whose value lists were dropped: ${r.dropped.length}; original values replaced: ${r.originals.length}.`,
    `- Original values found in the scrubbed statistics: **${leaked.length}**.`,
    `- Relations padded: ${loaded.relations}, ${(loaded.paddedBytes / 2 ** 30).toFixed(2)} GiB of sparse files.`,
    "",
    "## Statements whose plan differs",
    "",
    "| Entry | Case | # | Source plan | Twin plan | Rows (source / twin) |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows
      .filter((x) => !x.same)
      .map(
        (x) =>
          `| ${cell(x.entry)} | ${cell(x.case)} | ${x.statement} | ${cell(x.error ?? x.source)} | ${cell(x.twin)} | ${x.sourceRows} / ${x.twinRows} |`,
      ),
    "",
    "## Columns whose value lists were dropped",
    "",
    r.dropped.map((d) => `\`${d}\``).join(", ") || "None.",
    "",
  ]
  return lines.join("\n")
}
