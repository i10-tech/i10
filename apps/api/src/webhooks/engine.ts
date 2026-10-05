import { Worker, type Queue } from "groupmq"
import type { Redis } from "ioredis"
import type { Database } from "../db/client.js"
import {
  createWebhookQueue,
  webhookBackoff,
  type WebhookJob,
} from "../queue/webhook-queue.js"
import { webhookDeliveryOps } from "./db.js"
import { deliverWebhook } from "./deliver.js"
import { vetHost, type Lookup, type VetOptions } from "./egress.js"
import type { Logger } from "./events.js"
import type { SecretBox } from "./signing.js"

/**
 * The webhook delivery engine: the queue, the worker and the delivery code,
 * wired together in one place.
 *
 * ⚠ ONE FUNCTION FOR PRODUCTION AND FOR THE CONFORMANCE LAB, SO THE LAB TESTS
 * WHAT SHIPS. `worker.ts` calls this with the environment; the lab
 * (test/webhook-lab) calls it with a local receiver and shortened timings. A
 * lab that assembled its own worker would prove things about a configuration
 * nobody runs.
 *
 * ⚠ AND IT IS THE SEAM THE DURABLE OBJECTS VERSION WILL IMPLEMENT
 * (docs/decisions/webhooks.md, decision 2). Callers see `queue` to enqueue
 * into and `close` to stop; nothing outside depends on groupmq's Worker.
 */

export interface WebhookEngineOptions {
  db: Database
  redis: Redis
  secrets: SecretBox
  log: Logger
  /** Distinguishes this worker in groupmq's bookkeeping. */
  name: string
  maxAttempts: number
  /** Distinct endpoints in flight at once. */
  concurrency: number
  /** Private ranges delivery may reach anyway. Empty in production. */
  egressAllow?: VetOptions["allow"]
  /** The lab's resolver; production uses the system's. */
  lookup?: Lookup
  /** Milliseconds before retry `attempt`. Production uses `webhookBackoff`. */
  backoff?: (attempt: number) => number
  /** How long an endpoint has to answer. Production uses the default in deliver.ts. */
  timeoutMs?: number
  /** groupmq namespace override, so a lab never shares keys with a real queue. */
  namespace?: string
}

export interface WebhookEngine {
  queue: Queue<WebhookJob>
  /** Stop taking work and let what is in flight finish, up to `gracefulMs`. */
  close: (gracefulMs?: number) => Promise<void>
}

export function startWebhookEngine(opts: WebhookEngineOptions): WebhookEngine {
  const queue = createWebhookQueue({
    redis: opts.redis,
    maxAttempts: opts.maxAttempts,
    ...(opts.namespace ? { namespace: opts.namespace } : {}),
  })
  const ops = webhookDeliveryOps({ db: opts.db, secrets: opts.secrets })

  const worker = new Worker<WebhookJob>({
    queue,
    name: opts.name,
    handler: (job) =>
      deliverWebhook(job.data, {
        ...ops,
        vet: (host, signal) =>
          vetHost(host, {
            ...(opts.egressAllow ? { allow: opts.egressAllow } : {}),
            ...(opts.lookup ? { lookup: opts.lookup } : {}),
            signal,
          }),
        log: opts.log,
        maxAttempts: opts.maxAttempts,
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      }),
    maxAttempts: opts.maxAttempts,
    // ⚠ HOW MANY ENDPOINTS ARE IN FLIGHT AT ONCE, NOT HOW MANY EVENTS PER
    // ENDPOINT. groupmq runs one job per group, so this is a count of distinct
    // customer endpoints being POSTed to concurrently - every one of them a
    // ten-second wait on somebody else's server, which is why it is worth
    // being higher than the send worker's.
    concurrency: opts.concurrency,
    // ⚠ ON THE WORKER, NOT THE QUEUE - groupmq ignores it on the latter. See
    // queue/webhook-queue.ts.
    backoff: opts.backoff ?? webhookBackoff,
    // Deliberately quiet: a customer's endpoint being down is their operational
    // problem, recorded on the delivery row, and logging it as an error here
    // would drown the log in other people's outages.
    //
    // ⚠ AND NOT REPORTED TO SENTRY EITHER, FOR THE SAME REASON RATHER THAN BY
    // OVERSIGHT. Every customer whose endpoint has a bad afternoon would raise
    // an issue against us, spend the quota, and bury the failures that are
    // actually ours. The delivery row is where this belongs.
    onError: (err, job) =>
      opts.log.warn({ err, jobId: job?.id }, "webhook delivery job failed"),
  })

  worker.run()
  return {
    queue,
    close: (gracefulMs = 60_000) => worker.close(gracefulMs),
  }
}
