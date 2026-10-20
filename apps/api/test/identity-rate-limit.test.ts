import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import {
  PER_IP,
  connectionIn,
  fixedWindow,
  ssoRateLimit,
  trustedClientIp,
  type Counter,
} from "../src/identity/rate-limit.js"
import { CLIENT_HEADER, signClientContext } from "../src/risk/identity.js"

/** The SSO routes' rate limits (#338): per trusted browser address, per connection. */

const SECRET = "c".repeat(40)

function memoryRedis(): Counter & { fail: boolean } {
  const counts = new Map<string, number>()
  return {
    fail: false,
    async incr(key) {
      if (this.fail) throw new Error("redis down")
      const n = (counts.get(key) ?? 0) + 1
      counts.set(key, n)
      return n
    },
    async expire() {
      return 1
    },
  }
}

function app(take = fixedWindow(memoryRedis(), () => 1_000_000)) {
  const a = new Hono()
  a.use("*", ssoRateLimit({ take, contextSecret: SECRET, perConnectionStarts: true }))
  a.post("/sso/attempts", async (c) => c.json({ seen: await c.req.json() }))
  a.post("/sso/bind", (c) => c.json({ ok: true }))
  return a
}

const signed = (ip: string) => signClientContext({ ip, ts: Date.now() }, SECRET)

describe("the address a limit is counted against", () => {
  it("is the signed context's, then Cloudflare's, and never a forged header", () => {
    const h = (o: Record<string, string>) => new Headers(o)
    expect(trustedClientIp(h({ [CLIENT_HEADER]: signed("203.0.113.9") }), SECRET)).toBe(
      "203.0.113.9",
    )
    expect(trustedClientIp(h({ "cf-connecting-ip": "198.51.100.4" }), SECRET)).toBe(
      "198.51.100.4",
    )
    const forged = signClientContext(
      { ip: "203.0.113.9", ts: Date.now() },
      "x".repeat(40),
    )
    expect(trustedClientIp(h({ [CLIENT_HEADER]: forged }), SECRET)).toBeNull()
    expect(trustedClientIp(h({ "x-forwarded-for": "203.0.113.9" }), SECRET)).toBeNull()
  })
})

describe("the limits", () => {
  it("lets an address through up to its limit, then answers 429 with Retry-After", async () => {
    const a = app()
    const call = () =>
      a.request("/sso/bind", {
        method: "POST",
        headers: { "cf-connecting-ip": "198.51.100.4" },
      })
    for (let i = 0; i < PER_IP.max; i++) expect((await call()).status).toBe(200)
    const refused = await call()
    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0)
    // Another address is not affected.
    const other = await a.request("/sso/bind", {
      method: "POST",
      headers: { "cf-connecting-ip": "198.51.100.5" },
    })
    expect(other.status).toBe(200)
  })

  it("skips the per-address limit when no address can be trusted, rather than one shared bucket", async () => {
    const a = app()
    for (let i = 0; i < PER_IP.max + 5; i++)
      expect((await a.request("/sso/bind", { method: "POST" })).status).toBe(200)
  })

  it("counts starts per connection, and leaves the body for the route", async () => {
    const id = "11111111-1111-4111-8111-111111111111"
    let n = 0
    const take = async (key: string) => {
      if (key.startsWith("conn:")) n++
      return n > 2 ? { ok: false as const, retryAfter: 5 } : { ok: true as const }
    }
    const a = app(take)
    const start = () =>
      a.request("/sso/attempts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connection: id }),
      })
    const first = await start()
    expect(await first.json()).toEqual({ seen: { connection: id } })
    await start()
    expect((await start()).status).toBe(429)
  })

  it("rolls over with the window", async () => {
    let t = 1_000_000
    const take = fixedWindow(memoryRedis(), () => t)
    const limit = { max: 1, windowSeconds: 60 }
    expect((await take("ip:x", limit)).ok).toBe(true)
    expect((await take("ip:x", limit)).ok).toBe(false)
    t += 60_000
    expect((await take("ip:x", limit)).ok).toBe(true)
  })

  it("keeps limiting in this process when Redis fails", async () => {
    const redis = memoryRedis()
    redis.fail = true
    const take = fixedWindow(redis, () => 1_000_000)
    const limit = { max: 1, windowSeconds: 60 }
    expect((await take("ip:y", limit)).ok).toBe(true)
    expect((await take("ip:y", limit)).ok).toBe(false)
  })

  it("reads only a well-formed connection id", () => {
    expect(connectionIn({ connection: "11111111-1111-4111-8111-111111111111" })).toBe(
      "11111111-1111-4111-8111-111111111111",
    )
    expect(connectionIn({ connection: "x".repeat(36) })).toBeNull()
    expect(connectionIn(null)).toBeNull()
  })
})
