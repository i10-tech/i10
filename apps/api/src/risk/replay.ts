import { evaluate, type Evaluated } from "./engine.js"
import { reviveFacts, type FactSnapshot } from "./snapshot.js"
import { BANDS, type Band, type Rule, type RuleMode } from "./types.js"

/**
 * What a rule set would have done to the snapshots we kept (#170): the stored
 * outcome beside the outcome under `rules`.
 *
 * ⚠ PURE. It reads nothing, writes nothing and calls nobody; `risk-admin
 * replay` pages snapshots in and prints what comes out. The facts were frozen
 * when the snapshot was taken, the content classifier's answer included, so
 * the same rules always replay to the same result.
 */
export interface Outcome {
  score: number
  band: Band
}

export interface ReplayedSnapshot {
  id: string
  tenantId: string
  takenAt: Date
  rulesetVersion: number
  stored: Outcome
  replayed: Outcome
  /** Rules whose contribution (live or shadow, points, floor) is not the stored one. */
  differs: string[]
  /** Rules that threw on these facts: usually an older shape than they expect. */
  failed: string[]
  /** Shadow rules in `rules` that fired. */
  shadowFired: string[]
  /** Of those, the ones that would have moved the band had they been live. */
  shadowWouldChangeBand: string[]
}

interface Effect {
  mode: RuleMode
  points: number
  floor: Band | null
}

function effects(e: Pick<Evaluated, "contributions" | "shadow">): Map<string, Effect> {
  const out = new Map<string, Effect>()
  for (const c of e.contributions ?? [])
    out.set(c.rule, { mode: "live", points: c.points, floor: c.floor ?? null })
  for (const c of e.shadow ?? [])
    out.set(c.rule, { mode: "shadow", points: c.wouldAdd, floor: c.wouldFloor ?? null })
  return out
}

const same = (a: Effect | undefined, b: Effect | undefined) =>
  a?.mode === b?.mode && a?.points === b?.points && a?.floor === b?.floor

export function replaySnapshot(
  snapshot: FactSnapshot,
  rules: readonly Rule[],
): ReplayedSnapshot {
  const facts = reviveFacts(snapshot.facts)
  const now = evaluate(facts, rules)

  const before = effects(snapshot)
  const after = effects(now)
  const differs = [...new Set([...before.keys(), ...after.keys()])]
    .filter((id) => !same(before.get(id), after.get(id)))
    .sort()

  const shadowFired = now.shadow.map((c) => c.rule)
  const shadowWouldChangeBand = shadowFired.filter((id) => {
    const live = rules.map((r) => (r.id === id ? { ...r, mode: "live" as const } : r))
    return evaluate(facts, live).band !== now.band
  })

  return {
    id: snapshot.id,
    tenantId: snapshot.tenantId,
    takenAt: snapshot.takenAt,
    rulesetVersion: snapshot.rulesetVersion,
    stored: { score: snapshot.score, band: snapshot.band },
    replayed: { score: now.score, band: now.band },
    differs,
    failed: now.failures.map((f) => f.rule),
    shadowFired,
    shadowWouldChangeBand,
  }
}

export interface ReplayReport {
  snapshots: number
  workspaces: number
  /** `transitions[stored][replayed]`: how many snapshots moved from one band to the other. */
  transitions: Record<Band, Record<Band, number>>
  /** Workspaces with at least one snapshot whose band would change, and the latest such change. */
  bandChanges: {
    tenantId: string
    snapshots: number
    latest: { id: string; takenAt: Date; from: Outcome; to: Outcome }
  }[]
  /** Per rule: snapshots where its contribution differs, and where it threw. */
  rules: { rule: string; mode: RuleMode | "removed"; differs: number; failed: number }[]
  /** Per shadow rule: snapshots it fired on, and how many it would have moved a band on. */
  shadow: { rule: string; fired: number; wouldChangeBand: number }[]
}

const emptyRow = (): Record<Band, number> => ({
  low: 0,
  elevated: 0,
  high: 0,
  critical: 0,
})

export function summarise(
  results: readonly ReplayedSnapshot[],
  rules: readonly Rule[],
): ReplayReport {
  const transitions = {
    low: emptyRow(),
    elevated: emptyRow(),
    high: emptyRow(),
    critical: emptyRow(),
  }
  const changed = new Map<string, ReplayReport["bandChanges"][number]>()
  const perRule = new Map<string, { differs: number; failed: number }>(
    rules.map((r) => [r.id, { differs: 0, failed: 0 }]),
  )
  const counter = (id: string) => {
    const c = perRule.get(id) ?? { differs: 0, failed: 0 }
    perRule.set(id, c)
    return c
  }
  const shadowRules = rules.filter((r) => r.mode === "shadow").map((r) => r.id)
  const shadow = new Map(
    shadowRules.map((id) => [id, { fired: 0, wouldChangeBand: 0 }]),
  )

  for (const r of results) {
    transitions[r.stored.band][r.replayed.band]++
    for (const id of r.differs) counter(id).differs++
    for (const id of r.failed) counter(id).failed++
    for (const id of r.shadowFired) shadow.get(id)!.fired++
    for (const id of r.shadowWouldChangeBand) shadow.get(id)!.wouldChangeBand++
    if (r.stored.band === r.replayed.band) continue
    const prior = changed.get(r.tenantId)
    const latest = { id: r.id, takenAt: r.takenAt, from: r.stored, to: r.replayed }
    changed.set(r.tenantId, {
      tenantId: r.tenantId,
      snapshots: (prior?.snapshots ?? 0) + 1,
      latest: prior && prior.latest.takenAt > r.takenAt ? prior.latest : latest,
    })
  }

  const modes = new Map(rules.map((r) => [r.id, r.mode ?? ("live" as const)]))
  return {
    snapshots: results.length,
    workspaces: new Set(results.map((r) => r.tenantId)).size,
    transitions,
    bandChanges: [...changed.values()].sort((a, b) =>
      a.tenantId.localeCompare(b.tenantId),
    ),
    rules: [...perRule.entries()]
      .map(([rule, c]) => ({
        rule,
        mode: modes.get(rule) ?? ("removed" as const),
        ...c,
      }))
      .sort((a, b) => a.rule.localeCompare(b.rule)),
    shadow: [...shadow.entries()].map(([rule, c]) => ({ rule, ...c })),
  }
}

export function replay(
  snapshots: readonly FactSnapshot[],
  rules: readonly Rule[],
): { report: ReplayReport; snapshots: ReplayedSnapshot[] } {
  const results = snapshots.map((s) => replaySnapshot(s, rules))
  return { report: summarise(results, rules), snapshots: results }
}

/** The report for a terminal. */
export function formatReport(report: ReplayReport): string {
  const lines: string[] = []
  lines.push(`${report.snapshots} snapshot(s) of ${report.workspaces} workspace(s)`)

  lines.push("", "bands, stored (rows) by replayed (columns):")
  lines.push(`  ${"".padEnd(9)}${BANDS.map((b) => b.padStart(9)).join("")}`)
  for (const from of BANDS)
    lines.push(
      `  ${from.padEnd(9)}${BANDS.map((to) => String(report.transitions[from][to]).padStart(9)).join("")}`,
    )

  lines.push("", `workspaces whose band would change: ${report.bandChanges.length}`)
  for (const c of report.bandChanges) {
    const { from, to, takenAt } = c.latest
    lines.push(
      `  ${c.tenantId}  ${from.band} (${from.score}) -> ${to.band} (${to.score})  at ${takenAt.toISOString()}, ${c.snapshots} snapshot(s) changed`,
    )
  }

  const moved = report.rules.filter((r) => r.differs > 0 || r.failed > 0)
  lines.push(
    "",
    `rules whose contribution differs: ${moved.length} of ${report.rules.length}`,
  )
  for (const r of moved)
    lines.push(
      `  ${r.rule.padEnd(30)} ${r.mode.padEnd(8)} differs on ${r.differs}, could not run on ${r.failed}`,
    )

  if (report.shadow.length > 0) {
    lines.push("", "shadow rules (no effect on score, band or actions):")
    for (const s of report.shadow)
      lines.push(
        `  ${s.rule.padEnd(30)} fired on ${s.fired}, would have changed the band on ${s.wouldChangeBand} had it been live`,
      )
  }
  return lines.join("\n")
}
