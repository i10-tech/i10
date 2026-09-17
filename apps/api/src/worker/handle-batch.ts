import type { DeliveryRoute } from "../domains/route.js"
import { describeError } from "../errors.js"
import type { SendJob } from "../queue/send-queue.js"
import type { Metering, SentMessage } from "../send/metering.js"
import type { OutboundMessage, SendOutcome, Transport } from "../send/transport.js"

/**
 * Sending one batch.
 *
 * This is where the queue, the claim and the metering finally meet, and the
 * order of the four steps is the whole of the correctness argument:
 *
 *   1. CLAIM   compare-and-swap in Postgres. Anything not won belongs to
 *              another worker and is dropped, never retried.
 *   2. SEND    bounded concurrency, one provider call per message.
 *   3. RECORD  immediately after each call returns, per message.
 *   4. METER   after the fact, and unable to affect any of the above.
 *
 * ⚠ CLAIM BEFORE SEND, ALWAYS, AND NEVER THE OTHER WAY ROUND. groupmq's lease
 * is liveness — it guarantees the job is picked up again, not that it runs
 * once. Two workers can legitimately hold the same job when a lease expires
 * under load, and the claim is the only thing that decides between them.
 *
 * ⚠ RECORD PER MESSAGE, NOT PER BATCH. Writing the whole batch's results at the
 * end would widen the at-least-once window from one statement to the length of
 * the batch: a worker that dies halfway through five hundred sends would leave
 * every one of them unrecorded, and the retry would send all five hundred
 * again. Per message, the exposure is whatever single call was in flight.
 */

export interface Logger {
  info: (o: object, m: string) => void
  warn: (o: object, m: string) => void
  error: (o: object, m: string) => void
}

/**
 * What the handler needs. All injected, so the whole thing is testable.
 *
 * ⚠ PARAMETERISED ON THE MESSAGE TYPE SO THE CLAIM CAN CARRY MORE THAN THE
 * TRANSPORT SEES. The database adapter returns a `ClaimedMessage`, which adds
 * the `created_at` that `core.messages`'s partition key needs — recording the
 * result requires it, and it must be the value the database returned rather
 * than one re-derived from the id. Typing it here is what stops that field
 * being dropped on the way through.
 */
export interface BatchDeps<M extends OutboundMessage = OutboundMessage> {
  /**
   * Claims the batch and returns only the messages this worker won, already
   * loaded with everything the transport needs.
   */
  claim: (job: SendJob) => Promise<M[]>
  /**
   * Records one message as sent, and returns the `sent_at` it stored.
   *
   * ⚠ THE RETURNED TIMESTAMP IS WHAT THE METER IS BILLED ON, so it has to be
   * the database's value rather than the worker's clock — see send/metering.ts.
   * Null means the write did not happen: the claim had moved on, and nothing
   * about this message is ours to bill.
   */
  markSent: (
    message: M,
    providerMessageId: string,
    route: DeliveryRoute,
  ) => Promise<Date | null>
  /** Records one attempt as failed. `permanent` stops further attempts. */
  markFailed: (message: M, reason: string, permanent: boolean) => Promise<void>

  /**
   * Which MTA carries this message.
   *
   * ⚠ PER MESSAGE, NOT PER BATCH, BECAUSE A BATCH IS PER TENANT AND A ROUTE IS
   * PER DOMAIN. One tenant can hold a warmed domain pinned to SES and a new one
   * sending direct, and both can appear in the same job — so resolving once for
   * the batch would send some of it the wrong way.
   */
  route: (message: M) => DeliveryRoute

  /**
   * The transport for a resolved route.
   *
   * ⚠ A LOOKUP RATHER THAN A SINGLE `transport`, AND THAT IS THE WHOLE OF THE
   * ROUTING CHANGE ON THIS SIDE. Everything else here — the claim, the
   * concurrency, the metering, the stranded-write handling — is written against
   * three outcomes and does not care who produced them.
   */
  transportFor: (route: DeliveryRoute) => Transport
  metering: Metering
  log: Logger
  /**
   * Reports a failure that is ours rather than a provider's. Optional so tests
   * and a local run need no Sentry.
   *
   * ⚠ IT EXISTS BECAUSE THE ONE FAILURE THIS FILE CANNOT HANDLE WAS THE ONE IT
   * SWALLOWED. See `inBatches`.
   */
  reportError?: (error: unknown, context?: Record<string, unknown>) => void
  /**
   * How many provider calls may be in flight at once.
   *
   * ⚠ IT IS A THROUGHPUT KNOB AND A QUOTA KNOB AT THE SAME TIME. SES caps a
   * send RATE in messages per second, and every worker replica spends from the
   * same budget — so this is per replica and the product of the two is what
   * SES sees. Set it from the account's rate divided by the replica count, not
   * from what one process can manage.
   */
  concurrency: number
}

export interface BatchResult {
  claimed: number
  sent: number
  rejected: number
  deferred: number
  /**
   * Messages whose OUTCOME could not be written down.
   *
   * ⚠ THESE ARE THE EXPENSIVE ONES AND THEY USED TO BE INVISIBLE. Reaching here
   * means the send itself returned but recording it threw — Postgres, in
   * practice — so the row is still `sending`, the mail may well have gone, and
   * nothing has been billed. Counted separately from `deferred` because a
   * deferral is the provider saying "not now" and this is us failing to keep
   * our own books.
   */
  stranded: number
}

export async function handleBatch<M extends OutboundMessage>(
  job: SendJob,
  deps: BatchDeps<M>,
): Promise<BatchResult> {
  const messages = await deps.claim(job)

  // ⚠ NOT AN ERROR, AND NOT A REASON TO RETRY. Losing the claim means another
  // worker owns these — which is the mechanism working. Throwing here would
  // make groupmq retry the job and race that worker again, turning a clean
  // hand-off into a duplicate.
  if (messages.length === 0) {
    deps.log.info(
      { tenantId: job.tenantId, batch: job.messages.length },
      "batch already claimed elsewhere",
    )
    return { claimed: 0, sent: 0, rejected: 0, deferred: 0, stranded: 0 }
  }

  const sent: SentMessage[] = []
  const result: BatchResult = {
    claimed: messages.length,
    sent: 0,
    rejected: 0,
    deferred: 0,
    stranded: 0,
  }

  await inBatches(
    messages,
    deps.concurrency,
    async (message) => {
      // Resolved before the send so the same value decides who carries the
      // message and what the row records about it afterwards.
      const route = deps.route(message)

      let outcome: SendOutcome
      try {
        outcome = await deps.transportFor(route).send(message)
      } catch (err) {
        // ⚠ A THROW IS `deferred`, NEVER `rejected`. An exception is the transport
        // failing to give an answer — a socket, a timeout, a bug — and that is not
        // evidence the message is undeliverable. Treating it as permanent drops
        // real mail on the first network blip.
        outcome = { status: "deferred", reason: describeError(err) }
      }

      switch (outcome.status) {
        case "sent": {
          // Immediately, before anything else. This statement is the whole of the
          // at-least-once window.
          const at = await deps.markSent(message, outcome.providerMessageId, route)
          // ⚠ ONLY BILLED IF THE ROW WAS ACTUALLY OURS TO RECORD. A null means
          // another worker owns it and will record — and bill — it itself.
          if (at) sent.push({ id: message.id, sentAt: at })
          result.sent++
          return
        }

        case "rejected":
          await deps.markFailed(message, outcome.reason, true)
          result.rejected++
          deps.log.warn(
            {
              messageId: message.id,
              tenantId: message.tenantId,
              reason: outcome.reason,
            },
            "message rejected permanently",
          )
          return

        default:
          await deps.markFailed(message, outcome.reason, false)
          result.deferred++
          return
      }
    },
    // ⚠ THE ONE FAILURE THIS FILE COULD NOT HANDLE, AND IT USED TO BE DISCARDED
    // WITHOUT A WORD. `transport.send` has its own try/catch above, so what
    // reaches here is `markSent`, `markFailed` or the log call throwing —
    // Postgres, in practice. The mail may already have gone: the row is left
    // `sending`, nothing is billed, and until now there was no log line, no
    // Sentry event and no count to notice it by. The stale sweep is what
    // eventually recovers the row; this is what says it happened.
    (error, message) => {
      result.stranded++
      deps.log.error(
        { err: error, messageId: message.id, tenantId: message.tenantId },
        "could not record the outcome of a send",
      )
      deps.reportError?.(error, { messageId: message.id, tenantId: message.tenantId })
    },
  )

  // ⚠ LAST, OUTSIDE THE PER-MESSAGE PATH, AND GUARDED HERE AS WELL AS IN
  // `resilient()`. The mail has gone. If a billing failure could propagate, the
  // job would fail, groupmq would retry it, and the rows — already `sent` — would
  // be re-sent to fix a billing record.
  //
  // send/metering.ts already swallows, so this catch is redundant when the
  // worker is wired correctly. It is here anyway because the cost of the
  // invariant being merely a convention is duplicate mail, and a raw Metering
  // passed straight in would break it silently. Depth is cheaper than the bug.
  if (sent.length > 0) {
    try {
      await deps.metering.recordSent(job.tenantId, sent)
    } catch (err) {
      deps.log.error(
        { err, tenantId: job.tenantId, count: sent.length },
        "usage not recorded — the reconciler will close the gap",
      )
    }
  }

  deps.log.info({ tenantId: job.tenantId, ...result }, "batch complete")
  return result
}

/**
 * Runs `fn` over everything with at most `limit` in flight.
 *
 * ⚠ NOT `Promise.all` OVER THE WHOLE BATCH. A batch may be five hundred
 * messages; five hundred simultaneous provider calls would blow through the
 * send rate, collect a wall of 429s, and defer most of the batch — converting a
 * throughput problem into a retry storm. Bounded concurrency is the only reason
 * batching helps rather than hurts.
 *
 * ⚠ AND IT NEVER REJECTS. An unhandled rejection escaping here would abandon
 * the rest of the batch mid-flight, leaving those rows claimed and stranded
 * until the stale sweep.
 *
 * ⚠ BUT IT NO LONGER DISCARDS WHAT IT CAUGHT. `.catch(() => {})` was doing two
 * jobs — keeping the batch running, and throwing away the only evidence that a
 * message's outcome was never written down — and only the first was intended.
 * `onError` is what separates them: the batch still finishes, and the failure
 * is still reported.
 */
async function inBatches<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
  onError: (error: unknown, item: T) => void,
): Promise<void> {
  const width = Math.max(1, Math.min(limit, items.length))
  let cursor = 0

  const runners = Array.from({ length: width }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++]!
      try {
        await fn(item)
      } catch (error) {
        // ⚠ THE REPORT ITSELF MUST NOT BE ABLE TO STOP THE BATCH. It logs and
        // calls out to Sentry, and a logger that throws here would take the
        // remaining messages with it — the exact failure the catch exists to
        // prevent, arriving through the handler for it.
        try {
          onError(error, item)
        } catch {
          /* nothing left to report it to */
        }
      }
    }
  })

  await Promise.all(runners)
}
