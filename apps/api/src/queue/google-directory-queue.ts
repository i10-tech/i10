import { Queue, Worker } from "groupmq"
import type { Redis } from "ioredis"
import { safeError } from "../identity/directory.js"
import type { DirectoryStore } from "../identity/directory-ports.js"
import {
  ensureGoogleWatchChannels,
  pullGoogleDirectory,
  type GoogleTokenSource,
  type PullBounds,
  type PullGoogleOutcome,
} from "../identity/google-directory.js"
import type { OidcFetch } from "../identity/oidc-fetch.js"
import type { AuditEvent, Logger } from "../identity/ports.js"
import type { OutboxEntry } from "../identity/directory-ports.js"

/**
 * Scheduling and execution for Google Workspace directory pulls (#343).
 *
 * ⚠ ONE GROUP PER DIRECTORY (`google-dir:<directoryId>`), AND NEVER A DELAY.
 * groupmq runs at most one job per group across every API replica, which gives
 * "one pull per directory at a time" across the cluster without advisory locks
 * held across network I/O. As in `directory-queue.ts`, every job added here is
 * due immediately because groupmq chains into a group's next job without
 * checking whether it is delayed.
 *
 * ⚠ DEDUPLICATED ACROSS REPLICAS BY BUCKETED JOB ID. Every API pod ticks its
 * scheduler once a minute, and every pod computes the same 15-minute bucket
 * id (`google-pull:<id>:sched:<bucket>`), so Redis accepts the first pod's add
 * and drops the rest.
 */

export const GOOGLE_DIRECTORY_NAMESPACE = "i10:google-directory-pull"
export const GOOGLE_PULL_INTERVAL_MS = 15 * 60_000
export const GOOGLE_SCHEDULER_TICK_MS = 60_000

export type GooglePullCause = "scheduled" | "enable" | "notify"

export interface GooglePullJob {
  tenantId: string
  directoryId: string
  cause: GooglePullCause
}

export function googlePullJobId(
  directoryId: string,
  cause: GooglePullCause,
  nowMs: number,
): string {
  switch (cause) {
    case "scheduled":
      return `google-pull:${directoryId}:sched:${Math.floor(nowMs / GOOGLE_PULL_INTERVAL_MS)}`
    case "enable":
      return `google-pull:${directoryId}:enable:${Math.floor(nowMs / 1_000)}`
    case "notify":
      return `google-pull:${directoryId}:notify:${Math.floor(nowMs / 5_000)}`
  }
}

export function createGoogleDirectoryQueue(opts: {
  redis: Redis
  namespace?: string
}): Queue<GooglePullJob> {
  return new Queue<GooglePullJob>({
    redis: opts.redis,
    namespace: opts.namespace ?? GOOGLE_DIRECTORY_NAMESPACE,
    jobTimeoutMs: 180_000,
    maxAttempts: 4,
    keepCompleted: 200,
    keepFailed: 500,
  })
}

export type EnqueueGooglePull = (job: GooglePullJob, nowMs?: number) => Promise<void>

export function googlePullScheduler(
  queue: Pick<Queue<GooglePullJob>, "add">,
  now: () => number = Date.now,
): EnqueueGooglePull {
  return async (job, nowMs = now()) => {
    await queue.add({
      groupId: `google-dir:${job.directoryId}`,
      jobId: googlePullJobId(job.directoryId, job.cause, nowMs),
      data: job,
    })
  }
}

/** Retries start at five seconds and cap at five minutes. */
export const googlePullBackoff = (attempt: number) =>
  Math.min(300_000, 5_000 * 2 ** Math.max(0, attempt - 1))

export interface GoogleSyncWorkerDeps {
  store: DirectoryStore
  tokens: GoogleTokenSource | null
  fetch: OidcFetch
  notifyUrl: string | null
  schedule(tenantId: string, entries: readonly OutboxEntry[]): Promise<void>
  record(tenantId: string, event: AuditEvent): Promise<void>
  log: Pick<Logger, "info" | "warn" | "error">
  bounds?: PullBounds
  now?: () => Date
}

export async function runGoogleDirectoryJob(
  deps: GoogleSyncWorkerDeps,
  job: GooglePullJob,
): Promise<PullGoogleOutcome> {
  const outcome = await pullGoogleDirectory(deps, {
    tenantId: job.tenantId,
    directoryId: job.directoryId,
  })
  if (outcome.outcome === "ok") {
    const dir = await deps.store.directory(job.tenantId, job.directoryId)
    if (dir?.enabled) await ensureGoogleWatchChannels(deps, dir)
    return outcome
  }
  if (outcome.outcome === "failed" && outcome.retryable) {
    throw new Error(`google directory pull retryable: ${outcome.error}`)
  }
  return outcome
}

export function startGoogleDirectoryWorker(opts: {
  queue: Queue<GooglePullJob>
  deps: GoogleSyncWorkerDeps
  name: string
  schedulerIntervalMs?: number
}): Worker<GooglePullJob> {
  const worker = new Worker<GooglePullJob>({
    queue: opts.queue,
    name: opts.name,
    concurrency: 4,
    schedulerIntervalMs: opts.schedulerIntervalMs ?? 1_000,
    backoff: googlePullBackoff,
    handler: async (job) => {
      await runGoogleDirectoryJob(opts.deps, job.data)
    },
    onError: (err, job) =>
      opts.deps.log.warn(
        {
          ...safeError(err),
          jobId: job?.id,
          directoryId: job?.data.directoryId,
        },
        "google directory pull job failed",
      ),
  })
  worker.run()
  return worker
}

/** Keyset-pages every enabled Google directory and enqueues its 15-minute pull. */
export async function enqueueDueGoogleDirectories(deps: {
  store: Pick<DirectoryStore, "dueGoogleDirectories">
  enqueue: EnqueueGooglePull
  log: Pick<Logger, "error">
  now?: () => number
}): Promise<number> {
  const nowMs = (deps.now ?? Date.now)()
  let after: string | null = null
  let total = 0
  for (;;) {
    const page = await deps.store.dueGoogleDirectories(after, 200)
    if (page.length === 0) return total
    const results = await Promise.allSettled(
      page.map((row) =>
        deps.enqueue(
          { tenantId: row.tenantId, directoryId: row.id, cause: "scheduled" },
          nowMs,
        ),
      ),
    )
    const failed = results.filter((r) => r.status === "rejected").length
    if (failed > 0)
      deps.log.error({ failed }, "could not schedule due Google directory pulls")
    total += page.length - failed
    if (page.length < 200) return total
    after = page[page.length - 1]!.id
  }
}

export function startGoogleDirectoryScheduler(deps: {
  store: Pick<DirectoryStore, "dueGoogleDirectories">
  enqueue: EnqueueGooglePull
  log: Pick<Logger, "error">
  intervalMs?: number
  now?: () => number
}): { stop(): void; tick(): Promise<number> } {
  let running = false
  let stopped = false

  const tick = async (): Promise<number> => {
    if (stopped || running) return 0
    running = true
    try {
      return await enqueueDueGoogleDirectories(deps)
    } catch (error) {
      deps.log.error({ ...safeError(error) }, "google directory scheduler tick failed")
      return 0
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => {
    void tick()
  }, deps.intervalMs ?? GOOGLE_SCHEDULER_TICK_MS)
  timer.unref()
  void tick()

  return {
    stop() {
      stopped = true
      clearInterval(timer)
    },
    tick,
  }
}
