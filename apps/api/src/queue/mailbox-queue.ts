import { Queue, Worker } from "groupmq"
import type { Redis } from "ioredis"

/**
 * Background queue for mailbox export and import jobs (#385).
 *
 * ⚠ ONE GROUP PER MAILBOX ADDRESS. groupmq runs the jobs of a group one at a
 * time, so a mailbox never has an import and an export (or two imports) going
 * at once, and a burst of imports across mailboxes is bounded by the worker's
 * concurrency, not by how many were queued. That is the throttle E2's search
 * indexing limits call for.
 *
 * ⚠ `maxAttempts: 1`. A failed job is failed for a reason a retry does not fix
 * (over quota, a bad archive), and an import that ran halfway must not start
 * over on its own.
 */

export interface MailboxJobData {
  jobId: string
  tenantId: string
  mailboxAddress: string
  type: "export" | "import"
}

export const MAILBOX_QUEUE_NAMESPACE = "i10:mailbox-jobs"

export const mailboxJobId = (id: string) => `mbx:${id}`

export function createMailboxQueue(opts: {
  redis: Redis
  namespace?: string
}): Queue<MailboxJobData> {
  return new Queue<MailboxJobData>({
    redis: opts.redis,
    namespace: opts.namespace ?? MAILBOX_QUEUE_NAMESPACE,
    // A stall window, not a deadline: the worker heartbeats while a job runs.
    jobTimeoutMs: 600_000,
    maxAttempts: 1,
    keepCompleted: 100,
    keepFailed: 500,
  })
}

/** The only way a job is queued, so the group is always the mailbox. */
export function enqueueMailboxJob(
  queue: Pick<Queue<MailboxJobData>, "add">,
  data: MailboxJobData,
) {
  return queue.add({
    groupId: data.mailboxAddress.toLowerCase(),
    jobId: mailboxJobId(data.jobId),
    data,
  })
}

export function startMailboxWorker(opts: {
  queue: Queue<MailboxJobData>
  handler: (job: MailboxJobData) => Promise<void>
  name: string
  log: {
    warn: (o: object, m: string) => void
    info: (o: object, m: string) => void
    error: (o: object, m: string) => void
  }
  concurrency?: number
}): Worker<MailboxJobData> {
  return new Worker<MailboxJobData>({
    queue: opts.queue,
    name: opts.name,
    concurrency: opts.concurrency ?? 2,
    schedulerIntervalMs: 1_000,
    handler: async (job) => {
      const fields = {
        jobId: job.data.jobId,
        mailbox: job.data.mailboxAddress,
        type: job.data.type,
      }
      opts.log.info(fields, "mailbox job starting")
      await opts.handler(job.data)
      opts.log.info(fields, "mailbox job finished")
    },
  })
}
