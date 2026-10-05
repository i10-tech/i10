import { Worker, type Queue } from "groupmq"
import type { Redis } from "ioredis"
import type { Database } from "../db/client.js"
import {
  createWebhookQueue,
  enqueueDelivery,
  GROUPMQ_ATTEMPT_CEILING,
  webhookBackoff,
  type WebhookJob,
} from "../queue/webhook-queue.js"
import { dueDeliveries, webhookDeliveryOps } from "./db.js"
import { DELIVERY_TIMEOUT_MS, deliverWebhook } from "./deliver.js"
import { vetHost, type Lookup, type VetOptions } from "./egress.js"
import type { Logger } from "./events.js"
import type { SecretBox } from "./signing.js"

/**
 * The webhook delivery engine: the queue, the worker, the sweep and the
 * watchdog, wired together in one place.
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
 *
 * ⚠ POSTGRES OWES, REDIS PROMPTS (#279). Every delivery row carries
 * `next_attempt_at`, written before anything is queued. The queue is how a due
 * attempt normally reaches a worker; the sweep below is how one reaches it when
 * the queue has lost it - Redis restarted empty, an enqueue failed after its
 * commit, a worker died holding it. Nothing a customer is owed exists only in
 * Redis.
 */

export interface WebhookEngineOptions {
  db: Database
  redis: Redis
  secrets: SecretBox
  log: Logger
  /** Distinguishes this worker in groupmq's bookkeeping. */
  name: string
  /** Attempts per delivery, the first included. */
  maxAttempts: number
  /** Distinct endpoints in flight at once. */
  concurrency: number
  /** Private ranges delivery may reach anyway. Empty in production. */
  egressAllow?: VetOptions["allow"]
  /** The lab's resolver; production uses the system's. */
  lookup?: Lookup
  /** Milliseconds before the next attempt, given attempts made. */
  retryDelayMs?: (attemptsMade: number) => number
  /** How long an endpoint has to answer. */
  timeoutMs?: number
  /** groupmq namespace override, so a lab never shares keys with a real queue. */
  namespace?: string
  /** How often the sweep looks for owed deliveries. Default 30s. */
  sweepEveryMs?: number
  /**
   * How long a delivery must have been due before the sweep takes it, rather
   * than leaving it to the queue. Default 60s.
   */
  sweepGraceSeconds?: number
  /**
   * How often groupmq promotes delayed jobs, which is how precisely a retry
   * fires. groupmq's default is 5s; ours is 1s, so a 5s retry is not a 10s one.
   */
  schedulerIntervalMs?: number
}

export interface WebhookEngineHealth {
  /** When a job last reached the handler, if ever. */
  lastHandledAt: Date | null
  /** Owed deliveries the last sweep found the queue had not delivered. */
  lastSweepFound: number
  /** Times the watchdog has recreated the worker because nothing was consumed. */
  restarts: number
}

export interface WebhookEngine {
  queue: Queue<WebhookJob>
  /** One sweep, now. The engine also runs it on its own schedule. */
  sweep: () => Promise<number>
  health: () => WebhookEngineHealth
  /** Stop taking work and let what is in flight finish, up to `gracefulMs`. */
  close: (gracefulMs?: number) => Promise<void>
}

const SWEEP_LIMIT = 500

/**
 * A scheduled retry, thrown so groupmq re-queues the job in its group at `at`.
 * Not a failure of the handler.
 */
class RetryAt extends Error {
  constructor(readonly at: Date) {
    super(`retry at ${at.toISOString()}`)
  }
}

export function startWebhookEngine(opts: WebhookEngineOptions): WebhookEngine {
  const queue = createWebhookQueue({
    redis: opts.redis,
    ...(opts.namespace ? { namespace: opts.namespace } : {}),
  })
  const timeoutMs = opts.timeoutMs ?? DELIVERY_TIMEOUT_MS
  const ops = webhookDeliveryOps({
    db: opts.db,
    secrets: opts.secrets,
    // The attempt itself, resolution included, plus room to record it.
    leaseSeconds: Math.ceil(timeoutMs / 1000) + 30,
  })
  const retryDelayMs = opts.retryDelayMs ?? webhookBackoff
  const sweepEveryMs = opts.sweepEveryMs ?? 30_000
  const sweepGraceSeconds = opts.sweepGraceSeconds ?? 60

  const state: WebhookEngineHealth = {
    lastHandledAt: null,
    lastSweepFound: 0,
    restarts: 0,
  }
  // Handed from `onError` to `backoff`; see the note on `backoff` below.
  let pendingDelayMs: number | null = null

  const makeWorker = () =>
    new Worker<WebhookJob>({
      queue,
      name: opts.name,
      handler: async (job) => {
        state.lastHandledAt = new Date()
        const outcome = await deliverWebhook(job.data, {
          ...ops,
          vet: (host, signal) =>
            vetHost(host, {
              ...(opts.egressAllow ? { allow: opts.egressAllow } : {}),
              ...(opts.lookup ? { lookup: opts.lookup } : {}),
              signal,
            }),
          log: opts.log,
          maxAttempts: opts.maxAttempts,
          retryDelayMs,
          timeoutMs,
        })

        // ⚠ A RETRY IS THROWN, CARRYING ITS DELAY, AND THAT IS NOT AN ERROR
        // PATH. groupmq's own retry (retry.lua) puts the job back in its group
        // as delayed, and a delayed job holds its group - so later events for
        // this endpoint keep waiting behind it, and the order the customer
        // sees survives a retry. Queueing the retry as a NEW job from inside
        // the handler does not work: groupmq chains the next job of a group
        // when one completes and does not check whether that job is delayed,
        // so the "retry" ran at once (measured 2026-10-05: five attempts in
        // 30ms). The row already records `next_attempt_at`; if Redis loses
        // this job, the sweep re-queues it.
        if (outcome.status === "failed" && outcome.retryAt) {
          throw new RetryAt(outcome.retryAt)
        }
      },
      // ⚠ THE DELAY THE HANDLER ASKED FOR, WHEN IT ASKED. groupmq calls
      // `onError(err, job)` and then `backoff(attempt)` back to back, with
      // nothing awaited between them (Worker.handleJobFailure), so the delay
      // `onError` captures from a `RetryAt` is the one this returns. Anything
      // else that reaches here is a handler that broke, which gets ordinary
      // exponential backoff. The lab's ordering scenarios pin this behaviour.
      backoff: (attempt) => {
        const ms = pendingDelayMs
        pendingDelayMs = null
        return ms ?? webhookBackoff(attempt)
      },
      maxAttempts: GROUPMQ_ATTEMPT_CEILING,
      // ⚠ HOW MANY ENDPOINTS ARE IN FLIGHT AT ONCE, NOT HOW MANY EVENTS PER
      // ENDPOINT. groupmq runs one job per group, so this is a count of
      // distinct customer endpoints being POSTed to concurrently.
      concurrency: opts.concurrency,
      schedulerIntervalMs: opts.schedulerIntervalMs ?? 1_000,
      // ⚠ NOT REPORTED TO SENTRY. A customer's endpoint having a bad afternoon
      // is recorded on the delivery row; this only fires when the handler
      // itself broke, which the row's lease and the sweep then recover.
      onError: (err, job) => {
        if (err instanceof RetryAt) {
          pendingDelayMs = Math.max(0, err.at.getTime() - Date.now())
          return
        }
        pendingDelayMs = null
        opts.log.warn({ err, jobId: job?.id }, "webhook delivery job failed")
      },
    })

  let worker = makeWorker()
  worker.run()

  /**
   * Re-queues what the queue has lost.
   *
   * ⚠ SAFE TO RUN ON EVERY REPLICA AT ONCE. The job id names the delivery AND
   * the attempt, so two sweeps - or a sweep and a queue that still had the job
   * - produce one job. And the lease decides who attempts: a row a worker holds
   * is never returned here, and a second job for it finds the lease and stops.
   */
  const sweep = async (): Promise<number> => {
    const due = await dueDeliveries(opts.db, sweepGraceSeconds, SWEEP_LIMIT)
    await Promise.all(
      due.map((d) =>
        enqueueDelivery(
          queue,
          {
            deliveryId: d.id,
            endpointId: d.endpointId,
            tenantId: d.tenantId,
            attempt: d.attempts,
          },
          { orderMs: d.occurredAt.getTime() },
        ),
      ),
    )
    state.lastSweepFound = due.length
    return due.length
  }

  let stallTicks = 0
  let closed = false
  const tick = async () => {
    if (closed) return
    try {
      const found = await sweep()
      if (found > 0) {
        opts.log.warn({ found }, "webhook sweep re-queued owed deliveries")
      }

      /*
       * ⚠ THE WATCHDOG: OWED WORK THAT NOTHING CONSUMES. The Svix lab showed
       * the failure this guards against - a queue whose Redis lost its data
       * stopped consuming for good while its health check said ok, until a
       * restart. Here, two sweeps in a row that find owed work with no job
       * handled since is that state, and the remedy is the restart, done in
       * process: the worker is recreated against the same queue.
       */
      const idle =
        !state.lastHandledAt ||
        Date.now() - state.lastHandledAt.getTime() > 2 * sweepEveryMs
      stallTicks = found > 0 && idle ? stallTicks + 1 : 0
      if (stallTicks >= 2) {
        opts.log.error(
          { found, lastHandledAt: state.lastHandledAt },
          "webhook delivery stalled: owed work and nothing consumed; recreating the worker",
        )
        stallTicks = 0
        state.restarts++
        const old = worker
        worker = makeWorker()
        worker.run()
        void old.close(0).catch(() => {})
      }
    } catch (err) {
      opts.log.warn({ err: String(err) }, "webhook sweep failed; next tick retries")
    }
  }
  const timer = setInterval(() => void tick(), sweepEveryMs)

  return {
    queue,
    sweep,
    health: () => ({ ...state }),
    close: async (gracefulMs = 60_000) => {
      closed = true
      clearInterval(timer)
      await worker.close(gracefulMs)
    },
  }
}
