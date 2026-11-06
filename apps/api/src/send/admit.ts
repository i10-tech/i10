import { shouldSend, type Metering } from "./metering.js"

/**
 * Whether a workspace may send right now: the risk hold, then the plan and the
 * free tier's monthly line.
 *
 * ⚠ ONE DECISION FOR EVERY WAY OF SENDING. `acceptSend` asks it for an API send
 * and the Stalwart MTA hook (`mail/mta-hook.ts`) asks it for a mailbox send, so
 * a workspace that is held, or out of allowance, is refused by both for the same
 * reason in the same words. Two copies of these rules would be two places for a
 * new tier or a new hold category to be remembered.
 *
 * ⚠ IT READS AND NEVER WRITES. Usage is recorded when the mail has gone, by the
 * worker, so asking twice about one message (the hook is consulted once per
 * recipient) costs queries and nothing else.
 */

/**
 * The refusals, shaped as the matching members of `AcceptOutcome` so `acceptSend`
 * can return one unchanged.
 */
export type Refusal =
  | { status: "held"; message: string }
  | {
      status: "quota_exceeded"
      message: string
      code: "daily_quota_exceeded" | "monthly_quota_exceeded"
    }

export interface AdmitDeps {
  /**
   * Whether the risk engine holds this workspace (#170), in the customer-facing
   * words, and how far the hold reaches. Null when it does not hold it.
   *
   * ⚠ OPTIONAL AND ABSENT FOR OUR OWN MAIL, so sign-in codes never wait on a
   * review of some workspace.
   */
  sendingHeld?: (tenantId: string) => Promise<{ why: string; scope: HoldScope } | null>
  metering: Metering
}

/** `api` stops API sends; `all` also stops mailboxes and is staff-only. */
export type HoldScope = "api" | "all"

/** Which door the send came through. */
export type Surface = "api" | "mailbox"

/**
 * Null when the workspace may send `count` messages, the refusal when not.
 *
 * ⚠ `count` IS MESSAGES, NOT RECIPIENTS. It is what `acceptSend` has always
 * asked the meter - a request of five payloads is five, whoever each one is
 * addressed to - and a mailbox send is one message however many people are on
 * it, so the hook passes 1.
 *
 * ⚠ A HOLD'S SCOPE DECIDES WHETHER A MAILBOX IS STOPPED. The score only ever
 * writes `scope: "api"`; only staff can write `all` (risk.md, "Holds"). Mailboxes
 * are people's own mail, so an automatic decision about a workspace's API traffic
 * must not silence them - an API send is stopped by either scope.
 */
export async function admitSend(
  tenantId: string,
  count: number,
  deps: AdmitDeps,
  surface: Surface = "api",
): Promise<Refusal | null> {
  const held = await deps.sendingHeld?.(tenantId)
  if (held && (surface === "api" || held.scope === "all")) {
    return {
      status: "held",
      message:
        `Sending is on hold for this workspace while we review it: ${held.why}. ` +
        "A person will review it within a day. Reply to the email we sent the " +
        "workspace owner, or contact support, to speed that up.",
    }
  }

  // ⚠ FIRST, AND CHEAPLY. Rejecting an over-quota tenant before writing
  // anything is the difference between a 429 in milliseconds and a database
  // full of messages that will never be allowed to send.
  const quota = await deps.metering.checkQuota(tenantId, count)
  if (!shouldSend(quota)) {
    return {
      status: "quota_exceeded",
      message: quota.status === "exceeded" ? quota.message : "Sending quota exceeded.",
      code: (quota.status === "exceeded" && quota.code) || "daily_quota_exceeded",
    }
  }

  return null
}
