/**
 * When a failed webhook is tried again, and when an endpoint is given up on.
 *
 * ⚠ SVIX'S PRINCIPLES, NOT ITS NUMBERS (docs/decisions/webhooks.md, decision
 * 5). Exponential gaps with jitter, a pause for an endpoint that says it is
 * overloaded, a window long enough to ride out an outage, and disabling on a
 * long silence rather than on a count. The window is shorter on Free and longer
 * on paid plans, and never outlasts the plan's data retention.
 *
 * ⚠ THE POLICY IS FIXED WHEN THE DELIVERY IS CREATED. It is stored on the row
 * (`retry_policy`), so a plan change never rewrites retries already in flight:
 * an event that happened on Pro is retried like one, after a downgrade too.
 */

export type RetryPolicy = "free" | "pro" | "scale" | "enterprise"

export interface PolicyRules {
  /** Seconds to wait after each failed attempt. Its length + 1 is the budget. */
  gaps: readonly number[]
  /** An endpoint with no success for this long is disabled. */
  disableAfterSeconds: number
}

const HOUR = 60 * 60
const DAY = 24 * HOUR

const PRO_GAPS = [5, 5 * 60, 30 * 60, 2 * HOUR, 5 * HOUR, 10 * HOUR, 10 * HOUR] as const

export const POLICIES: Readonly<Record<RetryPolicy, PolicyRules>> = {
  // About 1h45m. Free keeps 3 days of data.
  free: { gaps: [5, 60, 10 * 60, 30 * 60, HOUR], disableAfterSeconds: 2 * DAY },
  // About 28h.
  pro: { gaps: PRO_GAPS, disableAfterSeconds: 5 * DAY },
  // About 3 days.
  scale: {
    gaps: [...PRO_GAPS, 12 * HOUR, 12 * HOUR, 12 * HOUR],
    disableAfterSeconds: 5 * DAY,
  },
  // Scale's by default; a contract can extend it to 7 days.
  enterprise: {
    gaps: [...PRO_GAPS, 12 * HOUR, 12 * HOUR, 12 * HOUR],
    disableAfterSeconds: 7 * DAY,
  },
}

/** The policy for a plan id. A workspace with no plan is on Free. */
export function policyForPlan(planId: string | null | undefined): RetryPolicy {
  if (!planId || planId === "free") return "free"
  if (planId === "pro" || planId === "scale") return planId
  // Custom plans have generated ids; they are negotiated, so they get the
  // enterprise rules.
  return "enterprise"
}

/** Attempts a delivery gets under a policy, the first included. */
export const attemptsFor = (policy: RetryPolicy, rules: RetryRules = RULES): number =>
  rules.policies[policy].gaps.length + 1

/**
 * Everything that decides timing, in one object, so the conformance lab can
 * run a scaled-down copy of exactly this logic.
 */
export interface RetryRules {
  policies: Readonly<Record<RetryPolicy, PolicyRules>>
  /** The longest an endpoint's `Retry-After` can push a retry. */
  retryAfterCapSeconds: number
  /** The least an overloaded endpoint waits: a 429 or a timeout. */
  overloadPenaltySeconds: number
  /** Up to this fraction either side of a gap, so retries do not arrive in step. */
  jitter: number
}

export const RULES: RetryRules = {
  policies: POLICIES,
  retryAfterCapSeconds: HOUR,
  overloadPenaltySeconds: 60,
  jitter: 0.2,
}

export interface FailureSignals {
  /** The HTTP status, if the endpoint answered. */
  status?: number
  /** It never answered in time. */
  timedOut?: boolean
  /** The endpoint's `Retry-After`, raw. */
  retryAfter?: string | null
}

/** Seconds from `now` named by a `Retry-After` value, or null if unreadable. */
export function parseRetryAfter(
  value: string | null | undefined,
  now = new Date(),
): number | null {
  if (!value) return null
  const trimmed = value.trim()
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.ceil(Number(trimmed))
  // An HTTP date has a weekday and a month in it. Without letters this is not
  // one, whatever Date.parse makes of it ("-5" parses as the year -5).
  if (!/[A-Za-z]/.test(trimmed)) return null
  const at = Date.parse(trimmed)
  if (Number.isNaN(at)) return null
  return Math.max(0, Math.ceil((at - now.getTime()) / 1000))
}

/**
 * Milliseconds until the next attempt, given `made` attempts so far, or null
 * when the policy's budget is spent.
 *
 * ⚠ THE ENDPOINT'S OWN SIGNALS ONLY EVER LENGTHEN THE GAP, AND JITTER NEVER
 * SHORTENS WHAT THEY ASKED FOR. Jitter is applied to our own gap; the floors
 * come after it. Svix does the opposite twice: it clamps `Retry-After` to twice
 * its schedule, and its 429 penalty never applies because a 429 reaches the
 * check as a generic error (the lab measured a 429 and a 500 retried at the
 * same moments). Here a 429 or a timeout waits at least the overload penalty,
 * and `Retry-After` is honoured up to a cap - an endpoint asking for a day is
 * not one we let stall a delivery for a day.
 */
export function nextDelayMs(
  policy: RetryPolicy,
  made: number,
  signals: FailureSignals = {},
  rules: RetryRules = RULES,
  random: () => number = Math.random,
): number | null {
  const gaps = rules.policies[policy].gaps
  if (made > gaps.length) return null
  let seconds = gaps[made - 1]! * (1 + (random() * 2 - 1) * rules.jitter)
  if (signals.status === 429 || signals.timedOut) {
    seconds = Math.max(seconds, rules.overloadPenaltySeconds)
  }
  const asked = parseRetryAfter(signals.retryAfter)
  if (asked !== null) {
    seconds = Math.max(seconds, Math.min(asked, rules.retryAfterCapSeconds))
  }
  return Math.round(seconds * 1000)
}

/**
 * Whether an answer means the endpoint is gone for good, so it is disabled at
 * once rather than retried for a day.
 */
export const isPermanentlyGone = (status: number | undefined): boolean => status === 410
