/** Runs the real registry cases and counts returned rows matching chaos PKs. */
import { readFileSync, writeFileSync } from "node:fs"
import postgres from "postgres"
import { capture } from "./capture.js"
import { corpusPath, type ChaosKey, type ChaosRow } from "./chaos.js"
import { REGISTRY } from "./registry.js"
import { directUrl, poolerUrl, type Scratch } from "./scratch.js"
import { Pickers } from "./pickers.js"

type Coverage = {
  entry: string
  cases: number
  casesWithChaosRows: number
  chaosRowsReturned: number
  zeroCases: string[]
  errorCases: string[]
  expectationFailures: { case: string; message: string }[]
}

const normalizeName = (s: string) =>
  s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()
const scalar = (v: unknown) => (v == null || typeof v === "object" ? null : String(v))

function keyMatch(value: unknown, key: ChaosKey): boolean {
  const values = Object.entries(key).filter(([, v]) => v != null)
  if (!values.length) return false
  if (typeof value === "string" || typeof value === "number")
    return values.length === 1 && String(value) === String(values[0]![1])
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const entries = Object.entries(value as Record<string, unknown>)
  const properties = new Map(entries.map(([k, v]) => [normalizeName(k), scalar(v)]))
  const matched = values.filter(
    ([k, v]) => properties.get(normalizeName(k)) === String(v),
  ).length
  if (matched === values.length) return true
  const stableId = values.find(
    ([k, v]) => k === "id" && /^[0-9a-f-]{36}$/i.test(String(v)),
  )
  if (
    stableId &&
    entries.some(
      ([k, v]) =>
        ["id", "message_id", "email_id"].includes(normalizeName(k)) &&
        scalar(v) === String(stableId[1]),
    )
  )
    return true
  if (values.length === 1) {
    const wanted = String(values[0]![1])
    return entries.some(([, v]) => scalar(v) === wanted)
  }
  return false
}

function returnedChaosRows(result: unknown, rows: ChaosRow[]): Set<string> {
  const found = new Set<string>()
  const seen = new Set<object>()
  const visit = (value: unknown) => {
    if (value == null) return
    for (const row of rows)
      if (keyMatch(value, row.key)) found.add(JSON.stringify([row.table, row.key]))
    if (
      typeof value !== "object" ||
      value instanceof Date ||
      value instanceof Uint8Array
    )
      return
    if (seen.has(value)) return
    seen.add(value)
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    for (const item of Object.values(value as Record<string, unknown>)) visit(item)
  }
  visit(result)
  return found
}

export async function chaosCoverage(o: {
  scratch: Scratch
  seed: number
  log: (message: string) => void
}) {
  const corpus = JSON.parse(readFileSync(corpusPath(o.seed), "utf8")) as {
    chaosRows: ChaosRow[]
  }
  const owner = postgres(directUrl(o.scratch), { max: 2, onnotice: () => {} })
  try {
    const pickers = new Pickers(owner)
    const coverage: Coverage[] = []
    for (const entry of REGISTRY) {
      const zeroCases: string[] = []
      const errorCases: string[] = []
      const expectationFailures: { case: string; message: string }[] = []
      const rows = new Set<string>()
      let casesWithChaosRows = 0
      for (const c of entry.cases) {
        let arg: unknown
        try {
          arg = await c.arg(pickers)
        } catch (err) {
          errorCases.push(`${c.name}: picker ${(err as Error).message}`)
          zeroCases.push(c.name)
          continue
        }
        const cap = await capture(poolerUrl(o.scratch, entry.role), new Set(), (ctx) =>
          entry.run(ctx, arg),
        )
        if (cap.error) errorCases.push(`${c.name}: ${cap.error}`)
        const expectationFailure = c.expect?.(cap.result) ?? null
        if (expectationFailure)
          expectationFailures.push({ case: c.name, message: expectationFailure })
        const matched = returnedChaosRows(cap.result, corpus.chaosRows)
        if (matched.size) casesWithChaosRows++
        else zeroCases.push(c.name)
        for (const row of matched) rows.add(row)
      }
      coverage.push({
        entry: entry.name,
        cases: entry.cases.length,
        casesWithChaosRows,
        chaosRowsReturned: rows.size,
        zeroCases,
        errorCases,
        expectationFailures,
      })
      o.log(
        `${entry.name}: ${rows.size} distinct chaos rows returned across ${casesWithChaosRows}/${entry.cases.length} cases${errorCases.length ? `, ${errorCases.length} errors` : ""}`,
      )
    }
    const totals = {
      entries: coverage.length,
      cases: coverage.reduce((n, e) => n + e.cases, 0),
      casesWithChaosRows: coverage.reduce((n, e) => n + e.casesWithChaosRows, 0),
      entriesWithZeroRows: coverage.filter((e) => e.chaosRowsReturned === 0).length,
      errorCases: coverage.reduce((n, e) => n + e.errorCases.length, 0),
    }
    const file = `/tmp/db-scale-chaos-coverage-${o.seed}.json`
    writeFileSync(
      file,
      JSON.stringify({ seed: o.seed, totals, entries: coverage }, null, 2) + "\n",
    )
    return { totals, coverage, file }
  } finally {
    await owner.end({ timeout: 3 })
  }
}
