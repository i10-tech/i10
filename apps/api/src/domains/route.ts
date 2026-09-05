/**
 * Which MTA a domain's mail leaves through.
 *
 * ⚠ PURE, AND DELIBERATELY NOT WHERE THE DECISION IS ENFORCED. Stalwart chooses
 * the route itself, per recipient, by evaluating an expression against its own
 * queue — see docs/decisions/mail-routing.md. This is the same rule expressed
 * where our own code can read it: the dashboard renders it, the API answers
 * with it, and the function Stalwart calls returns it. One rule, three readers,
 * and none of them entitled to a different answer.
 */

/** The stored preference. `auto` means "ask the plan". */
export type RouteOverride = "auto" | "ses" | "direct"

/** The resolved answer. There is no `auto` here — something must send. */
export type DeliveryRoute = "ses" | "direct"

export interface RouteInput {
  /** The domain's own setting. A support control, not a customer-facing one. */
  override: RouteOverride
  /** The plan the tenant holds, or `null` if they hold none. */
  planId: string | null
  /** Which plan id counts as free. From `METERING_FREE_PLAN_ID`. */
  freePlanId: string
}

/**
 * ⚠ AN OVERRIDE BEATS THE PLAN, INCLUDING FOR A PAYING CUSTOMER. That is the
 * whole reason it exists: a customer whose deliverability needs one specific
 * path, or one being moved off a route that is having a bad day, must not be
 * silently moved back by their plan.
 *
 * ⚠ AND A TENANT WITH NO PLAN SENDS DIRECT. It is our misconfiguration rather
 * than their fault — the quota path already fails open for exactly this state —
 * so their mail goes. Sending it through SES would mean paying a per-message
 * fee for a tenant we have no billing relationship with, which is the version
 * of this failure that costs money silently.
 */
export function resolveRoute({
  override,
  planId,
  freePlanId,
}: RouteInput): DeliveryRoute {
  if (override !== "auto") return override
  // ⚠ Free is the DEFAULT, not the exception: anything we do not recognise as a
  // paid plan lands here. A plan id renamed in the catalogue would otherwise
  // start spending SES money on free tenants.
  return planId === null || planId === freePlanId ? "direct" : "ses"
}
