/**
 * Metering and quota — the seam the meter plugs into.
 *
 * ⚠ QUOTA IS NOT AUTHENTICATION, AND THE TWO MUST NOT COLLAPSE. `requireApiKey`
 * answers "is this key valid and what may it do". This answers "does this
 * tenant have sending budget left". They fail differently and they are owned by
 * different systems, and merging them would make it impossible to sell a plan
 * that differs only by volume — and would make `rate_limit_exceeded`, which is
 * retryable, indistinguishable from `daily_quota_exceeded`, which is not.
 *
 * ⚠ CHECKED AT ADMISSION, RECORDED AT SEND, AND THOSE ARE DIFFERENT MOMENTS ON
 * PURPOSE.
 *
 * Checking at admission is what lets `POST /emails` reject over-quota traffic in
 * milliseconds without touching the send path. It reads a cached balance, so it
 * is approximate: a burst can slip past a stale answer. That is the right
 * trade — the alternative is a synchronous call to a third party on the hot
 * path of every send, which would make a billing service's availability
 * i10's availability. It was Autumn's; the port outlived it.
 *
 * Recording at send is what makes the number true. Billing on acceptance would
 * charge for messages that were never delivered because the address was
 * malformed or the tenant was suppressed, and a customer reading their invoice
 * would be right to complain.
 *
 * The gap between the two — accepted but not yet sent — is bounded by the queue
 * depth, and it is the reason `checkQuota` returns a decision rather than a
 * number: over-quota is a policy answer, not arithmetic the caller redoes.
 */

export type QuotaOutcome =
  /** Within budget. Proceed. */
  | { status: "allowed" }
  /**
   * Out of budget. A 429 with `daily_quota_exceeded`, and NOT retryable — the
   * SDKs back off on 429, and backing off will not create budget.
   */
  | { status: "exceeded"; message: string; resetsAt?: Date }
  /**
   * ⚠ THE ONE THAT MATTERS. The meter did not answer, so we do not know. Same rule
   * as `verifyApiKey` and as authd answering LDAP `unavailable`: a metering
   * outage must never be reported as "you are over quota", because the customer
   * responds by upgrading a plan that was fine.
   *
   * What the caller does with it is a policy decision — see `failOpen`.
   */
  | { status: "unavailable"; message: string }

/**
 * One message that was sent, and when the database says it was.
 *
 * ⚠ `sentAt` IS THE STORED VALUE, NOT THE WORKER'S CLOCK, AND IT IS NOT
 * COSMETIC. The reconciler buckets i10's side by `core.messages.sent_at` and
 * the meter's side by the event timestamp we hand it. If those differ by even a
 * millisecond across midnight, one day shows a deficit and the next a surplus —
 * and the deficit gets topped up, every run, forever. Threading the value the
 * UPDATE returned is what keeps the two sides on one clock.
 */
export interface SentMessage {
  id: string
  sentAt: Date
}

export interface Metering {
  /**
   * Called once per accepted request, before the rows are written.
   *
   * `count` is the number of messages the request would create, so a batch of
   * five hundred is one call rather than five hundred.
   */
  checkQuota(tenantId: string, count: number): Promise<QuotaOutcome>

  /**
   * Called after the provider accepted the messages.
   *
   * ⚠ IT TAKES MESSAGE IDS, NOT A COUNT, AND THAT IS WHAT MAKES THE BOOKS
   * FIXABLE. A count can only ever be added; an id can be checked. `track` is
   * idempotent on the message id, so a message id is a key that cannot
   * double-bill however many times it is presented. The reconciler below depends
   * on that entirely, and depended on the same property when the id was an
   * `Idempotency-Key` header to somebody else's service.
   *
   * ⚠ AND IT MUST NOT BE ABLE TO FAIL A SEND THAT ALREADY HAPPENED. The mail
   * has gone; throwing here would return the row to the queue and send it twice
   * to fix a billing record.
   */
  recordSent(tenantId: string, sent: readonly SentMessage[]): Promise<void>
}

/**
 * ⚠ FAIL OPEN, AND SAY SO OUT LOUD.
 *
 * When metering is unreachable, i10 sends. The reasoning is that the cost of
 * being wrong is asymmetric and neither side is free: refusing means a paying
 * customer's password resets stop because a billing service is down, which is
 * an outage they did not buy; allowing means a small amount of unbilled usage
 * during an incident we can see in the logs and reconcile afterwards.
 *
 * It is a real decision with a real cost, not an oversight, and it belongs in
 * one named place rather than implied by a `catch` somewhere in the route.
 */
export function shouldSend(outcome: QuotaOutcome, failOpen = true): boolean {
  switch (outcome.status) {
    case "allowed":
      return true
    case "exceeded":
      return false
    default:
      return failOpen
  }
}

/**
 * Metering that allows everything and counts nothing.
 *
 * Used in tests. ⚠ It is
 * DELIBERATELY not the production default: `createApp` takes metering as a
 * dependency, so shipping without it is a visible omission in one place rather
 * than a silent one at every call site.
 */
export const unmetered: Metering = {
  checkQuota: async () => ({ status: "allowed" }),
  recordSent: async () => {},
}

/**
 * Wraps any Metering so that `recordSent` can never throw into the send path,
 * and a failed check degrades to `unavailable` rather than to an exception.
 *
 * ⚠ A SWALLOWED `recordSent` IS REVENUE NEVER COUNTED, AND THAT IS ACCEPTABLE
 * ONLY BECAUSE SOMETHING ELSE FINDS IT. `core.messages` is the billing source
 * of truth — every `sent` row is one billable unit with `sent_at` as its clock —
 * and send/reconcile.ts compares it against what the meter actually recorded. The
 * log line is a signal, not the record.
 */
export function resilient(inner: Metering, log?: Logger): Metering {
  return {
    async checkQuota(tenantId, count) {
      try {
        return await inner.checkQuota(tenantId, count)
      } catch (err) {
        log?.warn({ err, tenantId }, "quota check failed")
        return { status: "unavailable", message: "Could not check the sending quota." }
      }
    },
    async recordSent(tenantId, sent) {
      try {
        await inner.recordSent(tenantId, sent)
      } catch (err) {
        // ⚠ NOT RETRIED HERE, ON PURPOSE. A bulk write has no per-item
        // idempotency, so retrying re-submits the items that already succeeded
        // and double-counts them; a gap is preferable to a duplicate, because
        // the reconciler can find a gap and cannot find a duplicate. The hot
        // path takes the gap and the reconciler closes it — see
        // send/reconcile.ts. Autumn's own documentation said the same thing,
        // and the reasoning is a property of bulk writes rather than of Autumn.
        log?.error(
          { err, tenantId, count: sent.length },
          "usage not recorded — the reconciler will close the gap",
        )
      }
    },
  }
}

interface Logger {
  warn: (o: object, m: string) => void
  error: (o: object, m: string) => void
}
