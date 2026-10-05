import type { Redis } from "ioredis"

/**
 * Keeping one workspace, or one endpoint, from taking delivery away from the
 * rest (#278).
 *
 * ⚠ ONE DEAD ENDPOINT WAS NEVER THE PROBLEM; MANY WERE. groupmq runs one job
 * per group at a time and the group is the endpoint, so a single hanging
 * endpoint holds at most one slot, and the timeout penalty spaces even that
 * out. What starved everyone in the Svix lab (116.8s for a quiet workspace's
 * one event) was one workspace with many failing endpoints filling every slot.
 * So the main control here is a share per WORKSPACE, and the breaker and the
 * throttle are per endpoint.
 */

/**
 * In-flight deliveries per workspace, on this worker. A workspace at its share
 * has its next job deferred - not attempted, not counted against its retry
 * budget - so the slot goes to someone else.
 *
 * ⚠ PER REPLICA, DELIBERATELY. Each worker keeps its own slots fair; a shared
 * counter would put a Redis round trip in front of every delivery to answer a
 * question each replica can answer for itself.
 */
export class WorkspaceShare {
  private readonly inFlight = new Map<string, number>()

  constructor(readonly share: number) {}

  tryAcquire(tenantId: string): boolean {
    const n = this.inFlight.get(tenantId) ?? 0
    if (n >= this.share) return false
    this.inFlight.set(tenantId, n + 1)
    return true
  }

  release(tenantId: string): void {
    const n = (this.inFlight.get(tenantId) ?? 1) - 1
    if (n <= 0) this.inFlight.delete(tenantId)
    else this.inFlight.set(tenantId, n)
  }

  /** For tests and health. */
  current(tenantId: string): number {
    return this.inFlight.get(tenantId) ?? 0
  }
}

/** A workspace's share of `concurrency` slots: a quarter, and at least two. */
export const shareOf = (concurrency: number): number =>
  Math.max(2, Math.ceil(concurrency / 4))

export interface BreakerOptions {
  /** Timeouts in a row before the breaker opens. */
  threshold: number
  /** How long it stays open the first time; doubles each time after. */
  coolMs: number
  /** The longest it stays open. */
  maxCoolMs: number
}

export const BREAKER: BreakerOptions = {
  threshold: 3,
  coolMs: 30_000,
  maxCoolMs: 10 * 60_000,
}

/**
 * A circuit breaker per endpoint, on timeouts only.
 *
 * ⚠ TIMEOUTS, NOT FAILURES. A 500 comes back in milliseconds and costs nothing
 * to repeat; a socket that says nothing holds a slot for the whole timeout.
 * After `threshold` of those in a row, the endpoint's jobs are deferred
 * without an attempt until it cools, and then ONE attempt decides: an answer
 * closes the breaker, another timeout opens it again for twice as long.
 */
export class EndpointBreaker {
  private readonly state = new Map<
    string,
    { timeouts: number; openUntil: number; opened: number }
  >()

  constructor(private readonly opts: BreakerOptions = BREAKER) {}

  /** When the endpoint may next be tried, if it is cooling; null if it may now. */
  coolingUntil(endpointId: string, now = Date.now()): Date | null {
    const s = this.state.get(endpointId)
    return s && s.openUntil > now ? new Date(s.openUntil) : null
  }

  record(endpointId: string, timedOut: boolean, now = Date.now()): void {
    if (!timedOut) {
      this.state.delete(endpointId)
      return
    }
    const s = this.state.get(endpointId) ?? { timeouts: 0, openUntil: 0, opened: 0 }
    s.timeouts++
    if (s.timeouts >= this.opts.threshold) {
      const cool = Math.min(this.opts.maxCoolMs, this.opts.coolMs * 2 ** s.opened)
      s.openUntil = now + cool
      s.opened++
    }
    this.state.set(endpointId, s)
  }
}

/**
 * Waits until an endpoint's per-second limit has room, then takes a place.
 *
 * ⚠ COUNTED IN REDIS, SO THE LIMIT HOLDS ACROSS REPLICAS. A customer who asks
 * for 5 a second means 5 a second at their door, not 5 per worker. A fixed
 * one-second window: simple, never over the limit, and the wait is at most
 * the rest of the current second - short enough to spend inside the job
 * rather than to re-queue it.
 *
 * ⚠ SVIX STORES THIS AND NEVER READS IT. In its lab, an endpoint limited to 2
 * a second received 40 events in 30ms.
 */
export async function takeThrottleSlot(
  redis: Redis,
  prefix: string,
  endpointId: string,
  perSecond: number,
  sleep: (ms: number) => Promise<unknown> = Bun.sleep,
): Promise<void> {
  for (;;) {
    const now = Date.now()
    const second = Math.floor(now / 1000)
    const key = `${prefix}:rate:${endpointId}:${second}`
    const [[, count]] = (await redis.multi().incr(key).expire(key, 2).exec()) as [
      [unknown, number],
      [unknown, unknown],
    ]
    if (count <= perSecond) return
    await sleep((second + 1) * 1000 - now + 5)
  }
}
