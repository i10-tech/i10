import { leadingCategory } from "./engine.js"
import {
  bandRank,
  CATEGORY_TEXT,
  type Assessment,
  type Band,
  type Category,
  type Plan,
} from "./types.js"

/**
 * What the score does about an assessment (#170). Pure: it returns actions,
 * and `act.ts` carries them out through their doors.
 *
 * ⚠ THE AUTOMATION STOPS AT HOLDS. Tier moves, holds and SES's Strict policy
 * are automatic; termination is not a possible output of this function, and
 * that is a decision, not an omission. See docs/decisions/risk.md.
 */
export type Action =
  | { kind: "tier"; tier: "strict" | "normal"; reason: string }
  | { kind: "hold"; category: Category; reason: string }
  | { kind: "ses_policy"; policy: "strict" | "standard" }
  | { kind: "alert"; level: "warning" | "error"; message: string }
  | { kind: "review_overdue" }
  /** An API key used from several countries: tell the owner it may have leaked. */
  | { kind: "key_spread_notice" }
  /** Recorded so staff can see the score WANTED to act and why it did not. */
  | { kind: "suppressed"; wanted: string; why: string }

export interface PreviousState {
  band: Band
  bandSince: Date
  autoActionsPausedUntil: Date | null
  clearedAt: Date | null
  sesPolicy: string | null
}

export interface DecisionInput {
  now: Date
  plan: Plan
  assessment: Assessment
  previous: PreviousState | null
  tier: { tier: "strict" | "normal"; source: "default" | "score" | "staff" }
  hold: { reviewDueAt: Date; reviewAlertedAt: Date | null } | null
  switches: { tiers: boolean; holds: boolean; sesPolicy: boolean }
  /** The rules that fired last time, so a notice goes out when one STARTS firing. */
  previousRules?: readonly string[]
}

/** How long a band must hold before the score relaxes what it tightened. */
export const RELAX_AFTER_DAYS = 14
const DAY = 24 * 60 * 60 * 1000

export function decide(input: DecisionInput): { bandSince: Date; actions: Action[] } {
  const { now, plan, assessment, previous, tier, hold, switches } = input
  const band = assessment.band
  const bandSince = previous && previous.band === band ? previous.bandSince : now
  const settledDays = (now.getTime() - bandSince.getTime()) / DAY
  const actions: Action[] = []

  /*
   * ⚠ A STAFF RELEASE OR PIN PAUSES THE SCORE'S HAND, NOT ITS EYES. The score
   * still computes and records; it just may not tighten anything until the
   * pause ends - unless a rule marked fresh fired on evidence newer than the
   * release, which is new evidence the person who released could not have
   * weighed.
   */
  const paused = Boolean(
    previous?.autoActionsPausedUntil && now < previous.autoActionsPausedUntil,
  )
  const clearedAt = previous?.clearedAt ?? null
  const freshCritical = assessment.contributions.some(
    (c) =>
      c.freshAt &&
      c.points > 0 &&
      c.floor === "critical" &&
      (!clearedAt || new Date(c.freshAt) > clearedAt),
  )
  const mayTighten = !paused || freshCritical

  const category = leadingCategory(assessment)
  const reason = `Risk ${assessment.score} (${band}): ${CATEGORY_TEXT[category]}.`

  // ── Tiers: free workspaces only ──
  if (plan === "free") {
    if (bandRank(band) >= bandRank("elevated") && tier.tier !== "strict") {
      if (!switches.tiers)
        actions.push({
          kind: "suppressed",
          wanted: "tier:strict",
          why: "RISK_ACT_TIERS is off",
        })
      else if (tier.source === "staff")
        actions.push({
          kind: "suppressed",
          wanted: "tier:strict",
          why: "staff set the tier",
        })
      else if (!mayTighten)
        actions.push({
          kind: "suppressed",
          wanted: "tier:strict",
          why: "staff paused automatic actions",
        })
      else actions.push({ kind: "tier", tier: "strict", reason })
    }
    // ⚠ ONLY A DEMOTION THE SCORE MADE IS UNDONE BY THE SCORE, and only after
    // two weeks settled low - one quiet day after a bad week is not recovery.
    if (
      band === "low" &&
      tier.tier === "strict" &&
      tier.source === "score" &&
      settledDays >= RELAX_AFTER_DAYS &&
      switches.tiers
    ) {
      actions.push({
        kind: "tier",
        tier: "normal",
        reason: `Risk ${assessment.score} (low) for ${RELAX_AFTER_DAYS} days: restored.`,
      })
    }
  }

  // ── Holds: either plan, critical only ──
  if (band === "critical" && !hold) {
    if (!switches.holds)
      actions.push({ kind: "suppressed", wanted: "hold", why: "RISK_ACT_HOLDS is off" })
    else if (!mayTighten)
      actions.push({
        kind: "suppressed",
        wanted: "hold",
        why: "staff paused automatic actions",
      })
    else actions.push({ kind: "hold", category, reason })
  }

  // ── SES reputation policy: paid workspaces ──
  if (plan === "paid") {
    const tight = bandRank(band) >= bandRank("high")
    if (tight && previous?.sesPolicy !== "strict") {
      if (!switches.sesPolicy)
        actions.push({
          kind: "suppressed",
          wanted: "ses:strict",
          why: "RISK_ACT_SES_POLICY is off",
        })
      else if (!mayTighten)
        actions.push({
          kind: "suppressed",
          wanted: "ses:strict",
          why: "staff paused automatic actions",
        })
      else actions.push({ kind: "ses_policy", policy: "strict" })
    }
    if (
      !tight &&
      previous?.sesPolicy === "strict" &&
      settledDays >= RELAX_AFTER_DAYS &&
      switches.sesPolicy
    ) {
      actions.push({ kind: "ses_policy", policy: "standard" })
    }
  }

  // ── Alerts: a human hears about every rise that matters ──
  const rose = !previous || bandRank(band) > bandRank(previous.band)
  const worth = bandRank(band) >= bandRank(plan === "paid" ? "elevated" : "high")
  if (rose && worth) {
    actions.push({
      kind: "alert",
      level: band === "critical" ? "error" : "warning",
      message: `Risk rose to ${band} (${assessment.score}) for a ${plan} workspace: ${CATEGORY_TEXT[category]}`,
    })
  }

  // ── A leaked key is the owner's emergency before it is our abuse problem ──
  if (
    assessment.contributions.some((c) => c.rule === "api.key_geo_spread") &&
    !input.previousRules?.includes("api.key_geo_spread")
  ) {
    actions.push({ kind: "key_spread_notice" })
  }

  // ── Article 22: a hold nobody has reviewed in time is itself an incident ──
  if (hold && now > hold.reviewDueAt && !hold.reviewAlertedAt) {
    actions.push({ kind: "review_overdue" })
  }

  return { bandSince, actions }
}
