import { describe, expect, it } from "bun:test"
import { harness, MemoryCache, type Seen } from "./helpers.js"

const AUTH = "https://auth.i10.tech"
const DASH = "https://dash.i10.tech"
const ENV_PATH =
  "/v1/environment?__clerk_api_version=2025-11-10&_clerk_js_version=6.46.2"
const FLOATING = "/npm/@clerk/clerk-js@6/dist/clerk.browser.js"
const EXACT = "/npm/@clerk/clerk-js@6.46.2/dist/clerk.browser.js"
const MINUTE = 60_000

/** Clerk's environment answer, shaped like the live one (2026-11-20). */
function environment(seen: Seen): Response {
  const headers = new Headers({
    "content-type": "application/json",
    "cache-control": "no-store",
    expires: "0",
    pragma: "no-cache",
    vary: "Origin",
    "x-country": "EG",
    "access-control-allow-credentials": "true",
  })
  const origin = seen.headers.get("origin")
  if (origin) headers.set("access-control-allow-origin", origin)
  headers.append(
    "set-cookie",
    "__client_uat=1795205025; Path=/; Domain=i10.tech; Secure",
  )
  headers.append("set-cookie", "__cf_bm=abc; Path=/; Domain=frontend-api.clerk.dev")
  return new Response(JSON.stringify({ auth_config: { id: "aac_1" } }), { headers })
}

function redirect(seen: Seen): Response {
  return new Response(null, {
    status: 307,
    headers: {
      location: seen.url.replace(/@6\//, "@6.46.2/"),
      "cache-control": "private, max-age=0, no-store, no-cache, must-revalidate",
      "set-cookie": "__cf_bm=abc; Path=/; Domain=frontend-api.clerk.dev",
    },
  })
}

function bundle(
  cacheControl = "public, max-age=31536000, s-maxage=31536000, immutable",
) {
  return () =>
    new Response("console.log('clerk')", {
      headers: {
        "content-type": "application/javascript; charset=utf-8",
        "content-encoding": "br",
        "cache-control": cacheControl,
        vary: "Accept-Encoding",
      },
    })
}

/** Send, then let the deferred cache write finish, as `waitUntil` would. */
async function sendSettled(
  gw: ReturnType<typeof harness>,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const res = await gw.send(path, init)
  const text = await res.text()
  await gw.settle()
  return new Response(res.status === 204 || res.status === 307 ? null : text, res)
}

const from = (origin: string, extra: Record<string, string> = {}): RequestInit => ({
  headers: { origin, "accept-encoding": "gzip, br", ...extra },
})

describe("the floating-version redirect", () => {
  it("is answered from the cache, Location rewritten, Cache-Control as Clerk sent it", async () => {
    const gw = harness({ upstream: redirect })
    const miss = await sendSettled(gw, FLOATING)
    const hit = await sendSettled(gw, FLOATING)
    expect(gw.calls).toHaveLength(1)
    expect(miss.headers.get("x-clerk-gateway-cache")).toBe("miss")
    expect(hit.headers.get("x-clerk-gateway-cache")).toBe("hit")
    for (const res of [miss, hit]) {
      expect(res.status).toBe(307)
      expect(res.headers.get("location")).toBe(
        "https://clerk.i10.tech/npm/@clerk/clerk-js@6.46.2/dist/clerk.browser.js",
      )
      expect(res.headers.get("cache-control")).toStartWith(
        "private, max-age=0, no-store",
      )
    }
    expect(hit.headers.get("set-cookie")).toBeNull()
  })

  it("asks Clerk again after five minutes", async () => {
    const gw = harness({ upstream: redirect })
    await sendSettled(gw, FLOATING)
    gw.clock.now = 5 * MINUTE - 1
    await sendSettled(gw, FLOATING)
    expect(gw.calls).toHaveLength(1)
    gw.clock.now = 5 * MINUTE
    await sendSettled(gw, FLOATING)
    expect(gw.calls).toHaveLength(2)
  })

  it("never stands in for Clerk when Clerk fails", async () => {
    let up = true
    const gw = harness({
      upstream: (seen) => {
        if (!up) throw new Error("unreachable")
        return redirect(seen)
      },
    })
    await sendSettled(gw, FLOATING)
    gw.clock.now = 5 * MINUTE
    up = false
    const res = await sendSettled(gw, FLOATING)
    expect(res.status).toBe(503)
    expect(res.headers.get("x-clerk-gateway")).toBe("unavailable")
  })

  it("is shared by both of the Worker's names", async () => {
    const cache = new MemoryCache()
    const env = { PROXY_URL: "https://i10.tech/__clerk" }
    const gw = harness({ env, cache, upstream: redirect })
    await gw.sendRaw(new Request(`https://i10.tech/__clerk${FLOATING}`))
    await gw.settle()
    const hit = await gw.sendRaw(new Request(`https://clerk.i10.tech${FLOATING}`))
    expect(gw.calls).toHaveLength(1)
    expect(hit.headers.get("x-clerk-gateway-cache")).toBe("hit")
    expect([...cache.entries.keys()]).toEqual([
      `https://i10.tech/__clerk/__gateway_cache/v1/redirect${FLOATING}`,
    ])
  })
})

describe("the exact-version bundle", () => {
  it("is kept for as long as Clerk says when Clerk marks it public and immutable", async () => {
    const gw = harness({ upstream: bundle("public, max-age=600, immutable") })
    await sendSettled(gw, EXACT, from(AUTH))
    gw.clock.now = 10 * MINUTE - 1
    const hit = await sendSettled(gw, EXACT, from(AUTH))
    expect(gw.calls).toHaveLength(1)
    expect(await hit.text()).toBe("console.log('clerk')")
    expect(hit.headers.get("cache-control")).toBe("public, max-age=600, immutable")
    gw.clock.now = 10 * MINUTE
    await sendSettled(gw, EXACT, from(AUTH))
    expect(gw.calls).toHaveLength(2)
  })

  it("is never stored unless it is a 200 that Clerk marked public and immutable", async () => {
    const answers: [string, () => Response][] = [
      ["not immutable", bundle("public, max-age=600")],
      ["not public", bundle("max-age=600, immutable")],
      ["private", bundle("public, private, max-age=600, immutable")],
      ["no max-age", bundle("public, immutable")],
      [
        "a 404",
        () =>
          new Response("not found", {
            status: 404,
            headers: { "cache-control": "public, max-age=600, immutable" },
          }),
      ],
    ]
    for (const [, upstream] of answers) {
      const gw = harness({ upstream })
      await sendSettled(gw, EXACT, from(AUTH))
      await sendSettled(gw, EXACT, from(AUTH))
      expect(gw.cache.entries.size).toBe(0)
      expect(gw.calls).toHaveLength(2)
    }
  })

  it("stores one decoded copy and encodes a hit only for a client that accepts it", async () => {
    const gw = harness({ upstream: bundle() })
    await sendSettled(gw, EXACT, from(AUTH))
    const [stored] = gw.cache.entries.values()
    expect(stored?.headers.get("content-encoding")).toBeNull()
    expect(stored?.headers.get("vary")).toBeNull()

    const brotli = await sendSettled(gw, EXACT, from(AUTH))
    expect(brotli.headers.get("content-encoding")).toBe("br")
    expect(brotli.headers.get("vary")).toBe("Accept-Encoding")
    for (const accept of ["gzip", "br;q=0", ""]) {
      const plain = await sendSettled(
        gw,
        EXACT,
        from(AUTH, { "accept-encoding": accept }),
      )
      expect(plain.headers.get("x-clerk-gateway-cache")).toBe("hit")
      expect(plain.headers.get("content-encoding")).toBeNull()
      expect(await plain.text()).toBe("console.log('clerk')")
    }
    expect(gw.calls).toHaveLength(1)
  })
})

describe("the environment", () => {
  it("is answered from the cache for sixty seconds", async () => {
    const gw = harness({ upstream: environment })
    await sendSettled(gw, ENV_PATH, from(AUTH))
    gw.clock.now = MINUTE - 1
    const hit = await sendSettled(gw, ENV_PATH, from(AUTH))
    expect(gw.calls).toHaveLength(1)
    expect(await hit.json()).toEqual({ auth_config: { id: "aac_1" } })
    expect(hit.headers.get("cache-control")).toBe("no-store")
    gw.clock.now = MINUTE
    const again = await sendSettled(gw, ENV_PATH, from(AUTH))
    expect(gw.calls).toHaveLength(2)
    expect(again.headers.get("x-clerk-gateway-cache")).toBe("miss")
  })

  it("keeps each Origin's CORS answer apart", async () => {
    const gw = harness({ upstream: environment })
    await sendSettled(gw, ENV_PATH, from(AUTH))
    await sendSettled(gw, ENV_PATH, from(DASH))
    const auth = await sendSettled(gw, ENV_PATH, from(AUTH))
    const dash = await sendSettled(gw, ENV_PATH, from(DASH))
    expect(gw.calls).toHaveLength(2)
    expect(auth.headers.get("access-control-allow-origin")).toBe(AUTH)
    expect(dash.headers.get("access-control-allow-origin")).toBe(DASH)
  })

  it("keeps each query string apart", async () => {
    const gw = harness({ upstream: environment })
    await sendSettled(gw, ENV_PATH, from(AUTH))
    await sendSettled(gw, ENV_PATH.replace("6.46.2", "6.47.0"), from(AUTH))
    expect(gw.calls).toHaveLength(2)
    expect(gw.calls[1]?.url).toContain("_clerk_js_version=6.47.0")
  })

  it("caches a read with no Origin, the apps' server-side one", async () => {
    const gw = harness({ upstream: environment })
    await sendSettled(gw, ENV_PATH)
    const hit = await sendSettled(gw, ENV_PATH)
    expect(gw.calls).toHaveLength(1)
    expect(hit.headers.get("access-control-allow-origin")).toBeNull()
  })

  it("never caches for an origin that is not ours, or with Authorization", async () => {
    for (const init of [
      from("https://evil.example"),
      from(AUTH, { authorization: "Bearer x" }),
    ]) {
      const gw = harness({ upstream: environment })
      await sendSettled(gw, ENV_PATH, init)
      await sendSettled(gw, ENV_PATH, init)
      expect(gw.calls).toHaveLength(2)
      expect(gw.cache.entries.size).toBe(0)
    }
  })

  it("never stores a Set-Cookie or the requester's country, and still sends a miss's own", async () => {
    const gw = harness({ upstream: environment })
    const miss = await sendSettled(gw, ENV_PATH, from(AUTH))
    expect(miss.headers.getSetCookie()).toHaveLength(2)
    expect(miss.headers.get("x-country")).toBe("EG")

    const [stored] = gw.cache.entries.values()
    expect(stored?.headers.get("set-cookie")).toBeNull()
    expect(stored?.headers.get("x-country")).toBeNull()

    const hit = await sendSettled(gw, ENV_PATH, from(AUTH))
    expect(hit.headers.getSetCookie()).toEqual([])
    expect(hit.headers.get("x-country")).toBeNull()
  })

  it("never stores anything but a 200", async () => {
    const gw = harness({
      upstream: () => new Response('{"errors":[]}', { status: 429 }),
    })
    await sendSettled(gw, ENV_PATH, from(AUTH))
    expect(gw.cache.entries.size).toBe(0)
  })
})

describe("stale if Clerk fails", () => {
  type Mode = "up" | "throw" | "5xx"

  function flaky() {
    const state: { mode: Mode } = { mode: "up" }
    const gw = harness({
      upstream: (seen) => {
        if (state.mode === "throw") throw new Error("unreachable")
        if (state.mode === "5xx") return new Response("bad gateway", { status: 502 })
        return environment(seen)
      },
    })
    return { gw, state }
  }

  it("serves the last good environment when Clerk is unreachable or answers 5xx", async () => {
    for (const mode of ["throw", "5xx"] as const) {
      const { gw, state } = flaky()
      await sendSettled(gw, ENV_PATH, from(AUTH))
      gw.clock.now = 5 * MINUTE
      state.mode = mode
      const res = await sendSettled(gw, ENV_PATH, from(AUTH))
      expect(res.status).toBe(200)
      expect(res.headers.get("x-clerk-gateway-cache")).toBe("stale")
      expect(res.headers.get("access-control-allow-origin")).toBe(AUTH)
      expect(await res.json()).toEqual({ auth_config: { id: "aac_1" } })
      expect(gw.lastLog()).toMatchObject({
        decision: "pass",
        cache: "stale",
        reason: mode === "throw" ? "upstream_unreachable" : "upstream_5xx",
      })
    }
  })

  it("falls back to the outage rule once the copy is past ten minutes stale", async () => {
    const { gw, state } = flaky()
    await sendSettled(gw, ENV_PATH, from(AUTH))
    state.mode = "throw"
    gw.clock.now = MINUTE + 10 * MINUTE - 1
    expect((await sendSettled(gw, ENV_PATH, from(AUTH))).status).toBe(200)
    gw.clock.now = MINUTE + 10 * MINUTE
    const res = await sendSettled(gw, ENV_PATH, from(AUTH))
    expect(res.status).toBe(503)
    expect(res.headers.get("x-clerk-gateway")).toBe("unavailable")
  })

  it("passes Clerk's 5xx through when there is no copy", async () => {
    const { gw, state } = flaky()
    state.mode = "5xx"
    const res = await sendSettled(gw, ENV_PATH, from(AUTH))
    expect(res.status).toBe(502)
    expect(gw.cache.entries.size).toBe(0)
  })
})

describe("what the cache never sees", () => {
  it("denied routes never read or fill it", async () => {
    const gw = harness()
    const res = await sendSettled(gw, "/v1/organizations", { method: "POST" })
    await sendSettled(gw, "/v1/environment/../organizations")
    expect(res.headers.get("x-clerk-gateway")).toBe("denied")
    expect(gw.cache.matches).toEqual([])
    expect(gw.cache.entries.size).toBe(0)
  })

  it("allowed routes it does not cover go to Clerk without it", async () => {
    const gw = harness()
    const res = await sendSettled(
      gw,
      "/v1/client?__clerk_api_version=2025-11-10",
      from(AUTH),
    )
    expect(res.headers.get("x-clerk-gateway-cache")).toBeNull()
    expect(gw.lastLog().cache).toBeUndefined()
    expect(gw.cache.matches).toEqual([])
  })

  it("a cache that fails is a miss, never an error", async () => {
    const cache = new MemoryCache()
    cache.match = () => Promise.reject(new Error("cache down"))
    cache.put = () => Promise.reject(new Error("cache down"))
    const gw = harness({ cache, upstream: environment })
    const res = await sendSettled(gw, ENV_PATH, from(AUTH))
    expect(res.status).toBe(200)
    expect(gw.lastLog()).toMatchObject({ cache: "miss", upstream_status: 200 })
  })
})
