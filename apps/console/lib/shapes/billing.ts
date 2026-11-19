import { defineShape } from "@/lib/shapes"
import type { BillingState, PlanSummary } from "@/lib/types"

export interface BillingData {
  billing: BillingState
  plans: PlanSummary[]
  checkoutId: string | null
  scheduledName: string | null
  error?: string
}

export interface BillingShape {
  /** Whether a plan is assigned. */
  plan: boolean
  /** Whether the assigned plan is a custom plan. */
  custom: boolean
  /**
   * Current subscription state. "unknown" is a shape nobody has told us yet: the
   * skeleton draws bars where the subscription's words go, never "No paid
   * subscription" for a workspace that may well have one.
   */
  subscription: "unknown" | "none" | "active" | "scheduled"
  /** Whether a checkout outcome is in flight. */
  checkout: boolean
  /** Number of plan cards in the catalogue to draw. */
  plans: number
  /**
   * The most entitlement rows any card lists. The cards share a row height, so
   * the longest one sets it. Null: not known (an old cookie), draw the default.
   */
  entitlements: number | null
  /**
   * The card with a note under its button, and the note's lines. Null: no card
   * has one (or, from an old cookie, unknown, which draws none).
   */
  note: { card: number; lines: number } | null
}

const MAX_PLANS = 6
const MAX_ENTITLEMENTS = 10
const count = (v: unknown, max: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? Math.min(v, max) : null

const SUBSCRIPTIONS = ["none", "active", "scheduled"] as const

/**
 * ⚠ THE LINES A CARD'S NOTE WRAPS TO AT THE USUAL THREE-CARD WIDTH, measured:
 * "You move here on <date>. Your <plan> allowance continues until then." runs
 * three, "Your subscription already ends on <date>. You move here then." two.
 * A narrower or wider card wraps differently; the morph absorbs the rest.
 * The API's shapes route draws the same rule for a first visit
 * (apps/api/src/routes/console/shapes.ts) - keep them in step.
 */
const NOTE_LINES = { scheduled: 3, ending: 2 } as const

/** Which card carries a note under its button, as PlanCards decides it. */
export function cardNote(
  billing: BillingState,
  plans: PlanSummary[],
): BillingShape["note"] {
  const sub = billing.subscription
  if (!sub) return null
  if (sub.scheduled_plan_id) {
    const card = plans.findIndex((p) => p.id === sub.scheduled_plan_id)
    return card < 0 ? null : { card, lines: NOTE_LINES.scheduled }
  }
  // The free card says the subscription ends, once there is a date to say.
  if (
    sub.cancel_at_period_end &&
    sub.current_period_end &&
    (billing.plan?.rank ?? 0) > 0
  ) {
    const card = plans.findIndex((p) => p.rank === 0)
    return card < 0 ? null : { card, lines: NOTE_LINES.ending }
  }
  return null
}

/**
 * What the layout already knows from /console/me, as counts for
 * `mergeShapes`: this workspace's plan and subscription, so a first visit draws
 * the right billing page without waiting for it. Zero or one, except the
 * subscription, which indexes SUBSCRIPTIONS.
 */
export function billingCounts(billing: BillingState): Record<string, number> {
  const state = billing.subscription?.scheduled_plan_id
    ? "scheduled"
    : billing.subscription
      ? "active"
      : "none"
  return {
    billingPlan: billing.plan !== null ? 1 : 0,
    billingCustom: billing.plan?.source === "custom" ? 1 : 0,
    billingSubscription: SUBSCRIPTIONS.indexOf(state),
  }
}

/** ⚠ ABSENT IN A COOKIE WRITTEN BEFORE THE FIELD EXISTED, and anything odd: no note. */
function parseNote(raw: unknown): BillingShape["note"] {
  if (typeof raw !== "object" || raw === null) return null
  const r = raw as Record<string, unknown>
  const card = count(r.card, MAX_PLANS)
  const lines = count(r.lines, 5)
  return card !== null && lines !== null && lines > 0 ? { card, lines } : null
}

export const billingShape = defineShape<BillingShape, BillingData>({
  page: "billing",
  fallback: {
    plan: true,
    custom: false,
    subscription: "unknown",
    checkout: false,
    plans: 3,
    entitlements: null,
    note: null,
  },
  // A first visit: the plan and subscription from /console/me (billingCounts),
  // the catalogue's size from GET /console/shapes. A count that is missing stays
  // unknown or default; with nothing at all, the fallback.
  fromCounts: (counts) => {
    const sub = count(counts.billingSubscription, SUBSCRIPTIONS.length - 1)
    const plans = count(counts.plans, MAX_PLANS)
    const entitlements = count(counts.planEntitlements, MAX_ENTITLEMENTS)
    if (sub === null && plans === null && entitlements === null) return null
    const noteCard = count(counts.planNoteCard, MAX_PLANS)
    const noteLines = count(counts.planNoteLines, 5)
    const note =
      noteCard !== null && noteLines !== null && noteLines > 0
        ? { card: noteCard, lines: noteLines }
        : null
    return {
      plan: counts.billingPlan === 1,
      custom: counts.billingCustom === 1,
      subscription: sub === null ? "unknown" : SUBSCRIPTIONS[sub]!,
      checkout: false,
      plans: plans ?? 3,
      entitlements,
      note,
    }
  },
  of: (data) => ({
    plan: data.billing.plan !== null,
    custom: data.billing.plan?.source === "custom",
    subscription: data.billing.subscription?.scheduled_plan_id
      ? "scheduled"
      : data.billing.subscription
        ? "active"
        : "none",
    checkout: Boolean(data.checkoutId),
    plans: Math.min(data.plans.length, MAX_PLANS),
    entitlements: Math.min(
      Math.max(0, ...data.plans.map((p) => p.entitlements.length)),
      MAX_ENTITLEMENTS,
    ),
    note: cardNote(data.billing, data.plans),
  }),
  parse: (raw) => {
    if (typeof raw !== "object" || raw === null) return null
    const r = raw as Record<string, unknown>
    const sub = r.subscription
    if (sub !== "unknown" && !SUBSCRIPTIONS.includes(sub as never)) return null
    const plans = count(r.plans, MAX_PLANS)
    if (plans === null) return null
    // ⚠ ABSENT IN A COOKIE WRITTEN BEFORE THE FIELD EXISTED: unknown, not invalid.
    const rawEntitlements = r.entitlements ?? null
    const entitlements =
      rawEntitlements === null ? null : count(rawEntitlements, MAX_ENTITLEMENTS)
    if (rawEntitlements !== null && entitlements === null) return null
    return {
      plan: r.plan === true,
      custom: r.custom === true,
      subscription: sub as BillingShape["subscription"],
      checkout: r.checkout === true,
      plans,
      entitlements,
      note: parseNote(r.note),
    }
  },
})
