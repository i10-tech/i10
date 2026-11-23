/**
 * Reads an `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)` plan and says what
 * in it is a risk at scale. Pure: no database, so the rules are testable.
 * VERBOSE matters: without it a node names its relation but not its schema, and
 * `authd.managed_accounts` cannot be told from `identity.managed_accounts`.
 */

export interface PlanNode {
  "Node Type": string
  "Relation Name"?: string
  Schema?: string
  "Index Name"?: string
  "Function Name"?: string
  "Parent Relationship"?: string
  "Subplan Name"?: string
  "Plan Rows"?: number
  "Actual Rows"?: number
  "Actual Loops"?: number
  "Rows Removed by Filter"?: number
  "Sort Space Type"?: string
  "Hash Batches"?: number
  "Shared Hit Blocks"?: number
  "Shared Read Blocks"?: number
  "Temp Written Blocks"?: number
  Plans?: PlanNode[]
}

export interface ExplainRoot {
  Plan: PlanNode
  "Planning Time"?: number
  "Execution Time"?: number
}

/** Rows each relation holds (`reltuples`), keyed `schema.name`; partitions included. */
export type RelationSizes = ReadonlyMap<string, number>

export const BIG_TABLE_ROWS = 10_000

export interface Analysis {
  rows: number
  sharedHit: number
  sharedRead: number
  tempWritten: number
  planningMs: number
  executionMs: number
  /** One entry per scan node: `Seq Scan core.messages_2026_11 (rows 120000)`. */
  scans: string[]
  flags: string[]
  /** Node types and relations, partition suffixes folded: equal shapes mean the same plan. */
  shape: string
}

const fold = (name: string | undefined) =>
  (name ?? "").replace(/_\d{4}_\d{2}(?=$|_)/g, "_*").replace(/_default(?=$|_)/, "_*")

function walk(
  node: PlanNode,
  visit: (n: PlanNode, parent: PlanNode | null) => void,
  parent: PlanNode | null = null,
): void {
  visit(node, parent)
  for (const child of node.Plans ?? []) walk(child, visit, node)
}

export function shapeOf(node: PlanNode): string {
  const rel = node["Relation Name"] ? ` ${fold(node["Relation Name"])}` : ""
  const idx = node["Index Name"] ? ` using ${fold(node["Index Name"])}` : ""
  const kids = (node.Plans ?? []).map(shapeOf)
  // Folded partitions under an Append are one shape whatever their count.
  const unique = node["Node Type"] === "Append" ? [...new Set(kids)] : kids
  return `${node["Node Type"]}${rel}${idx}${unique.length ? `(${unique.join(", ")})` : ""}`
}

export function analyse(root: ExplainRoot, sizes: RelationSizes): Analysis {
  const flags = new Set<string>()
  const scans: string[] = []
  let rows = 0
  walk(root.Plan, (n, parent) => {
    const loops = n["Actual Loops"] ?? 1
    const actual = (n["Actual Rows"] ?? 0) * loops
    if (parent === null) rows = n["Actual Rows"] ?? 0
    const rel = n["Relation Name"] ? `${n.Schema ?? "?"}.${n["Relation Name"]}` : null
    const size = rel ? (sizes.get(rel) ?? 0) : 0
    if (rel && /Scan/.test(n["Node Type"])) {
      scans.push(
        `${n["Node Type"]} ${rel}${n["Index Name"] ? ` using ${n["Index Name"]}` : ""} (table ${Math.round(size)} rows${loops > 1 ? `, ${loops} loops` : ""})`,
      )
    }
    if (n["Node Type"] === "Seq Scan" && size >= BIG_TABLE_ROWS)
      flags.add(`seq scan on ${rel} (${Math.round(size)} rows)`)
    if ((n["Rows Removed by Filter"] ?? 0) * loops >= BIG_TABLE_ROWS) {
      flags.add(
        `${(n["Rows Removed by Filter"]! * loops).toLocaleString("en-US")} rows read and discarded by a filter on ${rel ?? n["Node Type"]}`,
      )
    }
    if ((n["Parent Relationship"] === "SubPlan" || n["Subplan Name"]) && loops >= 100) {
      flags.add(
        `per-row subplan (${n["Subplan Name"] ?? n["Node Type"]}, ${loops} loops)`,
      )
    }
    if (n["Node Type"] === "Nested Loop") {
      const inner = n.Plans?.[1]
      if (inner && (inner["Actual Loops"] ?? 0) >= 1000)
        flags.add(`nested loop over ${inner["Actual Loops"]} outer rows`)
    }
    if (n["Sort Space Type"] === "Disk") flags.add("sort spilled to disk")
    if ((n["Hash Batches"] ?? 1) > 1)
      flags.add(`hash spilled (${n["Hash Batches"]} batches)`)
    const planned = (n["Plan Rows"] ?? 0) * loops
    if (
      Math.max(actual, planned) >= 1000 &&
      Math.max(actual, 1) / Math.max(planned, 1) >= 100
    ) {
      flags.add(
        `underestimate on ${rel ?? n["Node Type"]}: planned ${Math.round(planned)}, got ${actual}`,
      )
    }
    // Every monthly partition read: nothing in the query bounds `created_at`, so
    // the cost grows with the months kept, not only with the rows.
    if (n["Node Type"] === "Append" && (n.Plans?.length ?? 0) > 6)
      flags.add(`reads every partition (${n.Plans!.length}): no time bound to prune by`)
  })
  const top = root.Plan
  const hit = top["Shared Hit Blocks"] ?? 0
  const read = top["Shared Read Blocks"] ?? 0
  if (hit + read >= 10_000)
    flags.add(
      `${(hit + read).toLocaleString("en-US")} buffers touched (${Math.round(((hit + read) * 8) / 1024)} MB)`,
    )
  return {
    rows,
    sharedHit: hit,
    sharedRead: read,
    tempWritten: top["Temp Written Blocks"] ?? 0,
    planningMs: root["Planning Time"] ?? 0,
    executionMs: root["Execution Time"] ?? 0,
    scans,
    flags: [...flags],
    shape: shapeOf(top),
  }
}

/**
 * auto_explain's notice: `duration: 1.2 ms  plan:\n{...}`. Returns the plan of a
 * statement run inside a function, or null for any other notice.
 */
export function nestedPlan(
  message: string,
): { query: string; root: ExplainRoot } | null {
  const at = message.indexOf("{")
  const duration = /^duration: ([0-9.]+) ms/.exec(message)
  if (!duration || at < 0) return null
  try {
    const parsed = JSON.parse(message.slice(at)) as ExplainRoot & {
      "Query Text"?: string
    }
    // auto_explain puts the time in the message, not in the plan.
    return {
      query: parsed["Query Text"] ?? "",
      root: {
        ...parsed,
        "Execution Time": parsed["Execution Time"] ?? Number(duration[1]),
      },
    }
  } catch {
    return null
  }
}

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  const i = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  )
  return sorted[i]!
}
