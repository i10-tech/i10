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

/**
 * The job as it comes BACK off Redis, with its dates restored.
 *
 * ⚠ `SendJob` DESCRIBES WHAT WE PUT IN, NOT WHAT WE GET OUT, AND THE TYPE
 * CANNOT TELL YOU THAT. groupmq stores the payload as JSON, and `JSON.stringify`
 * turns a `Date` into a string with no inverse — so `messages[].createdAt` is
 * typed `Date`, is a `Date` at enqueue, and is a `string` by the time the worker
 * reads it. TypeScript sees `job.data` as `SendJob` on both sides of a boundary
 * that quietly changes it, so nothing anywhere complains.
 *
 * ⚠ AND IT FAILED AT THE FIRST STATEMENT OF THE CLAIM, WHICH IS THE WORST PLACE
 * FOR IT. `claimStatement` calls `r.createdAt.toISOString()`, so every send
 * threw `toISOString is not a function` before touching Postgres — the message
 * stayed `queued`, the job retried forever, and nothing was ever marked failed
 * because the failure happened before the row was claimed. Observed on the very
 * first mail this system ever tried to send.
 *
 * Restored here rather than defended against in `claim.ts`, because the pair
 * `(id, created_at)` is the primary key of a partitioned table and three
 * separate statements depend on it — a coercion at each call site is three
 * chances to forget, and this is one boundary with one owner.
 */
export function reviveSendJob(data: SendJob): SendJob {
  return {
    ...data,
    messages: data.messages.map((m) => ({
      ...m,
      // `new Date` on something already a `Date` is a copy, so this is correct
      // whether or not the payload made a round trip.
      createdAt: new Date(m.createdAt),
    })),
  }
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
    // ⚠ EVERY PROCESS THAT BUILDS ONE OF THESE PASSES `WORKER_MAX_ATTEMPTS`,
    // and it has to: groupmq stamps this on the job at `add()` and `retry.lua`
    // enforces it as a ceiling, while the Worker's own setting is what actually
    // dead-letters. A queue built here with the fallback and a Worker built
    // from the environment is the case where the effective budget is the
    // smaller of two numbers nobody wrote down. The fallback is for tests.
    maxAttempts: opts.maxAttempts ?? 3,
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

export interface EnqueueOptions {
  /**
   * When the job becomes eligible. Omitted means immediately.
   *
   * ⚠ groupmq's SCHEDULER IS WHAT PROMOTES IT, AND ONLY A RUNNING WORKER HAS
   * ONE. Delayed jobs sit in a sorted set until `runSchedulerOnce` moves them
   * to the ready queue, which the Worker does on `schedulerIntervalMs`. With
   * every worker replica down, a due message is not merely late to be sent — it
   * is not even queued, and what recovers it is the stale-message sweep rather
   * than Redis.
   */
  runAt?: Date
  /**
   * A name other than `batchJobId`. Only the sweep passes this.
   *
   * ⚠ AND IT HAS TO BE ABLE TO. `batchJobId` is stable by design, and
   * `enqueue.lua` treats a name it has seen before as a duplicate — with
   * `keepCompleted: 1000` the job hash of a completed batch is still present,
   * so re-adding its id returns that id and enqueues NOTHING. Re-enqueueing a
   * batch that already ran therefore has to say so with a different name; see
   * `sweepJobId` in send/sweep.ts for why that name carries the sweep's clock.
   */
  jobId?: string
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
  opts: EnqueueOptions = {},
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
    jobId: opts.jobId ?? batchJobId(job),
    data: job,
    // ⚠ ORDERED BY WHEN IT IS DUE, NOT BY WHEN IT WAS ACCEPTED. A message
    // scheduled for tomorrow that kept its acceptance time would jump ahead of
    // everything accepted after it the moment it was promoted, which is the
    // opposite of what the group's FIFO ordering is for.
    orderMs: opts.runAt ? opts.runAt.getTime() : orderMs,
    ...(opts.runAt ? { runAt: opts.runAt } : {}),
  })

  return added.id
}
