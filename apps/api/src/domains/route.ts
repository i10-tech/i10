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
  /**
   * Whether SES may be used at all. From `SES_ENABLED`.
   *
   * ⚠ AN OPERATOR SWITCH, NOT A HEALTH PROBE, AND THE DISTINCTION IS
   * DELIBERATE. `Transport` already absorbs SES having a bad day: a throttle or
   * a five hundred comes back `deferred` and the message returns to the queue
   * with its attempt counted, so nothing is lost. A route flip only buys
   * anything in a SUSTAINED outage.
   *
   * ⚠ AND AUTOMATING IT WOULD BREAK THE PROPERTY THIS FILE EXISTS FOR. A health
   * signal makes the answer time-varying, so the dashboard, the API and
   * Stalwart could each hold a different answer for one domain at one moment —
   * "one rule, three readers" stops being true. It would also move a paying
   * customer onto our own IP reputation, with a different return path, without
   * a person deciding to.
   */
  sesEnabled: boolean
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
  sesEnabled,
}: RouteInput): DeliveryRoute {
  // ⚠ FIRST, AND IT BEATS AN EXPLICIT `ses` OVERRIDE TOO. The switch exists to
  // be thrown during an incident, and a route that a support override could
  // pin past it would leave exactly the domains somebody cared enough to pin
  // still pointed at the thing that is down.
  if (!sesEnabled) return "direct"

  if (override !== "auto") return override
  // ⚠ Free is the DEFAULT, not the exception: anything we do not recognise as a
  // paid plan lands here. A plan id renamed in the catalogue would otherwise
  // start spending SES money on free tenants.
  return planId === null || planId === freePlanId ? "direct" : "ses"
}
