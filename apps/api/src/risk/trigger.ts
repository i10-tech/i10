import { markDirty, scoreTenant, type RiskDeps } from "./runner.js"

/**
 * Re-scoring a workspace NOW, from inside the API (#170): on an SES pause or
 * HIGH finding, a farm tripwire, an identity anomaly.
 *
 * ⚠ BOUNDED, DEDUPLICATED, AND ALLOWED TO DROP. A farm tripping on every
 * request, or an SES event storm, must not turn the API into a scoring
 * cluster: at most `concurrency` scores run at once, a workspace already
 * waiting is not queued twice, and past `maxQueued` new requests are dropped.
 * Every request is ALSO marked dirty first, so a dropped one is scored by the
 * next hourly run - late, never lost. That is the whole backpressure story.
 */
export interface RiskTrigger {
  rescore(tenantIds: string[], trigger: string): void
  /** Resolves when the queue is empty. For tests and graceful shutdown. */
  idle(): Promise<void>
}

export function riskTrigger(
  deps: RiskDeps,
  {
    concurrency = 2,
    maxQueued = 500,
  }: { concurrency?: number; maxQueued?: number } = {},
): RiskTrigger {
  const queued = new Map<string, string>()
  let running = 0
  let waiters: (() => void)[] = []

  const pump = () => {
    while (running < concurrency && queued.size > 0) {
      const [tenantId, trigger] = queued.entries().next().value as [string, string]
      queued.delete(tenantId)
      running++
      void scoreTenant(tenantId, trigger, deps)
        .catch((error: unknown) =>
          deps.log?.error?.(
            { err: error, tenantId, trigger },
            "event-driven re-score failed",
          ),
        )
        .finally(() => {
          running--
          pump()
          if (running === 0 && queued.size === 0) {
            const w = waiters
            waiters = []
            w.forEach((f) => f())
          }
        })
    }
  }

  return {
    rescore(tenantIds, trigger) {
      if (!deps.switches.enabled || tenantIds.length === 0) return
      void markDirty(deps.redis, tenantIds)
      for (const id of tenantIds) {
        if (queued.has(id)) continue
        if (queued.size >= maxQueued) {
          deps.log?.warn?.(
            { dropped: tenantIds.length, trigger },
            "risk re-score queue full; left to the hourly run",
          )
          break
        }
        queued.set(id, trigger)
      }
      pump()
    },
    idle() {
      if (running === 0 && queued.size === 0) return Promise.resolve()
      return new Promise((resolve) => waiters.push(resolve))
    },
  }
}
