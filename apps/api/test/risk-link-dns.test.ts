import { describe, expect, it } from "bun:test"
import { decodeMessage, encodeQuery, TYPE_A } from "../src/risk/dns-wire.js"
import {
  BLOCKED_SECONDS,
  CLEAN_SECONDS,
  CLOUDFLARE,
  dnsKeys,
  dnsLookupName,
  dnsProvider,
  HOST_FAIL_SECONDS,
  limiter,
  QUAD9,
  type DnsRedis,
  type DohTransport,
  type Resolver,
} from "../src/risk/link-dns.js"
import type { ProviderHealth } from "../src/risk/provider-health.js"

/**
 * Link checking through Cloudflare's and Quad9's security resolvers (#222).
 *
 * ⚠ THE PROPERTY THAT MATTERS IS "A NAME THAT DOES NOT EXIST IS NEVER A BLOCK".
 * Quad9 blocks with NXDOMAIN, which is also what a nonexistent name gets; every
 * "looks blocked" answer has to be confirmed against the unfiltered resolver
 * and, where the pair cannot settle it, come out unknown.
 */
class FakeRedis implements DnsRedis {
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

const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"))

/**
 * Answers captured live on 2026-11-11 through this module's own transport and
 * codec. `malware.wicar.org` is the WICAR browser-protection test site, which
 * both operators list; the nonexistent name is one nobody registered.
 */
const REAL = {
  cloudflareBlocked: hex(
    "000081800001000100000001076d616c77617265057769636172036f72670000010001c00c000100010000003c00040000000000002904d0000000000006000f00020010",
  ),
  cloudflareReal: hex(
    "000081800001000200000001076d616c77617265057769636172036f72670000010001c00c0005000100000e10001a0c77696361726d616c77617265076e6673686f737403636f6d00c02f0001000100000e100004d05e74f600002904d0000000000000",
  ),
  cloudflareClean: hex(
    "000081800001000200000001076578616d706c6503636f6d0000010001c00c00010001000000560004ac4293f3c00c000100010000005600046814179a00002904d0000000000000",
  ),
  nonexistent: hex(
    "00008183000100000001000123746869732d646f6d61696e2d646f65732d6e6f742d65786973742d396633613763316203636f6d0000010001c0300006000100000384003d01610c67746c642d73657276657273036e657400056e73746c640c766572697369676e2d677273c0306af3a6b5000007080000038400093a80000003840000290200000000000000",
  ),
  quad9Blocked: hex(
    "000081030001000000000001076d616c77617265057769636172036f7267000001000100002904d0000000000006000f00020011",
  ),
  quad9Real: hex(
    "000081800001000200000001076d616c77617265057769636172036f72670000010001c00c0005000100000637001a0c77696361726d616c77617265076e6673686f737403636f6d00c02f00010001000006370004d05e74f60000290200000000000000",
  ),
}

/** A response of our own making, for the shapes no live name will give us. */
function message(
  name: string,
  {
    rcode = 0,
    addresses = [],
    authority = 0,
  }: {
    rcode?: number
    addresses?: string[]
    authority?: number
  },
): Uint8Array {
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
  for (const label of name.split(".")) {
    out.push(label.length, ...Buffer.from(label))
  }
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

type Reply = { status?: number; body?: Uint8Array } | Error

/** A transport that answers by resolver URL, in order, and remembers what was asked. */
function transport(replies: Record<string, Reply[]>) {
  const asked: { url: string; name: string; type: number }[] = []
  const send: DohTransport = async (url, query) => {
    const q = decodeQuery(query)
    asked.push({ url, ...q })
    const next = replies[url]?.shift()
    if (!next) throw new Error(`unexpected query to ${url}`)
    if (next instanceof Error) throw next
    return { status: next.status ?? 200, body: next.body ?? new Uint8Array() }
  }
  return { send, asked }
}

/** Reads back a query our encoder made. */
function decodeQuery(query: Uint8Array) {
  const labels: string[] = []
  let at = 12
  while (query[at] !== 0) {
    labels.push(Buffer.from(query.subarray(at + 1, at + 1 + query[at]!)).toString())
    at += 1 + query[at]!
  }
  return { name: labels.join("."), type: (query[at + 1]! << 8) | query[at + 2]! }
}

const NOW = new Date("2026-11-11T12:00:00Z")

function health() {
  const events: string[] = []
  const h: ProviderHealth = {
    async success(p) {
      events.push(`ok ${p}`)
    },
    async failure(p, reason) {
      events.push(`fail ${p}: ${reason}`)
    },
  }
  return { h, events }
}

function provider(
  resolver: Resolver,
  replies: Record<string, Reply[]>,
  over: { redis?: FakeRedis | null; dailyLimit?: number } = {},
) {
  const t = transport(replies)
  const redis = over.redis === null ? undefined : (over.redis ?? new FakeRedis())
  const probe = health()
  const p = dnsProvider(resolver, {
    ...(redis ? { redis } : {}),
    dailyLimit: over.dailyLimit ?? 100,
    transport: t.send,
    health: probe.h,
    now: () => NOW,
  })
  return { p, redis, asked: t.asked, events: probe.events }
}

const CF = CLOUDFLARE
const Q9 = QUAD9

describe("the DNS wire codec", () => {
  it("asks one A question with EDNS0, id 0", () => {
    expect(Buffer.from(encodeQuery("example.com", TYPE_A)).toString("hex")).toBe(
      "000001000001000000000001" + // id 0, RD, one question, one additional
        "076578616d706c6503636f6d00" +
        "00010001" + // A, IN
        "00002904d0000000000000", // OPT, 1232 bytes
    )
  })

  it("reads the live answers: Cloudflare's block is 0.0.0.0, Quad9's is a bare NXDOMAIN", () => {
    const cf = decodeMessage(REAL.cloudflareBlocked)
    expect(cf).toMatchObject({ rcode: 0, authority: 0 })
    expect(cf.answers).toEqual([{ type: 1, address: "0.0.0.0" }])
    expect(cf.question).toEqual({ name: "malware.wicar.org", type: 1 })

    const q9 = decodeMessage(REAL.quad9Blocked)
    expect(q9).toMatchObject({ rcode: 3, authority: 0, answers: [] })
  })

  it("reads a CNAME chain and the real address, and a nonexistent name's SOA", () => {
    expect(decodeMessage(REAL.cloudflareReal).answers).toEqual([
      { type: 5, address: null },
      { type: 1, address: "208.94.116.246" },
    ])
    expect(decodeMessage(REAL.nonexistent)).toMatchObject({ rcode: 3, authority: 1 })
    expect(decodeMessage(REAL.cloudflareClean).answers.map((a) => a.address)).toEqual([
      "172.66.147.243",
      "104.20.23.154",
    ])
  })

  it("refuses what is not a whole response", () => {
    expect(() => decodeMessage(new Uint8Array(5))).toThrow()
    expect(() => decodeMessage(encodeQuery("example.com", TYPE_A))).toThrow(
      /not a DNS response/,
    )
    expect(() => decodeMessage(REAL.cloudflareClean.subarray(0, 30))).toThrow()
    // a compression pointer that points at itself must end, not loop
    const loop = Uint8Array.from([
      0, 0, 0x81, 0x80, 0, 1, 0, 0, 0, 0, 0, 0, 0xc0, 12, 0, 1, 0, 1,
    ])
    expect(() => decodeMessage(loop)).toThrow()
  })
})

describe("which hostnames may be asked about", () => {
  it("accepts public names, lowercases them and drops a trailing dot", () => {
    expect(dnsLookupName("Example.COM.")).toBe("example.com")
    expect(dnsLookupName("a-b.c1.co.uk")).toBe("a-b.c1.co.uk")
    expect(dnsLookupName("xn--bcher-kva.de")).toBe("xn--bcher-kva.de")
    expect(dnsLookupName("foo.github.io")).toBe("foo.github.io")
  })

  it("refuses IP literals, single labels and names no one can resolve publicly", () => {
    for (const host of [
      "127.0.0.1",
      "10.0.0.5",
      "169.254.169.254",
      "[::1]",
      "::1",
      "localhost",
      "intranet",
      "printer.local",
      "db.internal",
      "foo.localhost",
      "a.invalid",
      "x.test",
      "1.0.0.127.in-addr.arpa",
      "host.home.arpa",
      "abcdefabcdef.onion",
      "co.uk",
    ])
      expect(dnsLookupName(host)).toBeNull()
  })

  it("refuses anything that is not letters, digits and hyphens in bounded labels", () => {
    for (const host of [
      "",
      " ",
      "a..com",
      ".com",
      "-a.com",
      "a-.com",
      "a b.com",
      "a_b.com",
      "bücher.de",
      "a.com/path",
      "a.com:80",
      "user@a.com",
      `${"a".repeat(64)}.com`,
      `${"a.".repeat(130)}com`,
      "a.com\r\nINJECT",
      "a.123",
    ])
      expect(dnsLookupName(host)).toBeNull()
  })

  it("asks nothing and spends nothing for a name it refuses", async () => {
    const { p, asked, redis } = provider(CF, {})
    expect((await p.lookup("10.0.0.1")).kind).toBe("skipped")
    expect((await p.lookup("printer.local")).kind).toBe("skipped")
    expect((await p.cached("localhost")).kind).toBe("skipped")
    expect(asked).toHaveLength(0)
    expect(redis!.kv.size).toBe(0)
  })
})

describe("Cloudflare's malware-blocking resolver", () => {
  const F = CF.filtered
  const U = CF.unfiltered

  it("calls a name blocked when 0.0.0.0 is the filtered answer and the real one is not", async () => {
    const { p, asked } = provider(CF, {
      [F]: [{ body: REAL.cloudflareBlocked }],
      [U]: [{ body: REAL.cloudflareReal }],
    })
    expect(await p.lookup("malware.wicar.org")).toEqual({
      kind: "unsafe",
      labels: ["blocked"],
    })
    expect(asked.map((a) => a.url)).toEqual([F, U])
    expect(asked.every((a) => a.name === "malware.wicar.org" && a.type === 1)).toBe(
      true,
    )
  })

  it("calls a name clean with a single question when the filtered answer is real", async () => {
    const { p, asked } = provider(CF, { [F]: [{ body: REAL.cloudflareClean }] })
    expect(await p.lookup("example.com")).toEqual({ kind: "clean" })
    expect(asked).toHaveLength(1)
  })

  it("never reads a nonexistent name as blocked", async () => {
    const { p, asked } = provider(CF, { [F]: [{ body: REAL.nonexistent }] })
    expect(await p.lookup("this-domain-does-not-exist-9f3a7c1b.com")).toEqual({
      kind: "clean",
    })
    expect(asked).toHaveLength(1)
  })

  it("does not call it a block when the zone itself publishes 0.0.0.0", async () => {
    const { p } = provider(CF, {
      [F]: [{ body: message("parked.example.com", { addresses: ["0.0.0.0"] }) }],
      [U]: [{ body: message("parked.example.com", { addresses: ["0.0.0.0"] }) }],
    })
    expect(await p.lookup("parked.example.com")).toEqual({ kind: "clean" })
  })

  it("cannot tell when the unfiltered resolver has no address, and says unknown", async () => {
    for (const unfiltered of [
      message("gone.example.com", { rcode: 3, authority: 1 }),
      message("gone.example.com", {}),
    ]) {
      const { p, redis } = provider(CF, {
        [F]: [{ body: message("gone.example.com", { addresses: ["0.0.0.0"] }) }],
        [U]: [{ body: unfiltered }],
      })
      expect(await p.lookup("gone.example.com")).toEqual({ kind: "unknown" })
      expect(redis!.ttl.get(dnsKeys("cloudflare").fail("gone.example.com"))).toBe(
        HOST_FAIL_SECONDS,
      )
    }
  })

  it("answers a mixed filtered answer as an ordinary name", async () => {
    const { p } = provider(CF, {
      [F]: [{ body: message("a.example.com", { addresses: ["0.0.0.0", "1.2.3.4"] }) }],
    })
    expect(await p.lookup("a.example.com")).toEqual({ kind: "clean" })
  })
})

describe("Quad9's malware-blocking resolver", () => {
  const F = Q9.filtered
  const U = Q9.unfiltered

  it("calls a bare NXDOMAIN blocked when the unfiltered resolver resolves the name", async () => {
    const { p, asked } = provider(Q9, {
      [F]: [{ body: REAL.quad9Blocked }],
      [U]: [{ body: REAL.quad9Real }],
    })
    expect(await p.lookup("malware.wicar.org")).toEqual({
      kind: "unsafe",
      labels: ["blocked"],
    })
    expect(asked.map((a) => a.url)).toEqual([F, U])
  })

  it("reads NXDOMAIN with the zone's SOA as a name that does not exist, with one question", async () => {
    const { p, asked } = provider(Q9, { [F]: [{ body: REAL.nonexistent }] })
    expect(await p.lookup("this-domain-does-not-exist-9f3a7c1b.com")).toEqual({
      kind: "clean",
    })
    expect(asked).toHaveLength(1)
  })

  it("says unknown, not blocked, when a bare NXDOMAIN is not backed by a real name", async () => {
    const { p } = provider(Q9, {
      [F]: [{ body: message("odd.example.com", { rcode: 3 }) }],
      [U]: [{ body: message("odd.example.com", { rcode: 3, authority: 1 }) }],
    })
    expect(await p.lookup("odd.example.com")).toEqual({ kind: "unknown" })
  })

  it("calls an ordinary answer clean", async () => {
    const { p } = provider(Q9, {
      [F]: [{ body: message("example.com", { addresses: ["1.2.3.4"] }) }],
    })
    expect(await p.lookup("example.com")).toEqual({ kind: "clean" })
  })
})

describe("when the resolver is the problem", () => {
  const F = CF.filtered

  it("treats an HTTP error, a timeout and a garbled answer as an outage, parks the resolver and reports it", async () => {
    for (const reply of [
      { status: 403 },
      { status: 500 },
      { status: 429 },
      { status: 505 },
      new Error("timeout"),
      { body: new Uint8Array([1, 2, 3]) },
      // an answer to some other question
      { body: message("other.example.com", { addresses: ["1.2.3.4"] }) },
    ] as Reply[]) {
      const { p, redis, events } = provider(CF, { [F]: [reply] })
      expect(await p.lookup("example.com")).toEqual({ kind: "unknown" })
      expect(redis!.ttl.get(dnsKeys("cloudflare").down)).toBe(300)
      expect(events.some((e) => e.startsWith("fail cloudflare"))).toBe(true)
      // parked: the next host does not even ask
      expect(await p.lookup("other.example.com")).toEqual({ kind: "unknown" })
    }
  })

  it("does not count the resolver down for one name that would not resolve (SERVFAIL)", async () => {
    const { p, redis, events } = provider(CF, {
      [F]: [
        { body: message("bogus.example.com", { rcode: 2 }) },
        { body: REAL.cloudflareClean },
      ],
    })
    expect(await p.lookup("bogus.example.com")).toEqual({ kind: "unknown" })
    expect(redis!.kv.has(dnsKeys("cloudflare").down)).toBe(false)
    expect(redis!.ttl.get(dnsKeys("cloudflare").fail("bogus.example.com"))).toBe(
      HOST_FAIL_SECONDS,
    )
    expect(events).toEqual(["ok cloudflare"])
    expect(await p.lookup("example.com")).toEqual({ kind: "clean" })
  })

  it("reports a success for every answered question", async () => {
    const { p, events } = provider(CF, { [F]: [{ body: REAL.cloudflareClean }] })
    await p.lookup("example.com")
    expect(events).toEqual(["ok cloudflare"])
  })
})

describe("caches, caps and concurrency", () => {
  const F = CF.filtered
  const U = CF.unfiltered

  it("looks a name up once, remembers which resolver said what, and ages clean sooner than blocked", async () => {
    const { p, asked, redis } = provider(CF, {
      [F]: [{ body: REAL.cloudflareBlocked }, { body: REAL.cloudflareClean }],
      [U]: [{ body: REAL.cloudflareReal }],
    })
    expect((await p.lookup("malware.wicar.org")).kind).toBe("unsafe")
    expect((await p.lookup("malware.wicar.org")).kind).toBe("unsafe")
    expect((await p.lookup("example.com")).kind).toBe("clean")
    expect((await p.lookup("example.com")).kind).toBe("clean")
    expect(asked).toHaveLength(3)
    const k = dnsKeys("cloudflare")
    expect(redis!.kv.get(k.verdict("malware.wicar.org"))).toBe("blocked")
    expect(redis!.ttl.get(k.verdict("malware.wicar.org"))).toBe(BLOCKED_SECONDS)
    expect(redis!.kv.get(k.verdict("example.com"))).toBe("clean")
    expect(redis!.ttl.get(k.verdict("example.com"))).toBe(CLEAN_SECONDS)
    expect(BLOCKED_SECONDS).toBeGreaterThan(CLEAN_SECONDS)
  })

  it("keeps the two resolvers' answers apart", async () => {
    const redis = new FakeRedis()
    const a = provider(
      CF,
      { [CF.filtered]: [{ body: REAL.cloudflareClean }] },
      { redis },
    )
    const b = provider(
      Q9,
      {
        [Q9.filtered]: [{ body: message("example.com", { rcode: 3 }) }],
        [Q9.unfiltered]: [{ body: message("example.com", { addresses: ["1.2.3.4"] }) }],
      },
      { redis },
    )
    await a.p.lookup("example.com")
    await b.p.lookup("example.com")
    expect(redis.kv.has("risk:link:cloudflare:example.com")).toBe(true)
    expect(redis.kv.get("risk:link:quad9:example.com")).toBe("blocked")
  })

  it("never calls out from `cached`", async () => {
    const { p, asked, redis } = provider(CF, {})
    expect((await p.cached("example.com")).kind).toBe("unknown")
    redis!.kv.set(dnsKeys("cloudflare").verdict("example.com"), "clean")
    expect((await p.cached("example.com")).kind).toBe("clean")
    expect(asked).toHaveLength(0)
  })

  it("counts every question against the day's cap before sending it, and stops at it", async () => {
    const { p, asked, redis } = provider(
      CF,
      {
        [F]: [{ body: REAL.cloudflareBlocked }, { body: REAL.cloudflareClean }],
        [U]: [{ body: REAL.cloudflareReal }],
      },
      { dailyLimit: 2 },
    )
    // a block takes two questions, and spends the whole day
    expect((await p.lookup("malware.wicar.org")).kind).toBe("unsafe")
    expect(await p.lookup("example.com")).toEqual({ kind: "unknown" })
    expect(asked).toHaveLength(2)
    expect(redis!.kv.get(dnsKeys("cloudflare").budget(NOW))).toBe("3")
    expect(dnsKeys("cloudflare").budget(NOW)).toBe(
      "risk:link:cloudflare:budget:2026-11-11",
    )
    // a cached verdict is still served past the cap: it costs nothing
    expect((await p.lookup("malware.wicar.org")).kind).toBe("unsafe")
    expect(asked).toHaveLength(2)
  })

  it("does not report an exhausted cap as the resolver failing", async () => {
    const { p, events } = provider(CF, {}, { dailyLimit: 0 })
    expect(await p.lookup("example.com")).toEqual({ kind: "unknown" })
    expect(events).toEqual([])
  })

  it("spends nothing without Redis, because it cannot count", async () => {
    const { p, asked } = provider(CF, {}, { redis: null })
    expect(await p.lookup("example.com")).toEqual({ kind: "unknown" })
    expect(asked).toHaveLength(0)
  })

  it("keeps at most `max` questions in flight", async () => {
    const limit = limiter(2)
    let active = 0
    let peak = 0
    const work = () =>
      limit(async () => {
        active++
        peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 5))
        active--
      })
    await Promise.all(Array.from({ length: 7 }, work))
    expect(peak).toBe(2)
  })
})

/** A throwaway check that the module's resolvers are the documented endpoints. */
describe("the resolvers", () => {
  it("are the operators' documented DoH endpoints, each with its unfiltered twin", () => {
    expect(CF.filtered).toBe("https://security.cloudflare-dns.com/dns-query")
    expect(CF.unfiltered).toBe("https://cloudflare-dns.com/dns-query")
    expect(Q9.filtered).toBe("https://dns.quad9.net/dns-query")
    expect(Q9.unfiltered).toBe("https://dns10.quad9.net/dns-query")
  })
})
