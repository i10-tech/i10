import { describe, expect, it } from "bun:test"
import { createApp } from "../src/app.js"
import {
  createAssetProxy,
  FETCHES_PER_HOST,
  FETCHES_PER_WORKSPACE,
  FONT_CAP,
  IMAGE_CAP,
  RATE_PREFIX,
  REQUESTS_PER_WORKSPACE,
} from "../src/templates/asset-proxy.js"
import {
  fixedWindow,
  SSO_RATE_PREFIX,
  type Counter,
} from "../src/identity/rate-limit.js"
import type { ConsoleDeps } from "../src/routes/console.js"
import type { Lookup } from "../src/webhooks/egress.js"

/**
 * The asset proxy behind the template thumbnails: it fetches whatever URL a
 * customer's email names, so each refusal here is a door that must stay shut.
 * No test touches the network: DNS and the fetch are both fakes.
 */

const TENANT = "11111111-1111-4111-8111-111111111111"
const OTHER_TENANT = "22222222-2222-4222-8222-222222222222"
const BEARER = { Authorization: "Bearer stub" }

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3]
const WOFF2 = [...Buffer.from("wOF2"), 0, 1, 0, 0, 0, 0, 0, 0, 9, 9]
const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>',
)

const bytes = (b: ArrayLike<number>) => new Uint8Array(b)

/** `host` resolves to the address in the table; anything else does not resolve. */
const hosts: Record<string, string> = {
  "cdn.example.com": "93.184.216.34",
  "fonts.example.com": "93.184.216.35",
  "internal.example.com": "10.0.0.5",
}
const lookup: Lookup = async (host) => {
  const address = hosts[host]
  if (!address) throw new Error("ENOTFOUND")
  return [{ address, family: 4 }]
}

type Reply = Response | (() => Response)

function harness(
  replies: Record<string, Reply>,
  options: { cacheBytes?: number; limiter?: ReturnType<typeof fixedWindow> } = {},
) {
  const calls: string[] = []
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const pinned = String(input)
    const host = (init?.headers as Record<string, string>).host
    const key = `${host}${new URL(pinned).pathname}`
    calls.push(`${new URL(pinned).hostname} ${key}`)
    const reply = replies[key]
    if (!reply) return new Response("nope", { status: 404 })
    return typeof reply === "function" ? reply() : reply.clone()
  }) as unknown as typeof fetch
  const proxy = createAssetProxy({ lookup, fetch: fakeFetch, ...options })
  const app = createApp({
    console: {
      sessions: {
        verify: async (req: Request) => ({
          status: "signed-in" as const,
          userId:
            req.headers.get("authorization") === "Bearer other" ? "user_2" : "user_1",
        }),
      },
      tenants: {
        resolve: async ({ userId }: { userId: string }) =>
          userId === "user_2" ? OTHER_TENANT : TENANT,
      },
      templateAssetProxy: proxy,
      marketing: {} as ConsoleDeps["marketing"],
      queries: {} as ConsoleDeps["queries"],
      usage: {} as ConsoleDeps["usage"],
      onboarding: {} as ConsoleDeps["onboarding"],
      profile: {} as ConsoleDeps["profile"],
      log: { error: () => {}, warn: () => {} },
    },
  })
  const get = (u: string, extra = "", headers: Record<string, string> = BEARER) =>
    app.request(`/console/template-assets/proxy?u=${encodeURIComponent(u)}${extra}`, {
      headers,
    })
  return { get, calls }
}

const ok = (b: ArrayLike<number> | Buffer, headers: Record<string, string> = {}) =>
  new Response(bytes(b), { headers })

describe("GET /console/template-assets/proxy", () => {
  it("is behind the console session", async () => {
    const { get, calls } = harness({})
    const res = await get("https://cdn.example.com/a.png", "", {})
    expect(res.status).toBe(401)
    expect(calls).toEqual([])
  })

  it("serves a PNG with the sniffed type and the locked-down headers", async () => {
    // The upstream lies about its type: the bytes decide.
    const { get } = harness({
      "cdn.example.com/a.png": ok(PNG, { "content-type": "text/html" }),
    })
    const res = await get("https://cdn.example.com/a.png")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("image/png")
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'")
    expect(res.headers.get("cache-control")).toBe("private, max-age=604800")
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual(PNG)
  })

  it("serves WOFF2 as a font", async () => {
    const { get } = harness({ "fonts.example.com/f.woff2": ok(WOFF2) })
    const res = await get("https://fonts.example.com/f.woff2")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("font/woff2")
  })

  it("connects to the vetted address, not the name", async () => {
    const { get, calls } = harness({ "cdn.example.com/a.png": ok(PNG) })
    await get("https://cdn.example.com/a.png")
    expect(calls).toEqual(["93.184.216.34 cdn.example.com/a.png"])
  })

  it("refuses a host that resolves to a private address", async () => {
    const { get, calls } = harness({ "internal.example.com/a.png": ok(PNG) })
    const res = await get("https://internal.example.com/a.png")
    expect(res.status).toBe(403)
    expect(calls).toEqual([])
  })

  it("refuses a private address literal", async () => {
    const { get, calls } = harness({})
    for (const u of [
      "http://127.0.0.1/a.png",
      "http://169.254.169.254/latest",
      "http://[::1]/a.png",
    ]) {
      expect((await get(u)).status).toBe(403)
    }
    expect(calls).toEqual([])
  })

  it("refuses a non-http scheme, credentials, a custom port and junk", async () => {
    const { get, calls } = harness({})
    for (const u of [
      "ftp://cdn.example.com/a.png",
      "file:///etc/passwd",
      "data:image/png;base64,AAAA",
      "https://user:pw@cdn.example.com/a.png",
      "https://cdn.example.com:8443/a.png",
      "not a url",
      "",
    ]) {
      expect((await get(u)).status).toBe(400)
    }
    expect(calls).toEqual([])
  })

  it("follows a redirect and re-vets the next hop", async () => {
    const { get, calls } = harness({
      "cdn.example.com/a.png": new Response(null, {
        status: 302,
        headers: { location: "https://fonts.example.com/b.png" },
      }),
      "fonts.example.com/b.png": ok(PNG),
    })
    const res = await get("https://cdn.example.com/a.png")
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(2)
  })

  it("refuses a redirect to a private address", async () => {
    const { get, calls } = harness({
      "cdn.example.com/a.png": new Response(null, {
        status: 302,
        headers: { location: "http://internal.example.com/secret.png" },
      }),
      "internal.example.com/secret.png": ok(PNG),
    })
    const res = await get("https://cdn.example.com/a.png")
    expect(res.status).toBe(403)
    expect(calls).toEqual(["93.184.216.34 cdn.example.com/a.png"])
  })

  it("refuses a redirect to a metadata literal and to a non-http scheme", async () => {
    for (const location of [
      "http://169.254.169.254/latest/meta-data",
      "file:///etc/passwd",
    ]) {
      const { get } = harness({
        "cdn.example.com/a.png": new Response(null, {
          status: 301,
          headers: { location },
        }),
      })
      expect((await get("https://cdn.example.com/a.png")).status).toBe(403)
    }
  })

  it("stops after three redirects", async () => {
    const hop = (n: number) =>
      new Response(null, {
        status: 302,
        headers: { location: `https://cdn.example.com/${n}.png` },
      })
    const { get, calls } = harness({
      "cdn.example.com/a.png": hop(1),
      "cdn.example.com/1.png": hop(2),
      "cdn.example.com/2.png": hop(3),
      "cdn.example.com/3.png": hop(4),
      "cdn.example.com/4.png": ok(PNG),
    })
    const res = await get("https://cdn.example.com/a.png")
    expect(res.status).toBe(502)
    expect(calls).toHaveLength(4)
  })

  it("refuses an image over the cap, while streaming", async () => {
    const big = new Uint8Array(IMAGE_CAP + 1)
    big.set(PNG)
    const { get } = harness({ "cdn.example.com/big.png": ok(big) })
    expect((await get("https://cdn.example.com/big.png")).status).toBe(413)
  })

  it("holds a font to the smaller cap", async () => {
    const big = new Uint8Array(FONT_CAP + 1)
    big.set(WOFF2)
    const { get } = harness({ "fonts.example.com/big.woff2": ok(big) })
    expect((await get("https://fonts.example.com/big.woff2")).status).toBe(413)
  })

  it("refuses SVG and other types whatever the header says", async () => {
    const { get } = harness({
      "cdn.example.com/a.svg": ok(SVG, { "content-type": "image/png" }),
      "cdn.example.com/page": ok(Buffer.from("<html>hello world</html>"), {
        "content-type": "image/png",
      }),
    })
    expect((await get("https://cdn.example.com/a.svg")).status).toBe(415)
    expect((await get("https://cdn.example.com/page")).status).toBe(415)
  })

  it("serves CSS only when asked for a stylesheet, and never an image as CSS", async () => {
    const css = Buffer.from("@font-face{font-family:A;src:url(a.woff2)}")
    const { get } = harness({
      "cdn.example.com/s.css": ok(css, { "content-type": "image/png" }),
      "cdn.example.com/a.png": ok(PNG),
    })
    expect((await get("https://cdn.example.com/s.css")).status).toBe(415)
    const res = await get("https://cdn.example.com/s.css", "&as=css")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("text/css; charset=utf-8")
    expect(await res.text()).toContain("@font-face")
    expect((await get("https://cdn.example.com/a.png", "&as=css")).status).toBe(415)
  })

  it("never echoes an upstream error body", async () => {
    const { get } = harness({
      "cdn.example.com/a.png": new Response("SECRET INTERNAL TRACE", { status: 500 }),
    })
    const res = await get("https://cdn.example.com/a.png")
    expect(res.status).toBe(502)
    expect(await res.text()).not.toContain("SECRET")
  })

  it("fetches an asset once however many ask", async () => {
    const { get, calls } = harness({ "cdn.example.com/a.png": ok(PNG) })
    await get("https://cdn.example.com/a.png")
    await get("https://cdn.example.com/a.png")
    expect(calls).toHaveLength(1)
  })

  it("evicts the oldest asset past its byte budget", async () => {
    const { get, calls } = harness(
      {
        "cdn.example.com/1.png": ok(PNG),
        "cdn.example.com/2.png": ok(PNG),
      },
      { cacheBytes: PNG.length },
    )
    await get("https://cdn.example.com/1.png")
    await get("https://cdn.example.com/2.png")
    await get("https://cdn.example.com/1.png")
    expect(calls).toHaveLength(3)
  })
})

/** A clock the tests move; the limiter and the proxy both read it. */
function clock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => void (t += ms) }
}

function recordingLimiter(now: () => number) {
  const inner = fixedWindow(null, now, RATE_PREFIX)
  const keys: string[] = []
  const take: typeof inner = async (key, limit) => {
    keys.push(key)
    return inner(key, limit)
  }
  return { take, keys }
}

/** A proxy over a fake network that serves a PNG for every path, on a fake clock. */
function direct(redirects: Record<string, string> = {}) {
  const c = clock()
  const rec = recordingLimiter(c.now)
  const upstream: string[] = []
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const host = (init?.headers as Record<string, string>).host
    const path = new URL(String(input)).pathname
    upstream.push(`${host}${path}`)
    const to = redirects[`${host}${path}`]
    if (to) return new Response(null, { status: 302, headers: { location: to } })
    return new Response(bytes(PNG))
  }) as unknown as typeof fetch
  const proxy = createAssetProxy({
    lookup,
    fetch: fakeFetch,
    now: c.now,
    limiter: rec.take,
  })
  return { proxy, clock: c, keys: rec.keys, upstream }
}

const unique = (host: string, i: number) => `https://${host}/${i}.png`

describe("the asset proxy's rate limits", () => {
  it("answers 429 with Retry-After past the per-workspace request cap", async () => {
    const c = clock(1_000_000 - (1_000_000 % 60_000)) // a window's start
    const limiter = fixedWindow(null, c.now, RATE_PREFIX)
    const { get } = harness({ "cdn.example.com/a.png": ok(PNG) }, { limiter })
    // Cache hits count: the same URL, REQUESTS_PER_WORKSPACE times.
    for (let i = 0; i < REQUESTS_PER_WORKSPACE.max; i++) {
      expect((await get("https://cdn.example.com/a.png")).status).toBe(200)
    }
    const res = await get("https://cdn.example.com/a.png")
    expect(res.status).toBe(429)
    expect(res.headers.get("Retry-After")).toBe("60")
    expect(res.headers.get("Cache-Control")).toBe("no-store")
    const body = (await res.json()) as { message: string }
    expect(body.message).toBe(
      "Too many template asset requests. Wait a moment and try again.",
    )
    // Another workspace is not affected.
    expect(
      (
        await get("https://cdn.example.com/a.png", "", {
          Authorization: "Bearer other",
        })
      ).status,
    ).toBe(200)
    c.advance(30_000)
    expect(
      (await get("https://cdn.example.com/a.png")).headers.get("Retry-After"),
    ).toBe("30")
  })

  it("counts cache hits toward the request cap but not the upstream caps", async () => {
    const { proxy, keys, upstream } = direct()
    await proxy.fetch(unique("cdn.example.com", 1), undefined, "w1")
    await proxy.fetch(unique("cdn.example.com", 1), undefined, "w1")
    await proxy.fetch(unique("cdn.example.com", 1), undefined, "w1")
    expect(upstream).toHaveLength(1)
    expect(keys.filter((k) => k === "requests:w1")).toHaveLength(3)
    expect(keys.filter((k) => k === "fetches:w1")).toHaveLength(1)
    expect(keys.filter((k) => k.startsWith("host:"))).toEqual(["host:cdn.example.com"])
  })

  it("does not charge a coalesced waiter for the fetch", async () => {
    const { proxy, keys, upstream } = direct()
    const url = unique("cdn.example.com", 7)
    await Promise.all([
      proxy.fetch(url, undefined, "w1"),
      proxy.fetch(url, undefined, "w1"),
      proxy.fetch(url, undefined, "w1"),
    ])
    expect(upstream).toHaveLength(1)
    expect(keys.filter((k) => k === "fetches:w1")).toHaveLength(1)
    expect(keys.filter((k) => k.startsWith("host:"))).toHaveLength(1)
  })

  it("caps a workspace's upstream fetches, and resets with the window", async () => {
    const { proxy, clock: c } = direct()
    for (let i = 0; i < FETCHES_PER_WORKSPACE.max; i++) {
      expect(
        (await proxy.fetch(unique("cdn.example.com", i), undefined, "w1")).ok,
      ).toBe(true)
    }
    const over = await proxy.fetch(unique("cdn.example.com", 9999), undefined, "w1")
    expect(over).toMatchObject({ ok: false, status: 429 })
    expect((over as { retryAfter: number }).retryAfter).toBeGreaterThanOrEqual(1)
    // A cached asset is still served: it costs no fetch.
    expect((await proxy.fetch(unique("cdn.example.com", 0), undefined, "w1")).ok).toBe(
      true,
    )
    // Another workspace still fetches.
    expect(
      (await proxy.fetch(unique("cdn.example.com", 9999), undefined, "w2")).ok,
    ).toBe(true)
    c.advance(60_000)
    expect(
      (await proxy.fetch(unique("cdn.example.com", 9999), undefined, "w1")).ok,
    ).toBe(true)
  })

  it("caps fetches to one host across workspaces", async () => {
    const { proxy, clock: c, upstream } = direct()
    const workspaces = ["w1", "w2", "w3"]
    let n = 0
    // 3 x 100 = 300 fetches, each workspace under its own 120 cap.
    for (const w of workspaces) {
      for (let i = 0; i < 100; i++) {
        expect(
          (await proxy.fetch(unique("cdn.example.com", n++), undefined, w)).ok,
        ).toBe(true)
      }
    }
    expect(upstream).toHaveLength(FETCHES_PER_HOST.max)
    expect(
      await proxy.fetch(unique("cdn.example.com", n++), undefined, "w1"),
    ).toMatchObject({
      ok: false,
      status: 429,
    })
    // A different host is a different budget.
    expect(
      (await proxy.fetch(unique("fonts.example.com", 1), undefined, "w1")).ok,
    ).toBe(true)
    c.advance(60_000)
    expect(
      (await proxy.fetch(unique("cdn.example.com", n++), undefined, "w1")).ok,
    ).toBe(true)
  })

  it("counts the host of every redirect hop", async () => {
    const { proxy, keys, upstream } = direct({
      "cdn.example.com/a.png": "https://fonts.example.com/b.png",
    })
    expect(
      (await proxy.fetch("https://cdn.example.com/a.png", undefined, "w1")).ok,
    ).toBe(true)
    expect(upstream).toEqual(["cdn.example.com/a.png", "fonts.example.com/b.png"])
    expect(keys.filter((k) => k.startsWith("host:"))).toEqual([
      "host:cdn.example.com",
      "host:fonts.example.com",
    ])
    // The workspace's fetch budget is charged once for the whole chain.
    expect(keys.filter((k) => k === "fetches:w1")).toHaveLength(1)
  })

  it("refuses a redirect hop whose host is out of budget", async () => {
    const { proxy } = direct({
      "cdn.example.com/a.png": "https://fonts.example.com/b.png",
    })
    for (let i = 0; i < FETCHES_PER_HOST.max; i++) {
      // Fill fonts.example.com's budget from other workspaces' direct fetches.
      await proxy.fetch(unique("fonts.example.com", i), undefined, `f${i % 4}`)
    }
    const res = await proxy.fetch("https://cdn.example.com/a.png", undefined, "w1")
    expect(res).toMatchObject({ ok: false, status: 429 })
  })
})

describe("fixedWindow's key prefix", () => {
  it("keeps the SSO keys by default and uses the given prefix otherwise", async () => {
    const seen: string[] = []
    const redis: Counter = {
      incr: async (key) => (seen.push(key), 1),
      expire: async () => 1,
    }
    const limit = { max: 1, windowSeconds: 60 }
    await fixedWindow(redis, () => 120_000)("ip:1.2.3.4", limit)
    await fixedWindow(redis, () => 120_000, RATE_PREFIX)("requests:w", limit)
    expect(SSO_RATE_PREFIX).toBe("sso:rate:")
    expect(seen).toEqual(["sso:rate:ip:1.2.3.4:2", "template-assets:rate:requests:w:2"])
  })
})
