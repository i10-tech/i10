/** Deterministic catalog-derived edge values for the small scratch seed. */
import { writeFileSync } from "node:fs"
import type { Sql } from "postgres"
import { FIXTURE_TENANTS } from "./fixtures.js"
import { Pickers } from "./pickers.js"
import { Rng } from "./rng.js"

export type ChaosKey = Record<string, unknown>
export type ChaosRow = {
  table: string
  key: ChaosKey
  category: string
}

type Column = {
  schema: string
  table: string
  name: string
  type: string
  formatted: string
  nullable: boolean
  maxLength: number | null
  hasForeignKey: boolean
  primaryKey: boolean
  checks: string[]
}
type Candidate = { category: string; value: unknown; expression: string }
type Locator = {
  slot: number
  tid: string
  child: string
  row: Record<string, unknown>
  tenant: string | null
  bucket: string
}
type Outcome = {
  table: string
  column: string
  category: string
  status: "generated" | "protected" | "skipped"
  row?: Record<string, unknown>
  key?: ChaosKey
  reason?: string
}

const q = (s: string) => `"${s.replaceAll('"', '""')}"`
const relation = (schema: string, table: string) => `${q(schema)}.${q(table)}`
const corpusPath = (seed: number) => `/tmp/db-scale-chaos-${seed}.json`

async function catalog(sql: Sql): Promise<Column[]> {
  const rows = await sql<
    {
      schema: string
      table: string
      name: string
      type: string
      formatted: string
      nullable: boolean
      maxLength: number | null
      hasForeignKey: boolean
      primaryKey: boolean
      check: string | null
    }[]
  >`
    select n.nspname schema, c.relname table, a.attname name, t.typname type,
           format_type(a.atttypid, a.atttypmod) formatted, not a.attnotnull nullable,
           case when t.typname in ('varchar','bpchar') and a.atttypmod > 4 then a.atttypmod - 4 end "maxLength",
           exists(select 1 from pg_constraint f where f.conrelid=c.oid and f.contype='f' and a.attnum=any(f.conkey)) "hasForeignKey",
           exists(select 1 from pg_constraint p where p.conrelid=c.oid and p.contype='p' and a.attnum=any(p.conkey)) "primaryKey",
           pg_get_constraintdef(k.oid) check
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
      join pg_type t on t.oid=a.atttypid
      left join pg_constraint k on k.conrelid=c.oid and k.contype='c'
     where n.nspname in ('core','identity','authd') and c.relkind in ('r','p')
       and not c.relispartition
     order by n.nspname,c.relname,a.attnum`
  const grouped = new Map<string, Column>()
  for (const r of rows) {
    const id = `${r.schema}.${r.table}.${r.name}`
    const c: Column = grouped.get(id) ?? {
      schema: r.schema,
      table: r.table,
      name: r.name,
      type: r.type,
      formatted: r.formatted,
      nullable: r.nullable,
      maxLength: r.maxLength,
      hasForeignKey: r.hasForeignKey,
      primaryKey: r.primaryKey,
      checks: [],
    }
    if (r.check) c.checks.push(r.check)
    grouped.set(id, c)
  }
  return [...grouped.values()]
}

function candidates(c: Column, rng: Rng, boundaries: string[]): Candidate[] {
  const out: Candidate[] = []
  if (c.nullable) out.push({ category: "nullable", value: null, expression: "null" })
  const typ = c.type
  if (!c.hasForeignKey && !c.primaryKey && c.name.endsWith("_id")) {
    if (typ === "uuid")
      out.push({
        category: "orphan-logical-parent",
        value: rng.uuid4(),
        expression: "text",
      })
    else if (["text", "varchar", "bpchar"].includes(typ))
      out.push({
        category: "orphan-logical-parent",
        value: `chaos-missing-${rng.token(8)}`,
        expression: "text",
      })
  }
  const fieldChecks = c.checks.filter((check) =>
    new RegExp(
      `(^|[^a-z0-9_])"?${c.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?([^a-z0-9_]|$)`,
      "i",
    ).test(check),
  )
  const constrained = fieldChecks.join(" ").toLowerCase()
  if (["text", "varchar", "bpchar", "citext"].includes(typ)) {
    if (fieldChecks.length === 0) {
      out.push({ category: "empty-string", value: "", expression: "text" })
      out.push({ category: "whitespace-string", value: " \t\n ", expression: "text" })
    }
    if (
      fieldChecks.length === 0 &&
      ["status", "kind", "type", "state", "mode"].includes(c.name)
    )
      out.push({
        category: "unknown-status-kind",
        value: `chaos_${c.name}`,
        expression: "text",
      })
    const checkMax = fieldChecks
      .join(" ")
      .match(/(?:length|char_length)\s*\([^)]*\)\s*<=\s*(\d+)/i)
    const max = c.maxLength ?? (checkMax ? Number(checkMax[1]) : null)
    if (max && max < 200_000)
      out.push({
        category: "maximum-length",
        value: "x".repeat(max),
        expression: "text",
      })
    else if (!max)
      out.push({
        category: "very-long-text",
        value: "x".repeat(32_768 + rng.int(0, 2047)),
        expression: "text",
      })
  } else if (typ === "jsonb" || typ === "json") {
    for (const [category, value] of [
      ["json-missing-keys", { chaos: true }],
      ["json-extra-keys", { ...{}, unknown: "extra" }],
      ["json-wrong-types", { type: 7, data: "wrong" }],
      ["json-null", null],
      ["json-empty-object", {}],
      ["json-empty-array", []],
    ] as const)
      out.push({ category, value, expression: "json" })
  } else if (["timestamp", "timestamptz", "date"].includes(typ)) {
    out.push({
      category: "timestamp-far-past",
      value: typ === "date" ? "0001-01-01" : "0001-01-01T00:00:00Z",
      expression: "text",
    })
    out.push({
      category: "timestamp-far-future",
      value: typ === "date" ? "9999-12-31" : "9999-12-31T23:59:59Z",
      expression: "text",
    })
    for (const value of boundaries)
      out.push({ category: "partition-boundary", value, expression: "text" })
  } else if (["int2", "int4", "int8", "numeric", "float4", "float8"].includes(typ)) {
    out.push({ category: "number-zero", value: 0, expression: "number" })
    if (!/\b(check|>=\s*0|>\s*0|between\s+0)/i.test(constrained))
      out.push({ category: "number-negative", value: -1, expression: "number" })
    const numeric = c.formatted.match(/^numeric\((\d+),\s*(\d+)\)$/)
    const nearLimit =
      typ === "int2"
        ? 32767
        : typ === "int4"
          ? 2147483647
          : typ === "int8"
            ? "9223372036854775807"
            : typ === "float4"
              ? "3.4028234e38"
              : typ === "float8"
                ? "1.7976931348623157e308"
                : numeric
                  ? `${"9".repeat(Number(numeric[1]) - Number(numeric[2]))}${Number(numeric[2]) ? `.${"9".repeat(Number(numeric[2]))}` : ""}`
                  : 999999999999
    out.push({ category: "number-near-limit", value: nearLimit, expression: "number" })
  }
  return out
}

async function partitionBoundaries(sql: Sql): Promise<string[]> {
  const rows = await sql<{ bound: string }[]>`
    select distinct pg_get_expr(c.relpartbound,c.oid) bound
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
     where n.nspname in ('core','identity','authd') and c.relispartition
       and pg_get_expr(c.relpartbound,c.oid) like 'FOR VALUES FROM%'
     order by 1`
  return [
    ...new Set(
      rows.flatMap(
        (r) => r.bound.match(/\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}:\d{2})?/g) ?? [],
      ),
    ),
  ]
}

function stableNumber(s: string): number {
  let n = 0
  for (const c of s) n = (Math.imul(n, 31) + c.charCodeAt(0)) >>> 0
  return n
}

async function preferredValues(sql: Sql, seed: number) {
  const pickers = new Pickers(sql)
  const tenants = [
    await pickers.hugeTenant(),
    await pickers.medianTenant(),
    await pickers.ssoTenant(),
    ...Object.values(FIXTURE_TENANTS),
  ]
  const tenantOrder = [...new Set(tenants)]
  const valueOrder = new Map<string, Set<string>>()
  const add = (table: string, value: unknown) => {
    if (typeof value !== "string" || !value) return
    const values = valueOrder.get(table) ?? new Set<string>()
    values.add(value)
    valueOrder.set(table, values)
  }
  const accountEmails = [
    await pickers.hugeAccount(),
    await pickers.ssoAccount(),
    ...(await pickers.manyAddresses()),
    "ceo@mixedcase.example",
    "all.gates@gates.example",
  ]
  for (const email of accountEmails) add("authd.accounts", email)
  add("authd.aliases", await pickers.aliasAddress())
  add("authd.groups", await pickers.hugeGroupEmail())
  add("authd.group_members", await pickers.busyMember())
  const messageTenantIds = [await pickers.hugeTenant(), await pickers.medianTenant()]
  for (const tenant of messageTenantIds) {
    const refs = [
      await pickers.recentMessage(tenant),
      await pickers.oldMessage(tenant),
      ...(await pickers.queuedRefs(tenant, 10)),
    ]
    for (const ref of refs) add("core.messages", ref.id)
  }
  const domains = [
    ...(await pickers.sendingDomains(await pickers.hugeTenant())),
    await pickers.hostedDomain(await pickers.ssoTenant()),
  ]
  for (const name of domains) add("core.domains", name)
  add("core.domains", "MixedCase.Example")
  add("core.domains", "mixedcase.example")
  const rng = new Rng(seed, 918)
  return { tenantOrder, valueOrder, salt: rng.int(0, 2 ** 20) }
}

type SourceRow = { tid: string; child: string; row: Record<string, unknown> }

const SOURCE_ROWS = (rel: string) =>
  `select t.ctid::text tid, t.tableoid::regclass::text child, to_jsonb(t) row from ${rel} t`

/**
 * A table up to this size is read whole, so the small profile picks exactly the
 * rows it always has. Above it (the large profile's messages, events, deliveries
 * and attempts run to millions) only bounded slices are read: a column needs a
 * few dozen distinct rows, never the table.
 */
const FULL_LOAD_MAX = 20_000
/** Rows per preferred bucket, and the size of the spread sample, above FULL_LOAD_MAX. */
const PER_BUCKET = 64
const SAMPLE = 2_000

/** The first pages of each partition the spread sample is drawn from. */
const SAMPLE_PAGES = 64
const TEXT_TYPES = new Set(["text", "varchar", "bpchar", "citext"])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The rows `locatorsForTable` would prefer, without reading the whole table: up
 * to PER_BUCKET rows of each preferred tenant, up to PER_BUCKET rows holding a
 * looked-up value, and up to SAMPLE rows from the first SAMPLE_PAGES pages of each
 * partition as the pool the rest are drawn from.
 *
 * ⚠ PICK FIRST, THEN FETCH. Each slice picks row positions with no JSON built,
 * ordered by (partition, ctid) so the same seed picks the same rows, and only the
 * picked rows are turned into JSON, through a TID scan. Memory is bounded by the
 * LIMITs, and no slice builds JSON for a row it does not keep.
 */
async function boundedRows(
  sql: Sql,
  rel: string,
  cols: Column[],
  tenantOrder: string[],
  keyedValues: Set<string>,
): Promise<SourceRow[]> {
  const pick = (where: string, limit: number, params: unknown[] = []) =>
    sql.unsafe<SourceRow[]>(
      `with picked as materialized (
         select s.tableoid, s.ctid from ${rel} s where ${where}
          order by s.tableoid, s.ctid limit ${limit})
       ${SOURCE_ROWS(rel)}
        where t.ctid = any(array(select ctid from picked))
          and (t.tableoid, t.ctid) in (select tableoid, ctid from picked)
        order by t.tableoid, t.ctid`,
      params as never[],
    )
  const out: SourceRow[] = []
  if (cols.some((c) => c.name === "tenant_id" && c.type === "uuid"))
    for (const id of tenantOrder)
      out.push(...(await pick(`s.tenant_id = $1::uuid`, PER_BUCKET, [id])))
  if (keyedValues.size) {
    // The typed columns themselves, so an index on them can answer: never the
    // whole row exploded into JSON.
    const texts = [...keyedValues]
    const uuids = texts.filter((v) => UUID.test(v))
    const textCols = cols.filter((c) => TEXT_TYPES.has(c.type))
    const uuidCols = uuids.length ? cols.filter((c) => c.type === "uuid") : []
    // Numbered by use: Postgres refuses a parameter the statement never reads.
    const params: unknown[] = []
    const tests: string[] = []
    if (textCols.length) {
      params.push(texts)
      const n = params.length
      tests.push(...textCols.map((c) => `s.${q(c.name)} = any($${n}::text[])`))
    }
    if (uuidCols.length) {
      params.push(uuids)
      const n = params.length
      tests.push(...uuidCols.map((c) => `s.${q(c.name)} = any($${n}::uuid[])`))
    }
    if (tests.length)
      out.push(...(await pick(`(${tests.join(" or ")})`, PER_BUCKET, params)))
  }
  out.push(...(await pick(`s.ctid < '(${SAMPLE_PAGES},0)'::tid`, SAMPLE)))
  const seen = new Set<string>()
  return out.filter((r) => {
    const key = `${r.child}:${r.tid}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function locatorsForTable(
  sql: Sql,
  schema: string,
  table: string,
  cols: Column[],
  tenantOrder: string[],
  valueOrder: Map<string, Set<string>>,
  salt: number,
): Promise<Locator[]> {
  const rel = relation(schema, table)
  const [{ count } = { count: 0 }] = await sql.unsafe<{ count: number }[]>(
    // Counted only up to the cutoff: past it the exact size does not matter.
    `select count(*)::int count from (select 1 from ${rel} limit ${FULL_LOAD_MAX + 1}) x`,
  )
  if (!count) return []
  const keyedValues =
    valueOrder.get(`${schema}.${table}`) ?? valueOrder.get(table) ?? new Set<string>()
  const rows =
    count <= FULL_LOAD_MAX
      ? await sql.unsafe<SourceRow[]>(`${SOURCE_ROWS(rel)} order by t.ctid`)
      : await boundedRows(sql, rel, cols, tenantOrder, keyedValues)
  const preferred = new Map<string, Locator[]>()
  const tenantKeys = new Set(tenantOrder)
  const rest: Locator[] = []
  for (const r of rows) {
    const tenant = r.row.tenant_id == null ? null : String(r.row.tenant_id)
    let bucket = ""
    if (tenant && tenantKeys.has(tenant)) bucket = `tenant:${tenant}`
    else if (
      Object.values(r.row).some((v) => typeof v === "string" && keyedValues.has(v))
    )
      bucket = "lookup"
    const loc: Locator = {
      slot: -1,
      tid: r.tid,
      child: r.child,
      row: r.row,
      tenant,
      bucket,
    }
    if (bucket) {
      const list = preferred.get(bucket)
      if (list) list.push(loc)
      else preferred.set(bucket, [loc])
    } else rest.push(loc)
  }
  const orderedBuckets = [
    ...tenantOrder.map((tenant) => `tenant:${tenant}`),
    "lookup",
  ].filter((b, i, all) => all.indexOf(b) === i)
  const selected: Locator[] = []
  for (let offset = 0; ; offset++) {
    let found = false
    for (const bucket of orderedBuckets) {
      const row = preferred.get(bucket)?.[offset]
      if (row) {
        selected.push(row)
        found = true
      }
    }
    if (!found) break
  }
  rest.sort(
    (a, b) =>
      stableNumber(`${salt}:${a.child}:${a.tid}`) -
      stableNumber(`${salt}:${b.child}:${b.tid}`),
  )
  selected.push(...rest)
  return selected.map((loc, slot) => ({ ...loc, slot }))
}

function keyFrom(row: Record<string, unknown>, columns: Column[]): ChaosKey {
  return Object.fromEntries(
    columns.filter((c) => c.primaryKey).map((c) => [c.name, row[c.name]]),
  )
}

export async function seedChaos(sql: Sql, seed: number, log: (m: string) => void) {
  const started = Date.now()
  const rng = new Rng(seed, 907)
  const columns = await catalog(sql)
  const boundaries = await partitionBoundaries(sql)
  const preferred = await preferredValues(sql, seed)
  const byTable = new Map<string, Column[]>()
  for (const c of columns)
    byTable.set(`${c.schema}.${c.table}`, [
      ...(byTable.get(`${c.schema}.${c.table}`) ?? []),
      c,
    ])
  const outcomes: Outcome[] = []
  const chaosRows: ChaosRow[] = []
  for (const [qualified, cols] of byTable) {
    const [schema, table] = qualified.split(".") as [string, string]
    const locators = await locatorsForTable(
      sql,
      schema,
      table,
      cols,
      preferred.tenantOrder,
      preferred.valueOrder,
      preferred.salt,
    )
    for (const c of cols) {
      const options = candidates(c, rng, boundaries)
      if (!options.length) continue
      if (!locators.length) {
        for (const candidate of options)
          outcomes.push({
            table: qualified,
            column: c.name,
            category: candidate.category,
            status: "skipped",
            reason: "table has no source row",
          })
        continue
      }
      const start =
        stableNumber(`${qualified}.${c.name}.${seed}`) % Math.min(12, locators.length)
      const used = new Set<number>()
      for (const [candidateIndex, candidate] of options.entries()) {
        let locator: Locator | undefined
        for (let offset = 0; offset < locators.length; offset++) {
          const next = locators[(start + candidateIndex + offset) % locators.length]!
          if (!used.has(next.slot)) {
            used.add(next.slot)
            locator = next
            break
          }
        }
        if (!locator) {
          outcomes.push({
            table: qualified,
            column: c.name,
            category: candidate.category,
            status: "skipped",
            reason: "no distinct source row remains for this table",
          })
          continue
        }
        const base = { ...locator.row }
        const val = JSON.stringify({ value: candidate.value })
        const cast =
          candidate.expression === "json"
            ? `($1::jsonb -> 'value')`
            : candidate.value === null
              ? "null"
              : `($1::jsonb ->> 'value')::${c.formatted}`
        const target = candidate.value === null && candidate.expression !== "json"
        const childParam = target ? 1 : 2
        const tidParam = childParam + 1
        const params = target
          ? [locator.child, locator.tid]
          : [val, locator.child, locator.tid]
        try {
          const [updated] = await sql.begin((tx) =>
            tx.savepoint((sp) =>
              sp.unsafe<{ row: Record<string, unknown>; tid: string; child: string }[]>(
                `update ${relation(schema, table)} set ${q(c.name)} = ${cast} where tableoid = $${childParam}::regclass and ctid = $${tidParam}::tid returning to_jsonb(${q(table)}) row, ctid::text tid, tableoid::regclass::text child`,
                params,
              ),
            ),
          )
          if (!updated) {
            outcomes.push({
              table: qualified,
              column: c.name,
              category: candidate.category,
              status: "skipped",
              reason: "source row no longer matched",
            })
            continue
          }
          const key = keyFrom(updated.row, cols)
          locator.tid = updated.tid
          locator.child = updated.child
          locator.row = updated.row
          outcomes.push({
            table: qualified,
            column: c.name,
            category: candidate.category,
            status: "generated",
            row: updated.row,
            key,
          })
          chaosRows.push({ table: qualified, key, category: candidate.category })
        } catch (err) {
          outcomes.push({
            table: qualified,
            column: c.name,
            category: candidate.category,
            status: "protected",
            row: { ...base, [c.name]: candidate.value },
            key: keyFrom(base, cols),
            reason: (err as Error).message.split("\n")[0],
          })
        }
      }
    }
  }
  const file = corpusPath(seed)
  writeFileSync(
    file,
    JSON.stringify(
      {
        seed,
        derivedFrom:
          "pg_catalog tables, columns, keys, types, nullability, checks and partition bounds",
        chaosRows,
        outcomes,
      },
      null,
      2,
    ) + "\n",
  )
  const summary = {
    generated: outcomes.filter((x) => x.status === "generated").length,
    protected: outcomes.filter((x) => x.status === "protected").length,
    skipped: outcomes.filter((x) => x.status === "skipped").length,
    seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
    report: file,
  }
  log(
    `chaos: ${summary.generated} generated, ${summary.protected} schema-protected, ${summary.skipped} skipped in ${summary.seconds}s; ${file}`,
  )
  return summary
}

export { corpusPath }
