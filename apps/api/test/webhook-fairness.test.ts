import { describe, expect, it } from "bun:test"
import { createQueueClient } from "../src/cache/redis.js"
import {
  EndpointBreaker,
  shareOf,
  takeThrottleSlot,
  WorkspaceShare,
} from "../src/webhooks/fairness.js"

describe("a workspace's share of the slots", () => {
  it("is a quarter of them, and never fewer than two", () => {
    expect(shareOf(32)).toBe(8)
    expect(shareOf(8)).toBe(2)
    expect(shareOf(1)).toBe(2)
  })

  it("refuses past the share and frees on release", () => {
    const s = new WorkspaceShare(2)
    expect(s.tryAcquire("a")).toBe(true)
    expect(s.tryAcquire("a")).toBe(true)
    expect(s.tryAcquire("a")).toBe(false)
    // Another workspace is unaffected.
    expect(s.tryAcquire("b")).toBe(true)
    s.release("a")
    expect(s.tryAcquire("a")).toBe(true)
    s.release("a")
    s.release("a")
    expect(s.current("a")).toBe(0)
  })
})

describe("the circuit breaker", () => {
  const opts = { threshold: 3, coolMs: 1_000, maxCoolMs: 3_000 }

  it("opens after the threshold of timeouts in a row, not before", () => {
    const b = new EndpointBreaker(opts)
    b.record("ep", true, 0)
    b.record("ep", true, 0)
    expect(b.coolingUntil("ep", 0)).toBeNull()
    b.record("ep", true, 0)
    expect(b.coolingUntil("ep", 0)?.getTime()).toBe(1_000)
    expect(b.coolingUntil("ep", 1_000)).toBeNull()
  })

  it("doubles each time it opens again, up to the ceiling", () => {
    const b = new EndpointBreaker(opts)
    for (let i = 0; i < 3; i++) b.record("ep", true, 0)
    b.record("ep", true, 10_000)
    expect(b.coolingUntil("ep", 10_000)?.getTime()).toBe(12_000)
    b.record("ep", true, 20_000)
    expect(b.coolingUntil("ep", 20_000)?.getTime()).toBe(23_000)
  })

  // ⚠ ONLY TIMEOUTS COUNT. A 500 is cheap to repeat; an answer of any kind
  // means the endpoint is there.
  it("closes on any answer", () => {
    const b = new EndpointBreaker(opts)
    for (let i = 0; i < 3; i++) b.record("ep", true, 0)
    b.record("ep", false, 0)
    expect(b.coolingUntil("ep", 0)).toBeNull()
  })
})

const REDIS = process.env.WEBHOOKS_TEST_REDIS_URL
;(REDIS ? describe : describe.skip)("the throttle, against Redis", () => {
  it("lets through at most the limit in any one second", async () => {
    const redis = createQueueClient(REDIS!)
    const prefix = `throttle-test:${crypto.randomUUID().slice(0, 8)}`
    const started = Date.now()
    const at: number[] = []
    await Promise.all(
      Array.from({ length: 9 }, async () => {
        await takeThrottleSlot(redis, prefix, "ep", 3)
        at.push(Date.now())
      }),
    )
    const perSecond = new Map<number, number>()
    for (const t of at)
      perSecond.set(
        Math.floor(t / 1000),
        (perSecond.get(Math.floor(t / 1000)) ?? 0) + 1,
      )
    expect(Math.max(...perSecond.values())).toBeLessThanOrEqual(3)
    // Nine at three a second need three distinct seconds. (Not "over two
    // seconds" of wall time: a fixed window started late in a second can
    // span three of them in a little over one.)
    expect(perSecond.size).toBeGreaterThanOrEqual(3)
    expect(Date.now() - started).toBeGreaterThan(1_000)
    redis.disconnect()
  }, 10_000)
})
