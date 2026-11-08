import { Queue, Worker } from "groupmq"
import type { Redis } from "ioredis"
import type { ExportDeps, ExportOutcome } from "../identity/siem.js"
import { runSiemExport } from "../identity/siem.js"

/**
 * Scheduling and execution for the SIEM export (#345).
 *
 * ⚠ ONE GROUP PER WORKSPACE (`siem:<tenantId>`), AND NEVER A DELAY, for the
 * reason `google-directory-queue.ts` gives: groupmq runs at most one job per
 * group across every replica, and chains into a group's next job without
 * checking whether it is delayed (and its retry floors time to the second).
 * So no job here is ever delayed, none is added from inside a handler, and
 * the schedule lives in the database (`siem_exports.next_run_at`): the job
 * only says "look at this workspace", and `runSiemExport` claims the row if,
 * and only if, it is due.
 *
 * ⚠ DEDUPLICATED ACROSS REPLICAS BY A PER-MINUTE JOB ID. Every API pod ticks
 * once a minute and computes the same id, so Redis accepts the first add and
 * drops the rest; and a workspace is only returned while it is due, so a
 * claimed one is not offered again.
 */
export const SIEM_NAMESPACE = "i10:siem-export"
export const SIEM_TICK_MS = 60_000

export interface SiemJob {
  tenantId: string
}

export const siemJobId = (tenantId: string, nowMs: number) =>
  `siem:${tenantId}:${Math.floor(nowMs / SIEM_TICK_MS)}`

export function createSiemQueue(opts: {
  redis: Redis
  namespace?: string
}): Queue<SiemJob> {
  return new Queue<SiemJob>({
    redis: opts.redis,
    namespace: opts.namespace ?? SIEM_NAMESPACE,
    jobTimeoutMs: 300_000,
    maxAttempts: 1,
    keepCompleted: 100,
    keepFailed: 500,
  })
}

export type EnqueueSiem = (tenantId: string, nowMs?: number) => Promise<void>

export function siemScheduler(
  queue: Pick<Queue<SiemJob>, "add">,
  now: () => number = Date.now,
): EnqueueSiem {
  return async (tenantId, nowMs = now()) => {
    await queue.add({
      groupId: `siem:${tenantId}`,
      jobId: siemJobId(tenantId, nowMs),
      data: { tenantId },
    })
  }
}

/** Pages every workspace whose export is due and enqueues it. */
export async function enqueueDueSiem(deps: {
  due(after: string | null, limit: number): Promise<string[]>
  enqueue: EnqueueSiem
  log: { error: (o: object, m: string) => void }
  now?: () => number
}): Promise<number> {
  const nowMs = (deps.now ?? Date.now)()
  let after: string | null = null
  let total = 0
  for (;;) {
    const page = await deps.due(after, 200)
    if (page.length === 0) return total
    const results = await Promise.allSettled(page.map((t) => deps.enqueue(t, nowMs)))
    const failed = results.filter((r) => r.status === "rejected").length
    if (failed > 0) deps.log.error({ failed }, "could not schedule due SIEM exports")
    total += page.length - failed
    if (page.length < 200) return total
    after = page[page.length - 1]!
  }
}

export function startSiemScheduler(deps: {
  due(after: string | null, limit: number): Promise<string[]>
  enqueue: EnqueueSiem
  log: { error: (o: object, m: string) => void }
  intervalMs?: number
}): { stop(): void; tick(): Promise<number> } {
  let running = false
  let stopped = false
  const tick = async (): Promise<number> => {
    if (stopped || running) return 0
    running = true
    try {
      return await enqueueDueSiem(deps)
    } catch (error) {
      deps.log.error({ err: String(error) }, "SIEM scheduler tick failed")
      return 0
    } finally {
      running = false
    }
  }
  const timer = setInterval(() => void tick(), deps.intervalMs ?? SIEM_TICK_MS)
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

export function startSiemWorker(opts: {
  queue: Queue<SiemJob>
  deps: ExportDeps
  name: string
  schedulerIntervalMs?: number
  onOutcome?: (tenantId: string, outcome: ExportOutcome) => void
}): Worker<SiemJob> {
  const worker = new Worker<SiemJob>({
    queue: opts.queue,
    name: opts.name,
    concurrency: 4,
    schedulerIntervalMs: opts.schedulerIntervalMs ?? 1_000,
    handler: async (job) => {
      const outcome = await runSiemExport(opts.deps, job.data.tenantId)
      opts.onOutcome?.(job.data.tenantId, outcome)
    },
    onError: (err, job) =>
      opts.deps.log.warn(
        { err: String(err), jobId: job?.id },
        "SIEM export job failed",
      ),
  })
  worker.run()
  return worker
}
