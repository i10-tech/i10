import { clusterNearDuplicates } from "./cluster.js"
import { type Mail, yearBucket } from "./schema.js"
import { sha256Hex } from "./text.js"

export type Side = "dev" | "test"

export interface StratumCount {
  label: string
  dataset: string
  lang: string
  clusters: number
  dev: number
  test: number
}

export interface SplitSummary {
  seed: string
  devFraction: number
  mails: { dev: number; test: number }
  clusters: number
  strata: StratumCount[]
}

export interface SplitResult {
  assignment: Map<string, Side>
  summary: SplitSummary
}

/**
 * A deterministic split into `dev` and `test`.
 *
 * - Whole near-duplicate clusters move together (see cluster.ts), so a mail and
 *   its variants are never on both sides.
 * - Stratified: clusters are grouped by (label, dataset, lang) of the cluster's
 *   representative, ordered inside a stratum by a hash of seed and cluster id,
 *   and the first `round(devFraction * n)` go to dev. A stratum of one or two
 *   clusters therefore lands wholly in test, which is deliberate: the held-out
 *   set is the one that has to cover the rare languages.
 * - Seeded by hash, never by position, so the result does not depend on how the
 *   input is ordered and does not change when unrelated mails are added.
 */
export function splitMails(
  mails: Mail[],
  opts: { seed: string; devFraction: number },
): SplitResult {
  if (!(opts.devFraction >= 0 && opts.devFraction <= 1))
    throw new Error("devFraction must be in [0, 1]")
  const clusters = clusterNearDuplicates(mails)
  const byId = new Map(mails.map((m) => [m.id, m]))

  const strata = new Map<string, string[]>()
  for (const clusterId of new Set(clusters.values())) {
    const representative = byId.get(clusterId)
    if (representative === undefined)
      throw new Error(`cluster ${clusterId} has no representative`)
    const key = `${representative.label}\0${representative.dataset}\0${representative.lang}`
    const list = strata.get(key) ?? []
    list.push(clusterId)
    strata.set(key, list)
  }

  const clusterSide = new Map<string, Side>()
  for (const ids of strata.values()) {
    const ordered = ids
      .map((id) => ({ id, rank: sha256Hex(`${opts.seed}\0${id}`) }))
      .sort((a, b) =>
        a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : 1,
      )
    const devCount = Math.round(opts.devFraction * ordered.length)
    ordered.forEach(({ id }, i) => clusterSide.set(id, i < devCount ? "dev" : "test"))
  }

  const assignment = new Map<string, Side>()
  const counts = new Map<string, StratumCount>()
  const totals = { dev: 0, test: 0 }
  for (const mail of mails) {
    const clusterId = clusters.get(mail.id) ?? mail.id
    const side = clusterSide.get(clusterId) ?? "test"
    assignment.set(mail.id, side)
    totals[side]++
    const key = `${mail.label}\0${mail.dataset}\0${mail.lang}`
    const count = counts.get(key) ?? {
      label: mail.label,
      dataset: mail.dataset,
      lang: mail.lang,
      clusters: strata.get(key)?.length ?? 0,
      dev: 0,
      test: 0,
    }
    count[side]++
    counts.set(key, count)
  }

  const summary: SplitSummary = {
    seed: opts.seed,
    devFraction: opts.devFraction,
    mails: totals,
    clusters: new Set(clusters.values()).size,
    strata: [...counts.values()].sort(
      (a, b) =>
        a.label.localeCompare(b.label) ||
        a.dataset.localeCompare(b.dataset) ||
        a.lang.localeCompare(b.lang),
    ),
  }
  return { assignment, summary }
}

export interface CountTable {
  total: number
  byLabel: Record<string, number>
  byLang: Record<string, number>
  byYearBucket: Record<string, number>
  byDataset: Record<string, number>
  synthetic: number
}

function bump(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1
}

function sortedKeys(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  )
}

export function countMails(mails: Iterable<Mail>): CountTable {
  const t: CountTable = {
    total: 0,
    byLabel: {},
    byLang: {},
    byYearBucket: {},
    byDataset: {},
    synthetic: 0,
  }
  for (const m of mails) {
    t.total++
    bump(t.byLabel, m.label)
    bump(t.byLang, m.lang)
    bump(t.byYearBucket, yearBucket(m.year))
    bump(t.byDataset, m.dataset)
    if (m.synthetic) t.synthetic++
  }
  return {
    ...t,
    byLabel: sortedKeys(t.byLabel),
    byLang: sortedKeys(t.byLang),
    byYearBucket: sortedKeys(t.byYearBucket),
    byDataset: sortedKeys(t.byDataset),
  }
}
