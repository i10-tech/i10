import { Queue, Worker } from "groupmq"
import type { Redis } from "ioredis"
import {
  safeError,
  type ApplyJob,
  type ApplyOutcome,
  type Enqueue,
} from "../identity/directory.js"

/**
 * The apply jobs of SCIM directories (#342, sso.md 2.7): one per outbox entry,
 * telling the job to look at one person again and bring Clerk, the membership
 * and the managed-account rules to what their directory row says.
 *
 * ⚠ ONE GROUP PER PERSON. Two changes to one person are applied one after the
 * other (the second reads the row as the first left it), and different people
 * run side by side. And never a delay: groupmq chains into a group's next job
 * without checking whether it is still delayed (see `invitation-queue.ts`), so
 * every job here is due the moment it is added.
 *
 * ⚠ THE JOB ID IS THE ENTRY'S, PLUS A MINUTE BUCKET FOR A RE-KICK. groupmq
 * dedupes by job id and keeps failed jobs, so the same id again would be
 * dropped as a duplicate of the job that gave up.
 *
 * ⚠ A FAILURE THROWS. The handler lets Clerk's errors out so groupmq retries
 * with backoff; `applyDirectoryUser` has already counted the failure on the
 * outbox rows. Entries that outlive every retry are found by the next kick.
 */

export const DIRECTORY_NAMESPACE = "i10:directory-apply"

export const directoryJobId = (
  directoryUserId: string,
  entryId: string,
  bucket: number | null,
) =>
  bucket === null
    ? `dir:${directoryUserId}:${entryId}`
    : `dir:${directoryUserId}:${entryId}:${bucket}`

export function createDirectoryQueue(opts: {
  redis: Redis
  namespace?: string
}): Queue<ApplyJob> {
  return new Queue<ApplyJob>({
    redis: opts.redis,
    namespace: opts.namespace ?? DIRECTORY_NAMESPACE,
    jobTimeoutMs: 120_000,
    maxAttempts: 8,
    keepCompleted: 100,
    keepFailed: 1_000,
  })
}

/** What the SCIM routes and the kick use to put an entry on the queue. */
export function directoryScheduler(queue: Pick<Queue<ApplyJob>, "add">): Enqueue {
  return async (job, bucket) => {
    await queue.add({
      groupId: `dir:${job.directoryUserId}`,
      jobId: directoryJobId(job.directoryUserId, job.entryId, bucket),
      data: { tenantId: job.tenantId, directoryUserId: job.directoryUserId },
    })
  }
}

/** Retries start at two seconds and stop doubling at five minutes. */
export const directoryBackoff = (attempt: number) =>
  Math.min(300_000, 2_000 * 2 ** Math.max(0, attempt - 1))

export function startDirectoryWorker(opts: {
  queue: Queue<ApplyJob>
  apply: (job: ApplyJob) => Promise<ApplyOutcome>
  name: string
  log: {
    warn: (o: object, m: string) => void
    info: (o: object, m: string) => void
  }
  schedulerIntervalMs?: number
}): Worker<ApplyJob> {
  const worker = new Worker<ApplyJob>({
    queue: opts.queue,
    name: opts.name,
    concurrency: 4,
    schedulerIntervalMs: opts.schedulerIntervalMs ?? 1_000,
    backoff: directoryBackoff,
    handler: async (job) => {
      await opts.apply(job.data)
    },
    onError: (err, job) =>
      opts.log.warn(
        {
          ...safeError(err),
          jobId: job?.id,
          directoryUserId: job?.data.directoryUserId,
        },
        "directory apply job failed",
      ),
  })
  worker.run()
  return worker
}
