import { describe, expect, it } from "bun:test"
import { loadEnv } from "../src/env.js"
import { evaluate } from "../src/risk/engine.js"
import {
  asVerdict,
  combine,
  linkChecker,
  CLEAN_ANSWER,
  SKIPPED,
  UNKNOWN,
  type LinkAnswer,
  type LinkProvider,
} from "../src/risk/link-check.js"
import { buildLinks } from "../src/risk/link-config.js"
import { CLOUDFLARE, QUAD9, type DohTransport } from "../src/risk/link-dns.js"
import {
  describeFlags,
  encodeVerdict,
  isDecisive,
  parseVerdict,
} from "../src/risk/link-verdict.js"
import {
  healthKeys,
  providerHealth,
  watched,
  type HealthRedis,
} from "../src/risk/provider-health.js"
import { webRiskChecker, webRiskProvider } from "../src/risk/webrisk.js"
import { baseFacts } from "./risk-fixtures.js"

/**
 * Link checking behind one port, the points a verdict earns, and the health
 * record that keeps a dead provider from being silent (#222).
 */

/** A Redis with a clock, so "once a day" can be tested without waiting a day. */
class ClockRedis implements HealthRedis {
  kv = new Map<string, { value: string; expires: number }>()
  constructor(readonly clock: { now: Date }) {}
  private live(key: string) {
    const e = this.kv.get(key)
    if (e && e.expires <= this.clock.now.getTime()) this.kv.delete(key)
    return this.kv.get(key)
  }
  async get(k: string) {
    return this.live(k)?.value ?? null
  }
  /** `SET key value EX seconds NX`: the mode flags are the only form used, so they are not read. */
  async set(k: string, v: string, _mode: "EX", s: number) {
    if (this.live(k)) return null
    this.kv.set(k, { value: v, expires: this.clock.now.getTime() + s * 1000 })
    return "OK"
  }
  async setex(k: string, s: number, v: string) {
    this.kv.set(k, { value: v, expires: this.clock.now.getTime() + s * 1000 })
    return "OK"
  }
  async incr(k: string) {
    const e = this.live(k)
    const n = Number(e?.value ?? 0) + 1
    this.kv.set(k, { value: String(n), expires: e?.expires ?? Number.MAX_SAFE_INTEGER })
    return n
  }
  async expire(k: string, s: number) {
    const e = this.live(k)
    if (e) e.expires = this.clock.now.getTime() + s * 1000
    return e ? 1 : 0
  }
  async del(...keys: string[]) {
    for (const k of keys) this.kv.delete(k)
    return keys.length
  }
}

const MIN = 60_000

describe("the verdict string", () => {
  it("is `clean` for nothing, and one segment per flagging provider, in a stable order", () => {
    expect(encodeVerdict([])).toBe("clean")
    expect(
      encodeVerdict([
        { provider: "quad9", labels: ["blocked"] },
        { provider: "cloudflare", labels: ["blocked"] },
      ]),
    ).toBe("cloudflare=blocked;quad9=blocked")
    expect(
      encodeVerdict([
        { provider: "webrisk", labels: ["MALWARE", "UNWANTED_SOFTWARE"] },
      ]),
    ).toBe("webrisk=MALWARE,UNWANTED_SOFTWARE")
  })

  it("reads back what it wrote", () => {
    const flags = [
      { provider: "cloudflare", labels: ["blocked"] },
      { provider: "webrisk", labels: ["MALWARE", "SOCIAL_ENGINEERING"] },
    ]
    expect(parseVerdict(encodeVerdict(flags))).toEqual(flags)
    expect(parseVerdict("clean")).toEqual([])
  })

  // ⚠ ROWS WRITTEN BEFORE THERE WAS MORE THAN ONE PROVIDER ARE JUST THE THREAT TYPES.
  it("reads a segment-less verdict as Web Risk's", () => {
    expect(parseVerdict("MALWARE,SOCIAL_ENGINEERING")).toEqual([
      { provider: "webrisk", labels: ["MALWARE", "SOCIAL_ENGINEERING"] },
    ])
  })

  it("is decisive for Web Risk alone, or for two providers, never for one resolver", () => {
    expect(isDecisive(parseVerdict("MALWARE"))).toBe(true)
    expect(isDecisive(parseVerdict("webrisk=MALWARE"))).toBe(true)
    expect(isDecisive(parseVerdict("cloudflare=blocked;quad9=blocked"))).toBe(true)
    expect(isDecisive(parseVerdict("cloudflare=blocked"))).toBe(false)
    expect(isDecisive(parseVerdict("quad9=blocked"))).toBe(false)
    expect(isDecisive([])).toBe(false)
    expect(describeFlags(parseVerdict("cloudflare=blocked;quad9=blocked"))).toBe(
      "cloudflare: blocked, quad9: blocked",
    )
  })

  it("is read by the trust matcher as clean, unsafe or unknown", () => {
    expect(asVerdict(null)).toBe("unknown")
    expect(asVerdict("clean")).toBe("clean")
    expect(asVerdict("cloudflare=blocked")).toBe("unsafe")
    expect(asVerdict("MALWARE")).toBe("unsafe")
  })
})

describe("combining what the providers said", () => {
  const unsafe = (...labels: string[]): LinkAnswer => ({ kind: "unsafe", labels })
  const a = (provider: string, answer: LinkAnswer) => ({ provider, answer })

  it("is clean only when every provider that could speak said clean", () => {
    expect(combine([a("cloudflare", CLEAN_ANSWER), a("quad9", CLEAN_ANSWER)])).toBe(
      "clean",
    )
    expect(combine([a("cloudflare", CLEAN_ANSWER), a("quad9", SKIPPED)])).toBe("clean")
    expect(combine([a("cloudflare", SKIPPED), a("quad9", SKIPPED)])).toBe("clean")
  })

  it("never stores an unknown as clean, and stores nothing from no providers", () => {
    expect(combine([a("cloudflare", CLEAN_ANSWER), a("quad9", UNKNOWN)])).toBeNull()
    expect(combine([a("cloudflare", UNKNOWN)])).toBeNull()
    expect(combine([])).toBeNull()
  })

  it("stores a decisive block at once, even while another provider is unknown", () => {
    expect(combine([a("webrisk", unsafe("MALWARE")), a("cloudflare", UNKNOWN)])).toBe(
      "webrisk=MALWARE",
    )
    expect(
      combine([a("cloudflare", unsafe("blocked")), a("quad9", unsafe("blocked"))]),
    ).toBe("cloudflare=blocked;quad9=blocked")
  })

  // ⚠ A ROW IS STORED ONCE: a half-answer would freeze one resolver's 45 where two would be 90.
  it("waits for the other resolver before storing a block that is not yet decisive", () => {
    expect(
      combine([a("cloudflare", unsafe("blocked")), a("quad9", UNKNOWN)]),
    ).toBeNull()
    expect(
      combine([a("cloudflare", unsafe("blocked")), a("quad9", CLEAN_ANSWER)]),
    ).toBe("cloudflare=blocked")
  })
})

describe("the checker over providers", () => {
  function fake(name: string, answer: LinkAnswer) {
    const calls: string[] = []
    const provider: LinkProvider = {
      name,
      async cached() {
        calls.push(`cached ${name}`)
        return UNKNOWN
      },
      async lookup() {
        calls.push(`lookup ${name}`)
        return answer
      },
    }
    return { provider, calls }
  }

  it("asks every provider, counts what each said, and never calls out from `cached`", async () => {
    const a = fake("cloudflare", { kind: "unsafe", labels: ["blocked"] })
    const b = fake("quad9", CLEAN_ANSWER)
    const checker = linkChecker([a.provider, b.provider])
    expect(await checker.cached("x.example")).toBeNull()
    expect(a.calls).toEqual(["cached cloudflare"])
    expect(await checker.lookup("x.example")).toBe("cloudflare=blocked")
    expect(checker.stats()).toEqual({
      cloudflare: { clean: 0, unsafe: 1, unknown: 0, skipped: 0 },
      quad9: { clean: 1, unsafe: 0, unknown: 0, skipped: 0 },
    })
  })

  it("reads a provider that throws as unknown rather than failing the run", async () => {
    const broken: LinkProvider = {
      name: "webrisk",
      cached: async () => UNKNOWN,
      lookup: async () => {
        throw new Error("boom")
      },
    }
    const checker = linkChecker([broken, fake("quad9", CLEAN_ANSWER).provider])
    expect(await checker.lookup("x.example")).toBeNull()
    expect(checker.stats().webrisk).toMatchObject({ unknown: 1 })
  })
})

/** Answers each resolver URL with a fixed reply. */
function resolvers(replies: Record<string, (name: string) => Uint8Array>) {
  const asked: string[] = []
  const send: DohTransport = async (url, query) => {
    const labels: string[] = []
    for (let at = 12; query[at] !== 0; at += 1 + query[at]!)
      labels.push(Buffer.from(query.subarray(at + 1, at + 1 + query[at]!)).toString())
    const name = labels.join(".")
    asked.push(`${url} ${name}`)
    return { status: 200, body: replies[url]!(name) }
  }
  return { send, asked }
}

function dns(name: string, rcode: number, addresses: string[], authority = 0) {
  const out: number[] = [
    0,
    0,
    0x81,
    0x80 | rcode,
    0,
    1,
    0,
    addresses.length,
    0,
    authority,
    0,
    0,
  ]
  for (const label of name.split(".")) out.push(label.length, ...Buffer.from(label))
  out.push(0, 0, 1, 0, 1)
  for (const address of addresses)
    out.push(
      0xc0,
      0x0c,
      0,
      1,
      0,
      1,
      0,
      0,
      0,
      60,
      0,
      4,
      ...address.split(".").map(Number),
    )
  for (let i = 0; i < authority; i++)
    out.push(0xc0, 0x0c, 0, 6, 0, 1, 0, 0, 0, 60, 0, 0)
  return Uint8Array.from(out)
}

describe("which providers run", () => {
  const clock = { now: new Date("2026-11-11T12:00:00Z") }
  const base = { webRiskDailyLimit: 10, dnsDailyLimit: 10 }

  it("runs the DNS provider alone by default: Cloudflare and Quad9", () => {
    const env = loadEnv({
      DATABASE_URL: "postgres://i10_api:pw@localhost:5432/i10",
      REDIS_URL: "redis://localhost:6379",
      CLERK_WEBHOOK_SECRET: "whsec_test",
      CLERK_SECRET_KEY: "sk_test_abc",
      MAIL_DOMAINS: "i10.tech",
      SES_CONFIGURATION_SET: "i10-events",
      WEBRISK_API_KEY: "a-key-that-is-set-but-not-listed",
    })
    expect(env.RISK_LINK_PROVIDERS).toEqual(["dns"])
    const { names, webRisk } = buildLinks({
      ...base,
      providers: env.RISK_LINK_PROVIDERS,
      webRiskKey: env.WEBRISK_API_KEY!,
    })
    expect(names).toEqual(["cloudflare", "quad9"])
    expect(webRisk).toBeUndefined()
  })

  it("adds Web Risk only when it is listed and a key is set", () => {
    const warned: string[] = []
    const log = { warn: (_o: object, m: string) => void warned.push(m) }
    expect(
      buildLinks({ ...base, providers: ["dns", "webrisk"], webRiskKey: "k", log })
        .names,
    ).toEqual(["cloudflare", "quad9", "webrisk"])
    expect(warned).toEqual([])
    const noKey = buildLinks({ ...base, providers: ["dns", "webrisk"], log })
    expect(noKey.names).toEqual(["cloudflare", "quad9"])
    expect(noKey.webRisk).toBeUndefined()
    expect(warned).toHaveLength(1)
    expect(
      buildLinks({ ...base, providers: ["webrisk"], webRiskKey: "k" }).names,
    ).toEqual(["webrisk"])
  })

  it("runs nothing when nothing is listed, and then stores no verdict", async () => {
    const { checker, names } = buildLinks({ ...base, providers: [] })
    expect(names).toEqual([])
    expect(await checker.lookup("example.com")).toBeNull()
  })

  it("validates the setting like its neighbours", () => {
    const env = (v: string | undefined) =>
      loadEnv({
        DATABASE_URL: "postgres://i10_api:pw@localhost:5432/i10",
        REDIS_URL: "redis://localhost:6379",
        CLERK_WEBHOOK_SECRET: "whsec_test",
        CLERK_SECRET_KEY: "sk_test_abc",
        MAIL_DOMAINS: "i10.tech",
        SES_CONFIGURATION_SET: "i10-events",
        ...(v === undefined ? {} : { RISK_LINK_PROVIDERS: v }),
      })
    expect(env("dns,webrisk").RISK_LINK_PROVIDERS).toEqual(["dns", "webrisk"])
    expect(env(" WebRisk , dns,dns ").RISK_LINK_PROVIDERS).toEqual(["webrisk", "dns"])
    expect(env("").RISK_LINK_PROVIDERS).toEqual([])
    expect(() => env("dns,bing")).toThrow(/unknown link provider bing/)
    expect(() => env("quad9")).toThrow(/expected dns, webrisk/)
    expect(env(undefined).RISK_DNS_DAILY_LIMIT).toBe(5000)
  })

  it("answers a host through both resolvers: two blocks make `cloudflare=blocked;quad9=blocked`", async () => {
    const redis = new ClockRedis(clock)
    const t = resolvers({
      [CLOUDFLARE.filtered]: (n) => dns(n, 0, ["0.0.0.0"]),
      [CLOUDFLARE.unfiltered]: (n) => dns(n, 0, ["208.94.116.246"]),
      [QUAD9.filtered]: (n) => dns(n, 3, []),
      [QUAD9.unfiltered]: (n) => dns(n, 0, ["208.94.116.246"]),
    })
    const { checker } = buildLinks({
      ...base,
      providers: ["dns"],
      redis,
      transport: t.send,
      now: () => clock.now,
    })
    expect(await checker.lookup("malware.wicar.org")).toBe(
      "cloudflare=blocked;quad9=blocked",
    )
    expect(t.asked).toHaveLength(4)
    // the second ask is wholly from cache
    expect(await checker.lookup("malware.wicar.org")).toBe(
      "cloudflare=blocked;quad9=blocked",
    )
    expect(await checker.cached("malware.wicar.org")).toBe(
      "cloudflare=blocked;quad9=blocked",
    )
    expect(t.asked).toHaveLength(4)
  })

  it("stores clean for an ordinary host and for one that does not exist, never a block", async () => {
    const redis = new ClockRedis(clock)
    const t = resolvers({
      [CLOUDFLARE.filtered]: (n) => dns(n, 3, [], 1),
      [QUAD9.filtered]: (n) => dns(n, 3, [], 1),
    })
    const { checker } = buildLinks({
      ...base,
      providers: ["dns"],
      redis,
      transport: t.send,
      now: () => clock.now,
    })
    expect(await checker.lookup("nobody-registered-this.example.com")).toBe("clean")
    expect(t.asked).toHaveLength(2)
  })

  it("stores nothing while one resolver is down and the other only half-decides", async () => {
    const redis = new ClockRedis(clock)
    const send: DohTransport = async (url, query) => {
      if (url.includes("quad9")) return { status: 503, body: new Uint8Array() }
      const labels: string[] = []
      for (let at = 12; query[at] !== 0; at += 1 + query[at]!)
        labels.push(Buffer.from(query.subarray(at + 1, at + 1 + query[at]!)).toString())
      const name = labels.join(".")
      return {
        status: 200,
        body:
          url === CLOUDFLARE.filtered
            ? dns(name, 0, ["0.0.0.0"])
            : dns(name, 0, ["1.2.3.4"]),
      }
    }
    const { checker } = buildLinks({
      ...base,
      providers: ["dns"],
      redis,
      transport: send,
      now: () => clock.now,
    })
    expect(await checker.lookup("half.example.com")).toBeNull()
    expect(checker.stats().cloudflare).toMatchObject({ unsafe: 1 })
    expect(checker.stats().quad9).toMatchObject({ unknown: 1 })
  })
})

describe("what a verdict is worth", () => {
  const facts = (...unsafe: { host: string; verdict: string }[]) =>
    baseFacts({ links: { unsafe: unsafe.map((u) => ({ ...u, day: "2026-09-28" })) } })
  const rule = (f: ReturnType<typeof facts>) =>
    evaluate(f).contributions.find((c) => c.rule === "links.unsafe")

  it("keeps Web Risk at 90 points and the critical floor, new format and old", () => {
    for (const verdict of [
      "MALWARE",
      "webrisk=SOCIAL_ENGINEERING",
      "webrisk=MALWARE,UNWANTED_SOFTWARE",
    ]) {
      const a = evaluate(facts({ host: "evil.example", verdict }))
      const c = a.contributions.find((x) => x.rule === "links.unsafe")!
      expect(c.points).toBe(90)
      expect(c.floor).toBe("critical")
      expect(a.band).toBe("critical")
      expect(String(c.evidence.hosts)).toContain("webrisk")
    }
  })

  it("gives both resolvers agreeing the same 90 points and floor, and names both", () => {
    const a = evaluate(
      facts({ host: "evil.example", verdict: "cloudflare=blocked;quad9=blocked" }),
    )
    const c = a.contributions.find((x) => x.rule === "links.unsafe")!
    expect(c.points).toBe(90)
    expect(c.floor).toBe("critical")
    expect(a.band).toBe("critical")
    expect(c.evidence.hosts).toBe("evil.example (cloudflare: blocked, quad9: blocked)")
  })

  it("gives exactly one resolver 45 points and no floor, naming which", () => {
    for (const [verdict, who] of [
      ["cloudflare=blocked", "cloudflare"],
      ["quad9=blocked", "quad9"],
    ] as const) {
      const a = evaluate(facts({ host: "maybe.example", verdict }))
      const c = a.contributions.find((x) => x.rule === "links.unsafe")!
      expect(c.points).toBe(45)
      expect(c.floor).toBeUndefined()
      expect(a.band).toBe("elevated")
      expect(c.evidence.hosts).toBe(`maybe.example (${who}: blocked)`)
    }
  })

  it("does not add two different hosts' single opinions into agreement", () => {
    const c = rule(
      facts(
        { host: "a.example", verdict: "cloudflare=blocked" },
        { host: "b.example", verdict: "quad9=blocked" },
      ),
    )!
    expect(c.points).toBe(45)
    expect(c.floor).toBeUndefined()
  })

  it("is decided by the strongest host when several are flagged", () => {
    const c = rule(
      facts(
        { host: "a.example", verdict: "cloudflare=blocked" },
        { host: "b.example", verdict: "MALWARE" },
      ),
    )!
    expect(c.points).toBe(90)
    expect(c.floor).toBe("critical")
  })

  it("adds nothing for no flagged host", () => {
    expect(rule(facts())).toBeUndefined()
  })
})

describe("provider health", () => {
  const start = new Date("2026-11-11T12:00:00Z")

  function setup(over: { redis?: boolean } = {}) {
    const clock = { now: new Date(start) }
    const redis = new ClockRedis(clock)
    const alerts: {
      message: string
      level: string
      context: Record<string, unknown>
    }[] = []
    const infos: { o: object; m: string }[] = []
    const health = providerHealth({
      ...(over.redis === false ? {} : { redis }),
      alert: (message, level, context) => void alerts.push({ message, level, context }),
      log: { info: (o, m) => void infos.push({ o, m }), warn: () => {} },
      now: () => clock.now,
    })
    const advance = (ms: number) =>
      void (clock.now = new Date(clock.now.getTime() + ms))
    return { health, redis, alerts, infos, advance, clock }
  }

  it("stays quiet below five failures in a row", async () => {
    const { health, alerts, advance } = setup()
    for (let i = 0; i < 4; i++) {
      await health.failure("webrisk", "403")
      advance(60 * MIN)
    }
    expect(alerts).toEqual([])
  })

  it("stays quiet when the failures are all within half an hour: one blip, not an incident", async () => {
    const { health, alerts, advance } = setup()
    for (let i = 0; i < 20; i++) {
      await health.failure("webrisk", "403")
      advance(1 * MIN)
    }
    expect(alerts).toEqual([])
  })

  it("alerts once when five failures in a row span half an hour, then not again for a day", async () => {
    const { health, alerts, advance } = setup()
    for (let i = 0; i < 5; i++) {
      await health.failure("webrisk", "Web Risk answered 403")
      advance(8 * MIN)
    }
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toMatchObject({
      level: "error",
      context: { provider: "webrisk", failures: 5, reason: "Web Risk answered 403" },
    })
    expect(alerts[0]!.message).toContain("webrisk")

    for (let i = 0; i < 30; i++) {
      await health.failure("webrisk", "403")
      advance(30 * MIN)
    }
    // 15 hours on: still the first alert
    expect(alerts).toHaveLength(1)
    advance(10 * 60 * MIN)
    await health.failure("webrisk", "403")
    expect(alerts).toHaveLength(2)
  })

  it("is reset by one success, and then needs five failures again", async () => {
    const { health, alerts, infos, advance, redis } = setup()
    for (let i = 0; i < 4; i++) {
      await health.failure("quad9", "503")
      advance(20 * MIN)
    }
    await health.success("quad9")
    expect(await redis.get(healthKeys("quad9").fails)).toBeNull()
    for (let i = 0; i < 4; i++) {
      await health.failure("quad9", "503")
      advance(20 * MIN)
    }
    expect(alerts).toEqual([])
    // no recovery line: nothing had been alerted
    expect(infos).toEqual([])
  })

  it("logs recovery after an alert, and clears the day's silence so the next outage alerts", async () => {
    const { health, alerts, infos, advance } = setup()
    for (let i = 0; i < 5; i++) {
      await health.failure("cloudflare", "timeout")
      advance(10 * MIN)
    }
    expect(alerts).toHaveLength(1)
    await health.success("cloudflare")
    expect(infos).toEqual([
      { o: { provider: "cloudflare" }, m: "link check provider recovered" },
    ])
    for (let i = 0; i < 5; i++) {
      await health.failure("cloudflare", "timeout")
      advance(10 * MIN)
    }
    expect(alerts).toHaveLength(2)
  })

  it("keeps each provider's record apart", async () => {
    const { health, alerts, advance } = setup()
    for (let i = 0; i < 5; i++) {
      await health.failure("quad9", "503")
      await health.success("cloudflare")
      advance(10 * MIN)
    }
    expect(alerts).toHaveLength(1)
    expect(alerts[0]!.context.provider).toBe("quad9")
  })

  it("records nothing, alerts nothing and throws nothing without Redis", async () => {
    const { health, alerts } = setup({ redis: false })
    for (let i = 0; i < 10; i++) await health.failure("webrisk", "403")
    await health.success("webrisk")
    expect(alerts).toEqual([])
  })

  it("does not let a Redis error reach the scoring path", async () => {
    const broken = {
      get: async () => {
        throw new Error("down")
      },
      set: async () => {
        throw new Error("down")
      },
      incr: async () => {
        throw new Error("down")
      },
      expire: async () => 0,
      setex: async () => "OK",
      del: async () => 0,
    } satisfies HealthRedis
    const health = providerHealth({ redis: broken })
    await health.failure("webrisk", "403")
    await health.success("webrisk")
  })

  it("reports a watched call: a value is a success, null and a throw are failures", async () => {
    const events: string[] = []
    const h = {
      success: async (p: string) => void events.push(`ok ${p}`),
      failure: async (p: string, r: string) => void events.push(`fail ${p} ${r}`),
    }
    expect(await watched(h, "laya", async () => 0.4)).toBe(0.4)
    expect(await watched(h, "laya", async () => null)).toBeNull()
    await expect(
      watched(h, "laya", async () => {
        throw new Error("econnreset")
      }),
    ).rejects.toThrow("econnreset")
    expect(await watched(undefined, "laya", async () => 1)).toBe(1)
    expect(events).toEqual([
      "ok laya",
      "fail laya no answer",
      "fail laya Error: econnreset",
    ])
  })
})

describe("Web Risk reports to the health record", () => {
  const clock = { now: new Date("2026-11-11T12:00:00Z") }

  function setup() {
    const redis = new ClockRedis(clock)
    const alerts: string[] = []
    const events: string[] = []
    const health = {
      success: async (p: string) => void events.push(`ok ${p}`),
      failure: async (p: string, r: string) => void events.push(`fail ${p} ${r}`),
    }
    const real = providerHealth({
      redis,
      alert: (m) => void alerts.push(m),
      now: () => clock.now,
    })
    const web = (status: number, h: typeof health | typeof real = health) =>
      webRiskChecker({
        key: "k",
        dailyLimit: 100,
        redis: {
          get: (k) => redis.get(k),
          setex: (k, s, v) => redis.setex(k, s, v),
          incr: (k) => redis.incr(k),
          expire: (k, s) => redis.expire(k, s),
        },
        fetch: (async () => new Response("{}", { status })) as unknown as typeof fetch,
        health: h,
        now: () => clock.now,
      })
    return { redis, alerts, events, web, real }
  }

  it("counts the 403 that went unnoticed for a month as a failure", async () => {
    const { web, events } = setup()
    expect(await web(403).lookup("a.example")).toBeNull()
    expect(events).toEqual([expect.stringContaining("fail webrisk")])
    expect(events[0]).toContain("403")
  })

  it("raises the alert for a Web Risk that keeps answering 403, across hosts and half an hour", async () => {
    const { web, real, alerts } = setup()
    const w = web(403, real)
    for (let i = 0; i < 6; i++) {
      expect(await w.lookup(`h${i}.example`)).toBeNull()
      clock.now = new Date(clock.now.getTime() + 8 * MIN)
    }
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toContain("webrisk")
  })

  it("counts 401, 429, 5xx and an unreachable service too", async () => {
    for (const status of [401, 429, 500, 503]) {
      const { web, events } = setup()
      await web(status).lookup("a.example")
      expect(events).toHaveLength(1)
    }
    const { redis, events } = setup()
    const unreachable = webRiskChecker({
      key: "k",
      dailyLimit: 10,
      redis: {
        get: (k) => redis.get(k),
        setex: (k, s, v) => redis.setex(k, s, v),
        incr: (k) => redis.incr(k),
        expire: (k, s) => redis.expire(k, s),
      },
      fetch: (async () => {
        throw new Error("ECONNRESET")
      }) as unknown as typeof fetch,
      health: {
        success: async () => {},
        failure: async (_p, r) => void events.push(r),
      },
    })
    await unreachable.lookup("a.example")
    expect(events[0]).toContain("ECONNRESET")
  })

  it("does not count a 400 or 404, which are about one host, as the provider failing", async () => {
    for (const status of [400, 404]) {
      const { web, events } = setup()
      await web(status).lookup("bad host.example")
      expect(events).toEqual([])
    }
  })

  it("reports a success when it answers", async () => {
    const { web, events } = setup()
    expect(await web(200).lookup("a.example")).toBe("clean")
    expect(events).toEqual(["ok webrisk"])
  })

  it("reports nothing when no call was made: no key, no Redis, budget spent, parked, cached", async () => {
    const { redis, events } = setup()
    const health = {
      success: async () => void events.push("ok"),
      failure: async () => void events.push("fail"),
    }
    const store = {
      get: (k: string) => redis.get(k),
      setex: (k: string, s: number, v: string) => redis.setex(k, s, v),
      incr: (k: string) => redis.incr(k),
      expire: (k: string, s: number) => redis.expire(k, s),
    }
    const fetch = (async () =>
      new Response("{}", { status: 403 })) as unknown as typeof globalThis.fetch

    await webRiskChecker({ dailyLimit: 10, redis: store, fetch, health }).lookup(
      "a.example",
    )
    await webRiskChecker({ key: "k", dailyLimit: 10, fetch, health }).lookup(
      "a.example",
    )
    await webRiskChecker({
      key: "k",
      dailyLimit: 0,
      redis: store,
      fetch,
      health,
      now: () => clock.now,
    }).lookup("a.example")
    await redis.setex("risk:webrisk:down", 300, "429")
    await webRiskChecker({
      key: "k",
      dailyLimit: 10,
      redis: store,
      fetch,
      health,
    }).lookup("b.example")
    expect(events).toEqual([])
  })

  it("is a provider that answers in the port's terms", async () => {
    const { redis } = setup()
    const store = {
      get: (k: string) => redis.get(k),
      setex: (k: string, s: number, v: string) => redis.setex(k, s, v),
      incr: (k: string) => redis.incr(k),
      expire: (k: string, s: number) => redis.expire(k, s),
    }
    const make = (body: unknown) =>
      webRiskProvider(
        webRiskChecker({
          key: "k",
          dailyLimit: 10,
          redis: store,
          fetch: (async () =>
            new Response(JSON.stringify(body))) as unknown as typeof fetch,
        }),
      )
    const p = make({ threat: { threatTypes: ["MALWARE", "SOCIAL_ENGINEERING"] } })
    expect(await p.cached("evil.example")).toEqual({ kind: "unknown" })
    expect(await p.lookup("evil.example")).toEqual({
      kind: "unsafe",
      labels: ["MALWARE", "SOCIAL_ENGINEERING"],
    })
    expect(await p.cached("evil.example")).toMatchObject({ kind: "unsafe" })
    expect(await make({}).lookup("fine.example")).toEqual({ kind: "clean" })
    expect(p.name).toBe("webrisk")
  })

  it("is never failing when it is not configured: nothing is recorded for a provider that is not built", async () => {
    const { redis } = setup()
    const { checker } = buildLinks({
      providers: ["webrisk"],
      webRiskDailyLimit: 10,
      dnsDailyLimit: 10,
      redis: {
        get: (k) => redis.get(k),
        setex: (k, s, v) => redis.setex(k, s, v),
        incr: (k) => redis.incr(k),
        expire: (k, s) => redis.expire(k, s),
      },
      health: providerHealth({ redis }),
    })
    await checker.lookup("a.example")
    expect([...redis.kv.keys()]).toEqual([])
  })
})
