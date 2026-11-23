/**
 * The measurement run: every registry entry, every case, every statement the
 * code path sent, through PgBouncer in transaction mode as the role production
 * uses.
 *
 * For each statement:
 *   1. one `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)` (VERBOSE for the
 *      schema of every relation), with auto_explain switched
 *      on for that transaction only, so the statements INSIDE a SQL or
 *      SECURITY DEFINER function are planned too (EXPLAIN alone shows a function
 *      call as one opaque node);
 *   2. one warm-up, then timed executions, each in its own transaction that is
 *      rolled back, so a write measured a hundred times writes nothing.
 * The statements the path ran before it (its tenant context and earlier writes)
 * are replayed first in the same transaction, so each one sees the state the
 * real path gave it.
 *
 * Then: index use (`pg_stat_user_indexes`, reset at the start), duplicate
 * indexes, table and index sizes, and `pg_stat_statements` by total time.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import postgres, { type Sql } from "postgres"
import { capture, type Statement } from "./capture.js"
import { REPO } from "./go-sql.js"
import {
  analyse,
  nestedPlan,
  percentile,
  type Analysis,
  type ExplainRoot,
} from "./plan.js"
import { Pickers } from "./pickers.js"
import { REGISTRY, type Entry } from "./registry.js"
import { directUrl, poolerUrl, type Scratch } from "./scratch.js"
import { renderReport } from "./report.js"

export interface MeasureOptions {
  scratch: Scratch
  runs: number
  only?: string
  out?: string
  log: (m: string) => void
}

export interface Measurement {
  entry: string
  area: string
  case: string
  site: string
  source: string
  frequency: string
  role: string
  statement: number
  kind: string
  sql: string
  params: string
  runs: number
  p50: number
  p95: number
  max: number
  analysis: Analysis | null
  nested: { query: string; calls: number; analysis: Analysis }[]
  expectation: string | null
  error: string | null
}

const AUTO_EXPLAIN_ON = [
  "set local auto_explain.log_min_duration = 0",
  "set local auto_explain.log_analyze = on",
  "set local auto_explain.log_buffers = on",
  "set local auto_explain.log_timing = on",
  "set local auto_explain.log_verbose = on",
  "set local auto_explain.log_nested_statements = on",
  "set local auto_explain.log_format = 'json'",
  "set local auto_explain.log_level = 'notice'",
]

/** The line the anchor text is on, so the report's call sites cannot go stale. */
export function siteOf(e: Entry): string {
  const src = readFileSync(join(REPO, e.site.file), "utf8")
  const at = src.indexOf(e.site.anchor)
  if (at < 0)
    throw new Error(`${e.name}: anchor "${e.site.anchor}" not in ${e.site.file}`)
  return `${e.site.file}:${src.slice(0, at).split("\n").length}`
}

const shortParams = (params: unknown[]) =>
  JSON.stringify(params, (_, v) =>
    typeof v === "string" && v.length > 80 ? `${v.slice(0, 77)}...` : v,
  ).slice(0, 400)

async function volatileFunctions(sql: Sql): Promise<Set<string>> {
  const rows = await sql<{ f: string }[]>`
    select n.nspname || '.' || p.proname as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('core', 'identity', 'authd') and p.provolatile = 'v'`
  return new Set(rows.map((r) => r.f))
}

async function relationSizes(sql: Sql): Promise<Map<string, number>> {
  const rows = await sql<{ r: string; n: number }[]>`
    select n.nspname || '.' || c.relname as r, greatest(c.reltuples, 0)::float8 as n
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('core', 'identity', 'authd') and c.relkind in ('r', 'p')`
  return new Map(rows.map((r) => [r.r, Number(r.n)]))
}

/** Replays the path up to statement `k` in one transaction, then runs `k` with `run`. */
async function inTransaction<T>(
  client: Sql,
  statements: Statement[],
  k: number,
  run: (r: postgres.ReservedSql, s: Statement) => Promise<T>,
): Promise<T> {
  const r = await client.reserve()
  try {
    await r.unsafe("begin")
    await r.unsafe("set local statement_timeout = '120s'")
    for (const s of statements.slice(0, k)) {
      if (s.kind !== "read") await r.unsafe(s.sql, s.params as never[])
    }
    return await run(r, statements[k]!)
  } finally {
    await r.unsafe("rollback").catch(() => {})
    r.release()
  }
}

async function measureStatement(
  url: string,
  statements: Statement[],
  k: number,
  runs: number,
  sizes: Map<string, number>,
): Promise<
  Pick<Measurement, "runs" | "p50" | "p95" | "max" | "analysis" | "nested" | "error">
> {
  const notices: string[] = []
  const client = postgres(url, {
    max: 1,
    prepare: false,
    onnotice: (n) => notices.push(n.message ?? ""),
    connect_timeout: 10,
  })
  try {
    const stmt = statements[k]!
    let root: ExplainRoot | null = null
    let error: string | null = null
    try {
      root = await inTransaction(client, statements, k, async (r, s) => {
        for (const set of AUTO_EXPLAIN_ON) await r.unsafe(set)
        notices.length = 0
        const [row] = await r.unsafe(
          `explain (analyze, buffers, verbose, format json) ${s.sql}`,
          s.params as never[],
        )
        const plan = (row as Record<string, unknown>)["QUERY PLAN"]
        return (
          Array.isArray(plan) ? plan[0] : JSON.parse(String(plan))[0]
        ) as ExplainRoot
      })
    } catch (err) {
      error = `explain: ${(err as Error).message}`
    }
    const nestedByQuery = new Map<
      string,
      { calls: number; root: ExplainRoot; worst: number }
    >()
    for (const n of notices) {
      const p = nestedPlan(n)
      if (!p || p.query.trim() === stmt.sql.trim() || p.query.startsWith("explain"))
        continue
      const prev = nestedByQuery.get(p.query)
      const time = p.root["Execution Time"] ?? 0
      if (!prev)
        nestedByQuery.set(p.query, { calls: 1, root: p.root, worst: Number(time) })
      else {
        prev.calls++
        if (Number(time) > prev.worst)
          Object.assign(prev, { root: p.root, worst: Number(time) })
      }
    }
    const times: number[] = []
    if (!error) {
      try {
        const once = async () =>
          inTransaction(client, statements, k, async (r, s) => {
            const t0 = performance.now()
            await r.unsafe(s.sql, s.params as never[])
            return performance.now() - t0
          })
        const warm = await once()
        // A slow statement gets fewer runs, so the whole pass stays bounded.
        const n = warm > 2000 ? 3 : warm > 200 ? Math.min(runs, 10) : runs
        for (let i = 0; i < n; i++) times.push(await once())
      } catch (err) {
        error = `timing: ${(err as Error).message}`
      }
    }
    times.sort((a, b) => a - b)
    return {
      runs: times.length,
      p50: percentile(times, 50),
      p95: percentile(times, 95),
      max: times.at(-1) ?? 0,
      analysis: root ? analyse(root, sizes) : null,
      nested: [...nestedByQuery.entries()].map(([query, v]) => ({
        query,
        calls: v.calls,
        analysis: analyse(v.root, sizes),
      })),
      error,
    }
  } finally {
    await client.end({ timeout: 2 })
  }
}

export async function measure(o: MeasureOptions): Promise<Measurement[]> {
  const owner = postgres(directUrl(o.scratch), { max: 2, onnotice: () => {} })
  const date = new Date().toISOString().slice(0, 10)
  const outDir = o.out ?? join(REPO, "docs", "research", "db-scale")
  mkdirSync(outDir, { recursive: true })
  try {
    const volatile = await volatileFunctions(owner)
    const sizes = await relationSizes(owner)
    const pickers = new Pickers(owner)
    await owner`select pg_stat_reset()`
    await owner`select pg_stat_statements_reset()`

    const results: Measurement[] = []
    const entries = REGISTRY.filter((e) => !o.only || e.name.startsWith(o.only))
    for (const e of entries) {
      const site = siteOf(e)
      const url = poolerUrl(o.scratch, e.role)
      for (const c of e.cases) {
        const base = {
          entry: e.name,
          area: e.area,
          case: c.name,
          site,
          source: e.source,
          frequency: e.frequency,
          role: e.role,
        }
        let arg: unknown
        try {
          arg = await c.arg(pickers)
        } catch (err) {
          results.push({
            ...base,
            statement: 0,
            kind: "-",
            sql: "",
            params: "",
            runs: 0,
            p50: 0,
            p95: 0,
            max: 0,
            analysis: null,
            nested: [],
            expectation: null,
            error: `picker: ${(err as Error).message}`,
          })
          continue
        }
        const cap = await capture(url, volatile, (ctx) => e.run(ctx, arg))
        const expectation = cap.error ? null : (c.expect?.(cap.result) ?? null)
        const measured = cap.statements
          .map((s, k) => [s, k] as const)
          .filter(([s]) => s.kind !== "context")
        if (measured.length === 0) {
          results.push({
            ...base,
            statement: 0,
            kind: "-",
            sql: "",
            params: "",
            runs: 0,
            p50: 0,
            p95: 0,
            max: 0,
            analysis: null,
            nested: [],
            expectation,
            error: cap.error ?? "the path sent no statement",
          })
        }
        for (const [i, [s, k]] of measured.entries()) {
          const m = await measureStatement(url, cap.statements, k, o.runs, sizes)
          results.push({
            ...base,
            statement: i + 1,
            kind: s.kind,
            sql: s.sql.replace(/\s+/g, " ").trim(),
            params: shortParams(s.params),
            ...m,
            expectation: i === 0 ? expectation : null,
            error: m.error ?? (i === 0 ? cap.error : null),
          })
          o.log(
            `${e.name} [${c.name}] #${i + 1}: p50 ${m.p50.toFixed(2)} ms, p95 ${m.p95.toFixed(2)} ms${m.analysis?.flags.length ? `, ${m.analysis.flags.length} flags` : ""}${m.error ? `, ${m.error}` : ""}`,
          )
        }
      }
    }

    const extras = await databaseFacts(owner)
    writeFileSync(join(outDir, `measure-${date}.csv`), toCsv(results))
    writeFileSync(
      join(outDir, `plans-${date}.jsonl`),
      results
        .map((r) =>
          JSON.stringify({
            entry: r.entry,
            case: r.case,
            statement: r.statement,
            sql: r.sql,
            analysis: r.analysis,
            nested: r.nested,
          }),
        )
        .join("\n") + "\n",
    )
    writeFileSync(
      join(outDir, `report-${date}.md`),
      renderReport(results, extras, { date }),
    )
    o.log(`wrote ${outDir}/{measure,plans,report}-${date}.*`)
    return results
  } finally {
    await owner.end({ timeout: 5 })
  }
}

/**
 * ⚠ NO BACKSLASH CLASSES (`\d`, `\s`) IN THESE TAGGED TEMPLATES. A tagged
 * template's cooked text drops the backslash, so `'\s+'` reached Postgres as
 * `'s+'` and stripped every letter s from the report. POSIX classes only.
 */
export interface DatabaseFacts {
  sizes: {
    relation: string
    rows: number
    table: string
    indexes: string
    total: string
  }[]
  unusedIndexes: { index: string; table: string; size: string; unique: boolean }[]
  duplicateIndexes: { index: string; covers: string; reason: string }[]
  topStatements: {
    query: string
    calls: number
    total_ms: number
    mean_ms: number
    rows: number
  }[]
  server: { version: string; sharedBuffers: string; workMem: string }
}

async function databaseFacts(sql: Sql): Promise<DatabaseFacts> {
  const sizes = await sql<DatabaseFacts["sizes"]>`
    select n.nspname || '.' || c.relname as relation, greatest(c.reltuples, 0)::bigint::int as rows,
           pg_size_pretty(sum(pg_table_size(p.oid))) as table, pg_size_pretty(sum(pg_indexes_size(p.oid))) as indexes,
           pg_size_pretty(sum(pg_total_relation_size(p.oid))) as total
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      cross join lateral (select c.oid union all select i.inhrelid from pg_inherits i where i.inhparent = c.oid) p(oid)
     where n.nspname in ('core', 'identity', 'authd') and c.relkind in ('r', 'p') and not c.relispartition
     group by 1, 2, c.oid
     order by sum(pg_total_relation_size(p.oid)) desc limit 25`
  // A partitioned table's rows are its partitions'.
  for (const s of sizes) {
    if (s.rows === 0) {
      const [r] = await sql.unsafe<{ n: number }[]>(
        `select coalesce(sum(c.reltuples), 0)::bigint::int as n from pg_inherits i join pg_class c on c.oid = i.inhrelid where i.inhparent = '${s.relation}'::regclass`,
      )
      s.rows = r?.n ?? 0
    }
  }
  const unusedIndexes = await sql<DatabaseFacts["unusedIndexes"]>`
    select s.schemaname || '.' || s.indexrelname as index, s.schemaname || '.' || s.relname as table,
           pg_size_pretty(pg_relation_size(s.indexrelid)) as size, i.indisunique as unique
      from pg_stat_user_indexes s join pg_index i on i.indexrelid = s.indexrelid
     where s.schemaname in ('core', 'identity', 'authd') and s.idx_scan = 0
       and s.relname !~ '_([0-9]{4}_[0-9]{2}|default)$'
     order by pg_relation_size(s.indexrelid) desc limit 40`
  const duplicateIndexes = await sql<DatabaseFacts["duplicateIndexes"]>`
    with ix as (
      select i.indexrelid, i.indrelid, i.indisunique, i.indkey::text as keys, coalesce(pg_get_expr(i.indpred, i.indrelid), '') as pred,
             coalesce(pg_get_expr(i.indexprs, i.indrelid), '') as exprs, c.relname as name, n.nspname as schema
        from pg_index i join pg_class c on c.oid = i.indexrelid join pg_namespace n on n.oid = c.relnamespace
       where n.nspname in ('core', 'identity', 'authd') and c.relname !~ '_([0-9]{4}_[0-9]{2}|default)'
    )
    select a.schema || '.' || a.name as index, b.schema || '.' || b.name as covers,
           case when a.keys = b.keys then 'same columns' else 'leading columns of the other' end as reason
      from ix a join ix b on a.indrelid = b.indrelid and a.indexrelid <> b.indexrelid
     where a.pred = b.pred and a.exprs = b.exprs and not a.indisunique
       and (a.keys = b.keys and a.indexrelid > b.indexrelid or b.keys like a.keys || ' %')
     order by 1`
  const topStatements = await sql<DatabaseFacts["topStatements"]>`
    select regexp_replace(left(query, 300), '[[:space:]]+', ' ', 'g') as query, calls::int, round(total_exec_time::numeric, 1)::float8 as total_ms,
           round(mean_exec_time::numeric, 3)::float8 as mean_ms, rows::int
      from pg_stat_statements s join pg_roles r on r.oid = s.userid
     where r.rolname in ('i10_api', 'authd') and query !~* '^(begin|rollback|set |explain|select set_config)'
     order by total_exec_time desc limit 20`
  const [server] = await sql<
    { version: string; sb: string; wm: string }[]
  >`select version() as version, current_setting('shared_buffers') sb, current_setting('work_mem') wm`
  return {
    sizes,
    unusedIndexes,
    duplicateIndexes,
    topStatements,
    server: {
      version: server!.version,
      sharedBuffers: server!.sb,
      workMem: server!.wm,
    },
  }
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function toCsv(rows: Measurement[]): string {
  const head = [
    "entry",
    "area",
    "case",
    "statement",
    "kind",
    "site",
    "source",
    "role",
    "frequency",
    "p50_ms",
    "p95_ms",
    "max_ms",
    "runs",
    "explain_exec_ms",
    "plan_ms",
    "rows",
    "shared_hit",
    "shared_read",
    "temp_written",
    "scans",
    "nested_calls",
    "flags",
    "expectation",
    "error",
    "shape",
    "params",
    "sql",
  ]
  const lines = rows.map((r) => {
    const a = r.analysis
    const nestedFlags = r.nested.flatMap((n) =>
      n.analysis.flags.map((f) => `inside function (${n.calls} calls): ${f}`),
    )
    return [
      r.entry,
      r.area,
      r.case,
      r.statement,
      r.kind,
      r.site,
      r.source,
      r.role,
      r.frequency,
      r.p50.toFixed(3),
      r.p95.toFixed(3),
      r.max.toFixed(3),
      r.runs,
      a?.executionMs.toFixed(3) ?? "",
      a?.planningMs.toFixed(3) ?? "",
      a?.rows ?? "",
      a?.sharedHit ?? "",
      a?.sharedRead ?? "",
      a?.tempWritten ?? "",
      a?.scans.join(" | ") ?? "",
      r.nested.reduce((s, n) => s + n.calls, 0),
      [...(a?.flags ?? []), ...nestedFlags].join(" | "),
      r.expectation ?? "",
      r.error ?? "",
      a?.shape ?? "",
      r.params,
      r.sql,
    ]
      .map(csvCell)
      .join(",")
  })
  return [head.join(","), ...lines].join("\n") + "\n"
}
