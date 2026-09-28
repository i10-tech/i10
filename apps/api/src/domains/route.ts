/**
 * Which MTA a domain's mail leaves through — one rule per class of mail.
 *
 * ⚠ TWO CLASSES, TWO RULES, AND SINCE #155 THEY DELIBERATELY DIFFER.
 *
 * - **Transactional** (`resolveRoute`): mail our API accepted and our worker
 *   sends. Every plan goes through SES, free included — so a free sender is on
 *   the same path, the same reputation controls and the same event pipeline as
 *   a paying one, and never on the IP our human mailboxes share.
 * - **Mailbox** (`resolveMailboxRoute`): mail a person's client submitted into
 *   Stalwart's queue. Still decided by plan, because the only way to reach SES
 *   from Stalwart is the `ses-relay` route, which does not exist yet (#191).
 *   Stalwart evaluates this itself by calling `core.resolve_route`; the
 *   function here is the same rule where our own code can read it.
 *
 * ⚠ PURE, AND NOT WHERE THE MAILBOX DECISION IS ENFORCED. See
 * docs/decisions/mail-routing.md.
 */

/** The stored preference. `auto` means "whatever the rule for this class says". */
export type RouteOverride = "auto" | "ses" | "direct"

/** The resolved answer. There is no `auto` here — something must send. */
export type DeliveryRoute = "ses" | "direct"

export interface RouteInput {
  /** The domain's own setting. A support control, not a customer-facing one. */
  override: RouteOverride
  /**
   * Whether SES may be used at all. From `SES_ENABLED`.
   *
   * ⚠ AN OPERATOR SWITCH, NOT A HEALTH PROBE, AND THE DISTINCTION IS
   * DELIBERATE. `Transport` already absorbs SES having a bad day: a throttle or
   * a five hundred comes back `deferred` and the message returns to the queue
   * with its attempt counted, so nothing is lost. A route flip only buys
   * anything in a SUSTAINED outage.
   *
   * ⚠ AND AUTOMATING IT WOULD MAKE THE ANSWER TIME-VARYING, so the dashboard,
   * the API and Stalwart could each hold a different answer for one domain at
   * one moment. It would also move a customer onto our own IP reputation, with
   * a different return path, without a person deciding to.
   */
  sesEnabled: boolean
}

export interface MailboxRouteInput extends RouteInput {
  /** The plan the tenant holds, or `null` if they hold none. */
  planId: string | null
  /** Which plan id counts as free. From `METERING_FREE_PLAN_ID`. */
  freePlanId: string
}

/**
 * The transactional route.
 *
 * ⚠ THE PLAN IS NOT AN INPUT, AND THAT IS THE CHANGE #155 MADE. It used to
 * send free tenants direct to save the SES per-message fee. That traded a
 * fraction of a cent for putting the least-vetted senders on our own IP — the
 * one Stalwart's human mail leaves from — and outside SES's per-tenant
 * reputation, suppression and pause controls, which are the ones abuse
 * handling is built on. Free volume is capped by metering, so the fee is
 * bounded; a blocklisted mailbox IP is not.
 *
 * ⚠ THE KILL SWITCH FIRST, AND IT BEATS AN EXPLICIT `ses` OVERRIDE TOO. The
 * switch exists to be thrown during an incident, and a route a support
 * override could pin past it would leave exactly the domains somebody cared
 * enough to pin still pointed at the thing that is down.
 *
 * ⚠ THEN THE OVERRIDE, which still exists so support can move one domain off
 * SES deliberately.
 */
export function resolveRoute({ override, sesEnabled }: RouteInput): DeliveryRoute {
  if (!sesEnabled) return "direct"
  if (override !== "auto") return override
  return "ses"
}

/**
 * The mailbox route — the TypeScript mirror of `core.resolve_route`
 * (0036_mailbox_lever.sql), which is what Stalwart actually calls.
 *
 * ⚠ AN OVERRIDE BEATS THE PLAN, INCLUDING FOR A PAYING CUSTOMER. A customer
 * whose deliverability needs one specific path, or one being moved off a route
 * that is having a bad day, must not be silently moved back by their plan.
 *
 * ⚠ A TENANT WITH NO PLAN SENDS DIRECT: our misconfiguration rather than
 * theirs, and their mail still goes.
 *
 * ⚠ FREE IS RECOGNISED BY NAME AND EVERYTHING ELSE IS TREATED AS PAID. A plan
 * id renamed in the catalogue without moving `METERING_FREE_PLAN_ID` therefore
 * routes free mailboxes to SES. The SQL does the same, and must: the two are
 * asserted against one table. Whether free mailbox mail should use SES at all
 * is #191.
 */
export function resolveMailboxRoute({
  override,
  planId,
  freePlanId,
  sesEnabled,
}: MailboxRouteInput): DeliveryRoute {
  if (!sesEnabled) return "direct"
  if (override !== "auto") return override
  return planId === null || planId === freePlanId ? "direct" : "ses"
}
