import { RULES, RULESET_VERSION } from "./rules.js"
import {
  maxBand,
  type Assessment,
  type Band,
  type Contribution,
  type Facts,
  type Rule,
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

/** An assessment, and the rules that could not take part in it. */
export interface Evaluated extends Assessment {
  failures: RuleFailure[]
}

export function evaluate(facts: Facts, rules: readonly Rule[] = RULES): Evaluated {
  const contributions: Contribution[] = []
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
    contributions.push({
      rule: r.id,
      category: r.category,
      points: result.points,
      evidence: result.evidence,
      ...(result.detail ? { detail: result.detail } : {}),
      ...(result.floor ? { floor: result.floor } : {}),
      ...(r.fresh && result.freshAt ? { freshAt: result.freshAt.toISOString() } : {}),
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
  return { score, band, contributions, rulesetVersion: RULESET_VERSION, failures }
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
