import { describe, expect, it } from "bun:test"
import {
  budgetKey,
  DOWN_KEY,
  verdictKey,
  webRiskChecker,
  type WebRiskRedis,
} from "../src/risk/webrisk.js"

/**
 * Web Risk behind a daily budget and a failure cache (#222).
 *
 * ⚠ THE PROPERTY THAT MATTERS IS "NEVER COSTS MONEY": past the budget, with no
 * Redis to count in, or after a refused quota, nothing is called at all.
 */
class FakeRedis implements WebRiskRedis {
  kv = new Map<string, string>()
  ttl = new Map<string, number>()
  async get(k: string) {
    return this.kv.get(k) ?? null
  }
  async setex(k: string, s: number, v: string) {
    this.kv.set(k, v)
    this.ttl.set(k, s)
    return "OK"
  }
  async incr(k: string) {
    const n = Number(this.kv.get(k) ?? 0) + 1
    this.kv.set(k, String(n))
    return n
  }
  async expire(k: string, s: number) {
    this.ttl.set(k, s)
    return 1
  }
}

const NOW = new Date("2026-09-29T12:00:00Z")

function fetcher(status = 200, body: unknown = {}) {
  const calls: string[] = []
  const f = (async (url: string) => {
    calls.push(url)
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  return { f, calls }
}

describe("webRiskChecker", () => {
  it("looks a host up once and serves the day from the cache", async () => {
    const redis = new FakeRedis()
    const { f, calls } = fetcher(200, {})
    const w = webRiskChecker({
      key: "k",
      dailyLimit: 10,
      redis,
      fetch: f,
      now: () => NOW,
    })
    expect(await w.lookup("acme.com")).toBe("clean")
    expect(await w.lookup("acme.com")).toBe("clean")
    expect(calls).toHaveLength(1)
    expect(redis.ttl.get(verdictKey("acme.com"))).toBe(86_400)
    expect(await w.spent()).toBe(1)
  })

  it("records threat types as the verdict", async () => {
    const { f } = fetcher(200, { threat: { threatTypes: ["MALWARE"] } })
    const w = webRiskChecker({
      key: "k",
      dailyLimit: 10,
      redis: new FakeRedis(),
      fetch: f,
    })
    expect(await w.lookup("evil.example")).toBe("MALWARE")
  })

  it("stops at the daily budget, and counts the day in UTC", async () => {
    const redis = new FakeRedis()
    const { f, calls } = fetcher()
    const w = webRiskChecker({
      key: "k",
      dailyLimit: 2,
      redis,
      fetch: f,
      now: () => NOW,
    })
    expect(await w.lookup("a.com")).toBe("clean")
    expect(await w.lookup("b.com")).toBe("clean")
    expect(await w.lookup("c.com")).toBeNull()
    expect(calls).toHaveLength(2)
    expect(redis.kv.get(budgetKey(NOW))).toBe("3")
    expect(budgetKey(NOW)).toBe("risk:webrisk:budget:2026-09-29")
    // A cached verdict is still served past the budget: it costs nothing.
    expect(await w.lookup("a.com")).toBe("clean")
  })

  it("spends nothing without Redis, because it cannot count", async () => {
    const { f, calls } = fetcher()
    const w = webRiskChecker({ key: "k", dailyLimit: 10, fetch: f })
    expect(await w.lookup("a.com")).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it("spends nothing without a key, and still serves cached verdicts", async () => {
    const redis = new FakeRedis()
    await redis.setex(verdictKey("a.com"), 60, "clean")
    const { f, calls } = fetcher()
    const w = webRiskChecker({ dailyLimit: 10, redis, fetch: f })
    expect(await w.lookup("a.com")).toBe("clean")
    expect(await w.lookup("b.com")).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it("stops every lookup for a while after a refused quota", async () => {
    const redis = new FakeRedis()
    const { f, calls } = fetcher(429)
    const w = webRiskChecker({ key: "k", dailyLimit: 10, redis, fetch: f })
    expect(await w.lookup("a.com")).toBeNull()
    expect(redis.kv.get(DOWN_KEY)).toBe("429")
    expect(await w.lookup("b.com")).toBeNull()
    expect(calls).toHaveLength(1)
  })

  it("parks only the host on a 4xx about that host", async () => {
    const redis = new FakeRedis()
    let n = 0
    const f = (async () =>
      new Response("{}", { status: n++ === 0 ? 400 : 200 })) as unknown as typeof fetch
    const w = webRiskChecker({ key: "k", dailyLimit: 10, redis, fetch: f })
    expect(await w.lookup("bad host.com")).toBeNull()
    expect(redis.kv.get(DOWN_KEY)).toBeUndefined()
    expect(await w.lookup("bad host.com")).toBeNull()
    expect(await w.lookup("fine.com")).toBe("clean")
  })

  it("treats an unreachable service like a refusal", async () => {
    const redis = new FakeRedis()
    const f = (async () => {
      throw new Error("ECONNRESET")
    }) as unknown as typeof fetch
    const w = webRiskChecker({ key: "k", dailyLimit: 10, redis, fetch: f })
    expect(await w.lookup("a.com")).toBeNull()
    expect(redis.kv.get(DOWN_KEY)).toBe("unreachable")
  })

  it("never calls out from `cached`", async () => {
    const { f, calls } = fetcher()
    const w = webRiskChecker({
      key: "k",
      dailyLimit: 10,
      redis: new FakeRedis(),
      fetch: f,
    })
    expect(await w.cached("a.com")).toBeNull()
    expect(calls).toHaveLength(0)
  })
})
