import { RULES, RULESET_VERSION } from "./rules.js"
import {
  maxBand,
  type Assessment,
  type Band,
  type ClearedContribution,
  type Contribution,
  type Facts,
  type Rule,
  type ShadowContribution,
  type StaffDecision,
} from "./types.js"

/**
 * Turning facts into a score (#170).
 *
 * ⚠ PURE, AND THE SAME FUNCTION EVERYWHERE: the hourly run, the event-driven
 * re-score, `risk-admin explain`, and the scenario tests all call this with
 * facts and get the same answer. Nothing here reads a clock, a database or an
 * environment variable.
 */
export const BAND_FLOORS: readonly [Band, number][] = [
  ["critical", 85],
  ["high", 60],
  ["elevated", 30],
  ["low", 0],
]

export function bandFor(score: number): Band {
  for (const [band, min] of BAND_FLOORS) if (score >= min) return band
  return "low"
}

/** A rule that threw instead of answering, and what it threw. */
export interface RuleFailure {
  rule: string
  error: unknown
}

/**
 * An assessment, the rules that could not take part in it, what the shadow
 * rules would have added, and what staff decisions cleared.
 *
 * ⚠ `shadow` AND `cleared` ARE BESIDE THE ASSESSMENT, NOT IN IT. `decide`
 * takes an `Assessment`, which has neither field, and the runner strips them
 * off before deciding; neither element type is a `Contribution`.
 */
export interface Evaluated extends Assessment {
  failures: RuleFailure[]
  shadow: ShadowContribution[]
  cleared: ClearedContribution[]
}

/**
 * How long a staff decision clears what it covered: the longest window any
 * rule looks back over, so a year-old release never excuses today's mail.
 */
export const DECISION_MEMORY_DAYS = 180

const inEffect = (d: StaffDecision, now: Date) =>
  (d.kind === "release" || d.kind === "pin") &&
  d.decidedAt <= now &&
  now < d.expiresAt &&
  (!d.revokedAt || d.revokedAt > now)

/**
 * The staff decision that already cleared this contribution, or null.
 *
 * ⚠ ONLY THE SAME EVIDENCE IS CLEARED, AND IN FULL OR NOT AT ALL. A decision
 * covers a contribution when it covered the same rule and the contribution is
 * no stronger than it was then, and either every key it flags was among the
 * keys cleared or, for a rule with no keys, it carries no `freshAt` newer than
 * the decision. One new host, one new peer, one point more: it counts in full.
 * Never a negative contribution, which would raise the score by clearing trust.
 *
 * ⚠ KEYS, NOT `freshAt`, FOR A KEYED RULE. `links.unsafe` dates its evidence to
 * the END of the day the link was sent, so a release on that day would never
 * clear it; and the same host sent again is the same host staff judged.
 */
export function clearedBy(
  c: Contribution,
  decisions: readonly StaffDecision[],
  now: Date,
): StaffDecision | null {
  if (c.points <= 0) return null
  let latest: StaffDecision | null = null
  for (const d of decisions) {
    if (!inEffect(d, now)) continue
    const was = d.covers.find((x) => x.rule === c.rule)
    if (!was || c.points > was.points) continue
    if (c.keys) {
      if (!c.keys.every((k) => was.keys?.includes(k))) continue
    } else if (c.freshAt && Date.parse(c.freshAt) > d.decidedAt.getTime()) continue
    if (!latest || d.decidedAt > latest.decidedAt) latest = d
  }
  return latest
}

/** The rules with the listed ids forced into shadow: `RISK_SHADOW_RULES`. */
export function forceShadow(rules: readonly Rule[], ids: readonly string[]): Rule[] {
  const braked = new Set(ids)
  return rules.map((r) => (braked.has(r.id) ? { ...r, mode: "shadow" as const } : r))
}

export function evaluate(facts: Facts, rules: readonly Rule[] = RULES): Evaluated {
  const contributions: Contribution[] = []
  const shadow: ShadowContribution[] = []
  const cleared: ClearedContribution[] = []
  const failures: RuleFailure[] = []
  for (const r of rules) {
    let result
    try {
      result = r.evaluate(facts)
    } catch (error) {
      // ⚠ ONE BROKEN RULE MUST NOT SILENCE THE OTHERS, AND MUST NOT VANISH. A
      // rule that throws is a bug to fix, not a reason to score nothing - which
      // would read as "this workspace is fine" - so the others still score and
      // the failure goes back to the caller, who reports it.
      failures.push({ rule: r.id, error })
      continue
    }
    if (!result || result.points === 0) continue
    if (r.mode === "shadow") {
      shadow.push({
        rule: r.id,
        category: r.category,
        wouldAdd: result.points,
        evidence: result.evidence,
        ...(result.detail ? { detail: result.detail } : {}),
        ...(result.floor ? { wouldFloor: result.floor } : {}),
      })
      continue
    }
    const c: Contribution = {
      rule: r.id,
      category: r.category,
      points: result.points,
      evidence: result.evidence,
      ...(result.detail ? { detail: result.detail } : {}),
      ...(result.floor ? { floor: result.floor } : {}),
      ...(r.fresh && result.freshAt ? { freshAt: result.freshAt.toISOString() } : {}),
      ...(result.keys ? { keys: result.keys } : {}),
    }
    const by = clearedBy(c, facts.decisions ?? [], facts.now)
    if (!by) {
      contributions.push(c)
      continue
    }
    const { points, floor, ...rest } = c
    cleared.push({
      ...rest,
      wouldAdd: points,
      ...(floor ? { wouldFloor: floor } : {}),
      clearedBy: by.id,
      decidedAt: by.decidedAt.toISOString(),
      expiresAt: by.expiresAt.toISOString(),
    })
  }

  const raw = contributions.reduce((sum, c) => sum + c.points, 0)
  const score = Math.max(0, Math.min(100, Math.round(raw)))
  const band = contributions.reduce<Band>(
    (b, c) => (c.floor ? maxBand(b, c.floor) : b),
    bandFor(score),
  )
  // Worst first, which is the order staff and the console read them in.
  contributions.sort((a, b) => b.points - a.points)
  shadow.sort((a, b) => b.wouldAdd - a.wouldAdd)
  cleared.sort((a, b) => b.wouldAdd - a.wouldAdd)
  return {
    score,
    band,
    contributions,
    rulesetVersion: RULESET_VERSION,
    failures,
    shadow,
    cleared,
  }
}

/**
 * The category that best explains a band to the customer: the biggest
 * positive contribution's.
 */
export function leadingCategory(assessment: Assessment) {
  return (
    assessment.contributions.find((c) => c.points > 0)?.category ?? "sending_pattern"
  )
}
