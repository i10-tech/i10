import { acceptSend, type AcceptOps, type Logger } from "../send/accept.js"
import type { Metering } from "../send/metering.js"
import type { AuthEmailSend, AuthEmailSender } from "./deliver.js"

/**
 * Sends i10's own authentication mail down i10's own send path.
 *
 * ⚠ IT GOES THROUGH `acceptSend` RATHER THAN STRAIGHT TO SES, and that is the
 * point of doing this at all. The send path is where DKIM signing, the
 * suppression list, the message log, delivery events and the retrying worker
 * live. A separate direct-to-SES path for auth mail would be a second sender
 * with none of that — invisible in the dashboard, ignoring suppressions, and
 * bouncing repeatedly at an address that already hard-bounced, which is exactly
 * how a sending domain's reputation is destroyed.
 */
export interface AuthEmailSenderOptions {
  /**
   * i10's own tenant.
   *
   * ⚠ RESOLVED BY SLUG AT BOOT, NEVER HARDCODED. The id is generated per
   * deployment — migration 0029 makes the same point when it attributes
   * i10.tech by slug. A literal uuid would silently send nothing anywhere but
   * the deployment it was copied from.
   */
  tenantId: string
  /** e.g. `i10 <no-reply@i10.tech>`. */
  from: string
  ops: AcceptOps
  metering: Metering
  log: Logger
}

/**
 * ⚠ QUOTA IS DELIBERATELY NOT ENFORCED ON THIS PATH, AND THE WRAPPER IS HOW.
 * `acceptSend` refuses a tenant that is out of budget, which is right for a
 * customer's mail and catastrophic for ours: nobody could verify an address or
 * reset a password because i10 had sent too much of its own mail that month.
 * Usage is still RECORDED — `track` passes straight through — so the volume is
 * visible; it simply cannot bar the door.
 */
function unmetered(metering: Metering): Metering {
  return {
    ...metering,
    checkQuota: async () => ({ status: "allowed" as const }),
  }
}

export function authEmailSender(options: AuthEmailSenderOptions): AuthEmailSender {
  const deps = {
    ...options.ops,
    metering: unmetered(options.metering),
    log: options.log,
  }

  return {
    async send(input: AuthEmailSend) {
      const outcome = await acceptSend(
        {
          tenantId: options.tenantId,
          // No key: this is not a customer's request. See `AcceptOps.persist`.
          apiKeyId: null,
          endpoint: "single",
          // ⚠ CLERK'S EMAIL ID. The send path refuses to write the same key
          // twice, which is what makes a Svix redelivery harmless — see
          // deliver.ts.
          idempotencyKey: input.idempotencyKey,
          payloads: [
            {
              from: options.from,
              to: [input.to],
              subject: input.subject,
              html: input.html,
              ...(input.text ? { text: input.text } : {}),
            },
          ],
        },
        deps,
      )

      // ⚠ THROWN, NOT SWALLOWED, SO THE WEBHOOK ANSWERS 500 AND SVIX RETRIES.
      // The alternative — logging and returning 200 — tells Clerk the mail was
      // handled and loses somebody's verification code permanently. The
      // idempotency key above is what makes the retry safe.
      if (outcome.status !== "accepted") {
        throw new Error(`auth email refused by the send path: ${outcome.status}`)
      }
    },
  }
}
