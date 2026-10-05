import { Queue } from "groupmq"
import type { Redis } from "ioredis"

/**
 * The webhook delivery queue.
 *
 * ⚠ THE GROUP IS THE ENDPOINT, NOT THE TENANT, AND THAT CHOICE BUYS TWO THINGS
 * AT ONCE. groupmq runs one job per group at a time, in order - so grouping by
 * endpoint means a customer's events arrive at that endpoint in the order they
 * happened (`email.sent` before `email.delivered`, or their state machine reads
 * backwards), and a staging endpoint that has been timing out for an hour
 * cannot hold up the production endpoint beside it.
 *
 * Grouping by tenant would give ordering across a tenant's endpoints, which
 * nobody wants, at the cost of exactly the head-of-line blocking that matters.
 *
 * ⚠ AND A JOB IS ONE DELIVERY, UNLIKE THE SEND QUEUE. There, batching is what
 * keeps per-group serialisation from capping throughput. Here serialisation IS
 * the feature, and a batch would have to be delivered in order anyway - so the
 * batch would buy nothing and would make a single failing event retry the ones
 * beside it.
 */

export interface WebhookJob {
  deliveryId: string
  endpointId: string
  tenantId: string
  /**
   * Which attempt this job is: the row's `attempts` when it was queued. Part
   * of the job id, so each attempt is its own job (see `webhookJobId`).
   */
  attempt?: number
  /** What started this attempt, for the attempt log. Default `scheduled`. */
  trigger?: "scheduled" | "manual" | "recover" | "replay" | "test"
}

export interface EnqueueDeliveryOptions {
  /**
   * When the event happened, which is what the group is ordered by.
   *
   * ⚠ WITHOUT IT THE ORDERING PROMISED ABOVE IS ONLY THE ORDER THINGS REACHED
   * REDIS. SES publishes `Send` and `Delivery` for one message milliseconds
   * apart and SNS fans them out as two concurrent requests; whichever commits
   * first would be delivered first, so a customer could see `email.delivered`
   * before `email.sent`. Ordering on the event's own clock is what makes the
   * per-endpoint guarantee real rather than incidental.
   */
  orderMs: number
  /** Not before this many milliseconds from now: a scheduled retry. */
  delayMs?: number
  /**
   * Makes the job id unique to one request, for a resend or a replay. Without
   * it a second resend of the same delivery would share an id with the first,
   * which groupmq may still remember completing, and be dropped as a repeat.
   */
  jobTag?: string
}

export const WEBHOOK_NAMESPACE = "i10:webhooks"

/**
 * Above every plan's attempt budget, and above the deferrals a busy workspace
 * or a cooling endpoint can collect (engine.ts) - those re-queue the job
 * through groupmq without being attempts. See `createWebhookQueue`.
 */
export const GROUPMQ_ATTEMPT_CEILING = 1_000

export interface WebhookQueueOptions {
  redis: Redis
  jobTimeoutMs?: number
  /** Only the conformance lab passes this, so it never shares keys with a real queue. */
  namespace?: string
}

export function createWebhookQueue(opts: WebhookQueueOptions): Queue<WebhookJob> {
  return new Queue<WebhookJob>({
    redis: opts.redis,
    namespace: opts.namespace ?? WEBHOOK_NAMESPACE,
    // Longer than any single POST is allowed to take, so a slow endpoint is
    // never handed to a second worker while the first is still waiting on it.
    jobTimeoutMs: opts.jobTimeoutMs ?? 60_000,
    /**
     * ⚠ NOT THE DELIVERY BUDGET, ONLY A CEILING ABOVE IT. The delivery row
     * decides when a delivery is finished (deliver.ts, on its own schedule);
     * groupmq re-queues each retry the handler asks for (engine.ts). This
     * number only has to be higher than any plan's budget so groupmq never
     * dead-letters a delivery the row says is still owed.
     */
    maxAttempts: GROUPMQ_ATTEMPT_CEILING,
    keepCompleted: 1_000,
    keepFailed: 10_000,
  })
}

/**
 * ⚠ ONE JOB ID PER ATTEMPT, WHICH MAKES A DOUBLE ENQUEUE FREE. The ingestion
 * path can be retried by SNS, and the sweep may re-queue a row the queue still
 * holds; both produce the same name for the same attempt, so groupmq collapses
 * them rather than delivering the customer's webhook twice. The attempt is in
 * the name because a retry is a NEW job - reusing the first attempt's id would
 * be refused as a duplicate of a job groupmq still remembers completing.
 */
export const webhookJobId = (deliveryId: string, attempt = 0, tag?: string): string =>
  `wh:${deliveryId}:${attempt}${tag ? `:${tag}` : ""}`

export async function enqueueDelivery(
  queue: Queue<WebhookJob>,
  job: WebhookJob,
  opts: EnqueueDeliveryOptions,
): Promise<void> {
  const attempt = job.attempt ?? 0
  await queue.add({
    groupId: job.endpointId,
    jobId: webhookJobId(job.deliveryId, attempt, opts.jobTag),
    data: { ...job, attempt },
    orderMs: opts.orderMs,
    // ⚠ A DELAYED JOB STILL HOLDS ITS GROUP (measured 2026-10-05: a delayed
    // retry with the earliest orderMs kept the endpoint's later events
    // waiting). That is what keeps a retry in order with the events after it.
    ...(opts.delayMs && opts.delayMs > 0 ? { delay: opts.delayMs } : {}),
  })
}

/**
 * Exponential, capped at eight minutes: the gap before attempt `n + 1`, in
 * milliseconds, given `n` attempts made.
 *
 * ⚠ THE DELIVERY SCHEDULE UNTIL PLANS SET THEIR OWN (#276), AND THE BACKOFF
 * FOR A HANDLER THAT BROKE. A failed POST is not a broken handler: deliver.ts
 * records it and asks for the next attempt at a time it chose, which
 * engine.ts hands to groupmq exactly. This function is what groupmq falls back
 * to when the handler itself threw.
 */
export const webhookBackoff = (attempt: number): number =>
  Math.min(8 * 60_000, 2 ** attempt * 1_000)
