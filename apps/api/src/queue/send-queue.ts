import { Queue } from "groupmq"
import type { Redis } from "ioredis"
import type { MessageRef } from "../db/claim.js"

/**
 * The send queue.
 *
 * ⚠ groupmq RATHER THAN BullMQ, AND THE GROUP KEY IS THE WHOLE DESIGN.
 * groupmq's guarantee is per-group FIFO with **one active job per group** at a
 * time. Used naively — group = tenant, job = one message — that is a disaster:
 * a tenant sending ten thousand emails would send them one at a time, capped
 * near five a second by SES round-trip latency alone, far under what SES allows.
 *
 * So a job is a BATCH. One job carries many messages for one tenant, and the
 * worker sends them with internal concurrency. Per-group serialisation then
 * costs nothing, because a group's single active job is already doing N sends
 * in parallel — and what the serialisation buys is fairness: no tenant can have
 * two batches in flight, so a bulk run cannot starve another tenant.
 *
 * ⚠ AND BATCHING HERE IS THE ONLY BATCHING AVAILABLE. SES has no bulk API for
 * arbitrary messages: `SendBulkEmail`'s `DefaultContent` accepts a Template and
 * nothing else, so a product where customers send their own MIME must call
 * `SendEmail` once per message. It would not help anyway — SES's quota counts
 * MESSAGES, not API calls, so fifty in one request would still spend fifty of
 * the send rate. Throughput comes from concurrency and connection reuse, and
 * batching here is about queue overhead and fairness, not about SES.
 */

export interface SendJob {
  /** The tenant, which is also the group key. */
  tenantId: string
  /**
   * The messages to send, already persisted and `queued`.
   *
   * ⚠ REFERENCES, NOT CONTENT. The bodies stay in `core.message_bodies` and are
   * read by the worker after it wins the claim. Putting them in Redis would
   * duplicate every customer's mail into a second store with a different
   * retention policy and no row level security, and would make the queue's
   * memory a function of message size rather than message count.
   */
  messages: MessageRef[]
}

/** The two priority classes. One queue each — see core.ts. */
export type SendClass = "transactional" | "bulk"

export interface SendQueueOptions {
  redis: Redis
  class: SendClass
  /**
   * How long a worker may hold a job before groupmq hands it to another.
   *
   * ⚠ IT MUST BE SHORTER THAN THE DATABASE'S `staleAfter`. Redis governs
   * liveness and Postgres governs correctness; if the database released a row
   * before Redis released the job, two workers would hold both and the
   * compare-and-swap would stop being the tie-breaker. The worker heartbeats
   * anyway, so this bounds a dead worker rather than a slow one.
   */
  jobTimeoutMs?: number
  maxAttempts?: number
}

/**
 * ⚠ THE NAMESPACE IS PART OF THE CONTRACT WITH PSL. i10's Redis is its own
 * instance, never PSL's under a prefix — but the prefix stays explicit anyway,
 * because the failure if that ever changed is two products draining each
 * other's queues, and it would look like messages vanishing.
 */
export const namespaceFor = (cls: SendClass): string => `i10:send:${cls}`

export function createSendQueue(opts: SendQueueOptions): Queue<SendJob> {
  return new Queue<SendJob>({
    redis: opts.redis,
    namespace: namespaceFor(opts.class),
    jobTimeoutMs: opts.jobTimeoutMs ?? 60_000,
    maxAttempts: opts.maxAttempts ?? 5,
    // Keep a window of both for the dashboard and for answering "what happened
    // to this send" without going to the database.
    keepCompleted: 1_000,
    keepFailed: 10_000,
  })
}

/**
 * A stable name for a batch, used as groupmq's `jobId`.
 *
 * ⚠ THIS IS THE SECOND OF THREE IDEMPOTENCY LAYERS, AND NONE OF THEM IS
 * SUFFICIENT ALONE. `Idempotency-Key` stops a replayed HTTP request from
 * minting a second set of rows; this stops the same batch being enqueued twice;
 * the compare-and-swap in db/claim.ts stops two workers sending the same row.
 * They guard three different races.
 *
 * The first message's id names the batch because the batch is minted in one
 * transaction — the ids exist exactly once, so re-enqueueing the same batch
 * produces the same name, and a different batch cannot collide with it.
 */
export function batchJobId(job: SendJob): string {
  const first = job.messages[0]
  if (!first) throw new TypeError("a send job must carry at least one message")
  return `batch:${first.id}`
}

/**
 * Enqueue a batch for one tenant.
 *
 * ⚠ CALLED AFTER THE ROWS ARE COMMITTED, NEVER BEFORE. The database is the
 * record and the queue is a prompt to look at it: a job whose rows do not exist
 * yet is a worker that claims nothing and drops it, and the message is then
 * lost with no error anywhere. Committing first means the worst case is a row
 * that no job points at, which the stale sweep picks up — late, but never lost.
 */
export async function enqueueBatch(
  queue: Queue<SendJob>,
  job: SendJob,
): Promise<string> {
  if (job.messages.length === 0) {
    throw new TypeError("refusing to enqueue an empty batch")
  }

  // Ordering within a group is by `orderMs`. The earliest acceptance time in
  // the batch is the honest answer: it keeps a batch accepted first ahead of
  // one accepted later, which is what a customer watching their own sends
  // expects, and ties break on insertion order.
  const orderMs = Math.min(...job.messages.map((m) => m.createdAt.getTime()))

  const added = await queue.add({
    groupId: job.tenantId,
    jobId: batchJobId(job),
    data: job,
    orderMs,
  })

  return added.id
}
