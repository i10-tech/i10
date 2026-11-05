/**
 * Which MTA a domain's mail leaves through - one shared rule for both classes
 * of mail.
 *
 * ⚠ TWO READERS, ONE RULE. Transactional mail calls `resolveRoute` in the API
 * and worker. Mailbox mail enters Stalwart's queue directly, so Stalwart
 * evaluates the SQL mirror, `core.resolve_route`, through `core.mailbox_route`.
 * Both classes use SES by default on every plan; only the kill switch and a
 * per-domain override can choose direct delivery.
 *
 * ⚠ PURE, AND NOT WHERE THE MAILBOX DECISION IS ENFORCED. See
 * docs/decisions/mail-routing.md.
 */

/** The stored preference. `auto` means "whatever the rule for this class says". */
export type RouteOverride = "auto" | "ses" | "direct"

/** The resolved answer. There is no `auto` here - something must send. */
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

/**
 * The shared route.
 *
 * ⚠ THE PLAN IS NOT AN INPUT, AND THAT IS THE CHANGE #155 MADE. It used to
 * send free tenants direct to save the SES per-message fee. That traded a
 * fraction of a cent for putting the least-vetted senders on our own IP - the
 * one Stalwart's human mail leaves from - and outside SES's per-tenant
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
