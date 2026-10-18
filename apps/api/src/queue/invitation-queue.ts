import { Queue, Worker } from "groupmq"
import type { Redis } from "ioredis"
import type { ExpiryScheduler } from "../console/members.js"

/**
 * One delayed job per invitation, due at the second it expires (#327).
 *
 * ⚠ ONE GROUP PER INVITATION. groupmq runs a group's jobs in order and, when
 * one completes, chains straight into the group's next job WITHOUT checking
 * whether that job is still delayed (complete-and-reserve-next-with-metadata
 * .lua) - the bug that made webhook retries fire at once. Shared groups would
 * let one invitation's completion pull the next one forward; a group of one
 * has no next job to pull.
 *
 * ⚠ AND THE JOB IS ADDED FROM THE API, NEVER FROM INSIDE A HANDLER. The rare
 * re-schedule a handler does make (a job that arrived early, see
 * `startInvitationWorker`) goes into a fresh group for the same reason.
 */

export interface InvitationJob {
  id: string
  tenantId: string
}

export const INVITATION_NAMESPACE = "i10:invitations"

export const invitationJobId = (id: string) => `inv:${id}`

export function createInvitationQueue(opts: {
  redis: Redis
  namespace?: string
}): Queue<InvitationJob> {
  return new Queue<InvitationJob>({
    redis: opts.redis,
    namespace: opts.namespace ?? INVITATION_NAMESPACE,
    jobTimeoutMs: 60_000,
    maxAttempts: 10,
    keepCompleted: 100,
    keepFailed: 1_000,
  })
}

export function invitationScheduler(
  queue: Queue<InvitationJob>,
  now: () => number = Date.now,
): ExpiryScheduler {
  return {
    async schedule(job, at) {
      await queue.add({
        groupId: invitationJobId(job.id),
        jobId: invitationJobId(job.id),
        data: job,
        orderMs: at.getTime(),
        delay: Math.max(0, at.getTime() - now()),
      })
    },
    async cancel(id) {
      await queue.remove(invitationJobId(id))
    },
  }
}

/** Longest an early job waits in place before it re-schedules instead. */
export const EARLY_WAIT_MS = 30_000

export interface ExpireOutcome {
  outcome: "expired" | "done" | "early"
  ms?: number
}

/**
 * Runs the expiry jobs.
 *
 * ⚠ AN EARLY JOB NEVER REVOKES. `expire` re-reads the row and answers how
 * long is left; up to `EARLY_WAIT_MS` the handler waits that out and asks
 * again, and beyond it the job is put back for the exact instant in a new
 * group. A promotion tick, or a clock a little ahead, costs a wait - never an
 * invitation cut short.
 */
export function startInvitationWorker(opts: {
  queue: Queue<InvitationJob>
  expire: (job: InvitationJob) => Promise<ExpireOutcome>
  name: string
  log: { warn: (o: object, m: string) => void; info: (o: object, m: string) => void }
  /** How often delayed jobs are promoted. groupmq's default is 5s; ours 1s. */
  schedulerIntervalMs?: number
  sleep?: (ms: number) => Promise<void>
}): Worker<InvitationJob> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const worker = new Worker<InvitationJob>({
    queue: opts.queue,
    name: opts.name,
    concurrency: 4,
    schedulerIntervalMs: opts.schedulerIntervalMs ?? 1_000,
    handler: async (job) => {
      let result = await opts.expire(job.data)
      if (result.outcome === "early" && (result.ms ?? 0) <= EARLY_WAIT_MS) {
        await sleep((result.ms ?? 0) + 5)
        result = await opts.expire(job.data)
      }
      if (result.outcome === "early") {
        const at = Date.now() + (result.ms ?? 0)
        await opts.queue.add({
          groupId: `${invitationJobId(job.data.id)}:${at}`,
          jobId: `${invitationJobId(job.data.id)}:${at}`,
          data: job.data,
          orderMs: at,
          delay: result.ms ?? 0,
        })
        opts.log.warn(
          { invitation: job.data.id, earlyMs: result.ms },
          "an invitation's expiry job ran early - put back for its time",
        )
        return
      }
      if (result.outcome === "expired")
        opts.log.info(
          { invitation: job.data.id },
          "revoked an invitation at its expiry",
        )
    },
    onError: (err, job) =>
      opts.log.warn({ err, jobId: job?.id }, "invitation expiry job failed"),
  })
  worker.run()
  return worker
}
