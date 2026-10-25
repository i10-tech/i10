import { Queue, Worker } from "groupmq"
import type { Redis } from "ioredis"
import type { DeletionJob, DeletionOutcome } from "../identity/directory-mail.js"

/**
 * The delayed jobs that delete a suspended mailbox (#344, sso.md 2.8): one per
 * mailbox, due on the date the admin's "delete after N days" set.
 *
 * ⚠ THE JOB IS A REMINDER, NOT THE DECISION. `runDeletion` reads the date and
 * the plan from the database and checks the directories again, so a job made
 * for a plan that was since changed, a person who came back, or a clock that
 * runs fast deletes nothing. A LOST job (Redis wiped) deletes LATE: the
 * console's `runDue` finds the date. It can never delete early.
 *
 * ⚠ ONE GROUP PER MAILBOX, AND A DELAY, FOR THE REASON `invitation-queue.ts`
 * GIVES: a group of one has no next job to be chained into before its time.
 * groupMQ floors a retry to the second, so an early run is put back for the
 * remainder rather than waited out for up to a year.
 */

export const MAILBOX_DELETION_NAMESPACE = "i10:mailbox-deletions"

export const deletionJobId = (tenantId: string, clerkUserId: string, dueAt: number) =>
  `mbx:${tenantId}:${clerkUserId}:${dueAt}`

export function createMailboxDeletionQueue(opts: {
  redis: Redis
  namespace?: string
}): Queue<DeletionJob> {
  return new Queue<DeletionJob>({
    redis: opts.redis,
    namespace: opts.namespace ?? MAILBOX_DELETION_NAMESPACE,
    jobTimeoutMs: 60_000,
    maxAttempts: 10,
    keepCompleted: 100,
    keepFailed: 1_000,
  })
}

/** What the suspension and the admin's pick use to put a deletion on its date. */
export function mailboxDeletionScheduler(
  queue: Pick<Queue<DeletionJob>, "add">,
  now: () => number = Date.now,
) {
  return async (job: DeletionJob, at: Date): Promise<void> => {
    const id = deletionJobId(job.tenantId, job.clerkUserId, job.dueAt)
    await queue.add({
      groupId: id,
      jobId: id,
      data: job,
      orderMs: at.getTime(),
      delay: Math.max(0, at.getTime() - now()),
    })
  }
}

export function startMailboxDeletionWorker(opts: {
  queue: Queue<DeletionJob>
  run: (job: DeletionJob) => Promise<DeletionOutcome>
  name: string
  log: {
    warn: (o: object, m: string) => void
    info: (o: object, m: string) => void
  }
  schedulerIntervalMs?: number
}): Worker<DeletionJob> {
  const worker = new Worker<DeletionJob>({
    queue: opts.queue,
    name: opts.name,
    concurrency: 2,
    schedulerIntervalMs: opts.schedulerIntervalMs ?? 5_000,
    handler: async (job) => {
      const result = await opts.run(job.data)
      if (result.outcome === "early") {
        const at = Date.now() + result.ms
        const id = `${deletionJobId(job.data.tenantId, job.data.clerkUserId, job.data.dueAt)}:${at}`
        await opts.queue.add({
          groupId: id,
          jobId: id,
          data: job.data,
          orderMs: at,
          delay: result.ms,
        })
        opts.log.warn(
          { tenantId: job.data.tenantId, earlyMs: result.ms },
          "a mailbox deletion ran early - put back for its date",
        )
        return
      }
      opts.log.info(
        { tenantId: job.data.tenantId, outcome: result.outcome },
        "mailbox deletion job finished",
      )
    },
    onError: (err, job) =>
      opts.log.warn({ err, jobId: job?.id }, "mailbox deletion job failed"),
  })
  worker.run()
  return worker
}
