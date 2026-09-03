import { Queue } from "groupmq"
import type { Redis } from "ioredis"

/**
 * The webhook delivery queue.
 *
 * ⚠ THE GROUP IS THE ENDPOINT, NOT THE TENANT, AND THAT CHOICE BUYS TWO THINGS
 * AT ONCE. groupmq runs one job per group at a time, in order — so grouping by
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
 * the feature, and a batch would have to be delivered in order anyway — so the
 * batch would buy nothing and would make a single failing event retry the ones
 * beside it.
 */

export interface WebhookJob {
  deliveryId: string
  endpointId: string
  tenantId: string
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
}

export const WEBHOOK_NAMESPACE = "i10:webhooks"

export interface WebhookQueueOptions {
  redis: Redis
  jobTimeoutMs?: number
  maxAttempts?: number
}

export function createWebhookQueue(opts: WebhookQueueOptions): Queue<WebhookJob> {
  return new Queue<WebhookJob>({
    redis: opts.redis,
    namespace: WEBHOOK_NAMESPACE,
    // Longer than any single POST is allowed to take, so a slow endpoint is
    // never handed to a second worker while the first is still waiting on it.
    jobTimeoutMs: opts.jobTimeoutMs ?? 60_000,
    /**
     * ⚠ THE RETRY BUDGET IS A PRODUCT DECISION, NOT A TUNING KNOB. A receiver
     * that is down for a deploy should not lose events; one that has been gone
     * for a day is not coming back within this job's life. Five attempts on
     * `webhookBackoff` spans roughly a quarter of an hour, which covers a
     * deploy, a restart and a brief outage — and `consecutive_failures` on the
     * endpoint is what handles the longer kind by switching it off.
     */
    maxAttempts: opts.maxAttempts ?? 5,
    keepCompleted: 1_000,
    keepFailed: 10_000,
  })
}

/**
 * ⚠ THE DELIVERY ROW'S ID IS THE JOB ID, WHICH MAKES A DOUBLE ENQUEUE FREE.
 * The ingestion path can be retried by SNS, and a sweep may re-enqueue rows
 * that are still `pending`; both produce the same name, so groupmq collapses
 * them rather than delivering the customer's webhook twice.
 */
export const webhookJobId = (deliveryId: string): string => `wh:${deliveryId}`

export async function enqueueDelivery(
  queue: Queue<WebhookJob>,
  job: WebhookJob,
  opts: EnqueueDeliveryOptions,
): Promise<void> {
  await queue.add({
    groupId: job.endpointId,
    jobId: webhookJobId(job.deliveryId),
    data: job,
    orderMs: opts.orderMs,
  })
}

/**
 * Exponential, capped at eight minutes.
 *
 * ⚠ IT LIVES ON THE WORKER RATHER THAN THE QUEUE, WHICH IS EASY TO GET WRONG:
 * groupmq takes `maxAttempts` on both and `backoff` on the Worker only. Passed
 * to the Queue it is silently ignored — TypeScript catches it today, and the
 * failure if it ever stopped catching it is retries hammering a dead endpoint
 * every half second.
 */
export const webhookBackoff = (attempt: number): number =>
  Math.min(8 * 60_000, 2 ** attempt * 1_000)
