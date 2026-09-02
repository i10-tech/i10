import type { SendJob } from "../queue/send-queue.js"
import type { Metering } from "../send/metering.js"
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
  /** Records one message as sent. */
  markSent: (message: M, providerMessageId: string) => Promise<void>
  /** Records one attempt as failed. `permanent` stops further attempts. */
  markFailed: (message: M, reason: string, permanent: boolean) => Promise<void>
  transport: Transport
  metering: Metering
  log: Logger
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
    return { claimed: 0, sent: 0, rejected: 0, deferred: 0 }
  }

  const sentIds: string[] = []
  const result: BatchResult = {
    claimed: messages.length,
    sent: 0,
    rejected: 0,
    deferred: 0,
  }

  await inBatches(messages, deps.concurrency, async (message) => {
    let outcome: SendOutcome
    try {
      outcome = await deps.transport.send(message)
    } catch (err) {
      // ⚠ A THROW IS `deferred`, NEVER `rejected`. An exception is the transport
      // failing to give an answer — a socket, a timeout, a bug — and that is not
      // evidence the message is undeliverable. Treating it as permanent drops
      // real mail on the first network blip.
      outcome = { status: "deferred", reason: describe(err) }
    }

    switch (outcome.status) {
      case "sent":
        // Immediately, before anything else. This statement is the whole of the
        // at-least-once window.
        await deps.markSent(message, outcome.providerMessageId)
        sentIds.push(message.id)
        result.sent++
        return

      case "rejected":
        await deps.markFailed(message, outcome.reason, true)
        result.rejected++
        deps.log.warn(
          { messageId: message.id, tenantId: message.tenantId, reason: outcome.reason },
          "message rejected permanently",
        )
        return

      default:
        await deps.markFailed(message, outcome.reason, false)
        result.deferred++
        return
    }
  })

  // ⚠ LAST, OUTSIDE THE PER-MESSAGE PATH, AND GUARDED HERE AS WELL AS IN
  // `resilient()`. The mail has gone. If a billing failure could propagate, the
  // job would fail, groupmq would retry it, and the rows — already `sent` — would
  // be re-sent to fix a billing record.
  //
  // send/metering.ts already swallows, so this catch is redundant when the
  // worker is wired correctly. It is here anyway because the cost of the
  // invariant being merely a convention is duplicate mail, and a raw Metering
  // passed straight in would break it silently. Depth is cheaper than the bug.
  if (sentIds.length > 0) {
    try {
      await deps.metering.recordSent(job.tenantId, sentIds)
    } catch (err) {
      deps.log.error(
        { err, tenantId: job.tenantId, count: sentIds.length },
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
 * ⚠ AND IT NEVER REJECTS. Each unit already handles its own failure; an
 * unhandled rejection escaping here would abandon the rest of the batch
 * mid-flight, leaving those rows claimed and stranded until the stale sweep.
 */
async function inBatches<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const width = Math.max(1, Math.min(limit, items.length))
  let cursor = 0

  const runners = Array.from({ length: width }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++]!
      await fn(item).catch(() => {})
    }
  })

  await Promise.all(runners)
}

function describe(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  return String(err)
}
