import { Queue, Worker } from "groupmq"
import type { Redis } from "ioredis"
import type { SweepJob } from "../identity/managed.js"

/**
 * The SSO sweeper's delayed jobs (#337, sso.md 2.2): one per managed
 * account's ticket session, due two minutes after Clerk made it. If the
 * session has no bind row by then, it is revoked.
 *
 * ⚠ ONE GROUP PER SESSION, FOR THE REASON `invitation-queue.ts` GIVES.
 * groupmq chains straight into a group's next job without checking whether it
 * is still delayed; a group of one has no next job to pull forward. And the
 * job is added by the API's webhook handler, never from inside a handler,
 * except the rare early re-schedule below, which gets a fresh group.
 *
 * ⚠ AND groupmq's retry FLOORS TIME TO THE SECOND (retry.lua), so a job can run
 * up to a second early; `sweepSession` answers `early` rather than revoking,
 * and this worker waits the remainder out.
 */

export const IDENTITY_SWEEP_NAMESPACE = "i10:identity-sweeps"

export const sweepJobId = (sessionId: string) => `sweep:${sessionId}`

export function createIdentitySweepQueue(opts: {
  redis: Redis
  namespace?: string
}): Queue<SweepJob> {
  return new Queue<SweepJob>({
    redis: opts.redis,
    namespace: opts.namespace ?? IDENTITY_SWEEP_NAMESPACE,
    jobTimeoutMs: 60_000,
    maxAttempts: 10,
    keepCompleted: 100,
    keepFailed: 1_000,
  })
}

/** What the webhook handler uses to put a session on the sweeper's list. */
export function sweepScheduler(queue: Queue<SweepJob>, now: () => number = Date.now) {
  return async (job: SweepJob): Promise<void> => {
    await queue.add({
      groupId: sweepJobId(job.sessionId),
      jobId: sweepJobId(job.sessionId),
      data: job,
      orderMs: job.dueAt,
      delay: Math.max(0, job.dueAt - now()),
    })
  }
}

/** Longest an early job waits in place before it re-schedules instead. */
export const EARLY_WAIT_MS = 30_000

export function startIdentitySweepWorker(opts: {
  queue: Queue<SweepJob>
  sweep: (
    job: SweepJob,
  ) => Promise<{ outcome: "bound" | "revoked" | "not_managed" | "early"; ms?: number }>
  name: string
  log: { warn: (o: object, m: string) => void; info: (o: object, m: string) => void }
  schedulerIntervalMs?: number
  sleep?: (ms: number) => Promise<void>
}): Worker<SweepJob> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const worker = new Worker<SweepJob>({
    queue: opts.queue,
    name: opts.name,
    concurrency: 4,
    schedulerIntervalMs: opts.schedulerIntervalMs ?? 1_000,
    handler: async (job) => {
      let result = await opts.sweep(job.data)
      if (result.outcome === "early" && (result.ms ?? 0) <= EARLY_WAIT_MS) {
        await sleep((result.ms ?? 0) + 5)
        result = await opts.sweep(job.data)
      }
      if (result.outcome === "early") {
        const at = Date.now() + (result.ms ?? 0)
        await opts.queue.add({
          groupId: `${sweepJobId(job.data.sessionId)}:${at}`,
          jobId: `${sweepJobId(job.data.sessionId)}:${at}`,
          data: job.data,
          orderMs: at,
          delay: result.ms ?? 0,
        })
        opts.log.warn(
          { sessionId: job.data.sessionId, earlyMs: result.ms },
          "an SSO sweep job ran early - put back for its time",
        )
      }
    },
    onError: (err, job) =>
      opts.log.warn({ err, jobId: job?.id }, "SSO sweep job failed"),
  })
  worker.run()
  return worker
}
