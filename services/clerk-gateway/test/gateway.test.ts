import { describe, expect, it, spyOn } from "bun:test"
import { handle } from "../src/gateway.js"
import type { ManagedAccounts } from "../src/managed.js"
import { ENV, harness, SECRET, SESSION } from "./helpers.js"

const BROWSER = {
  "cf-connecting-ip": "203.0.113.7",
  "cf-ray": "8d1f2a3b4c5d6e7f-PMO",
  origin: "https://dash.i10.tech",
}

const formPost = (body: string, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    ...BROWSER,
    ...headers,
  },
  body,
})

describe("forwarding", () => {
  it("adds Clerk's proxy headers and the real client IP, first and only", async () => {
    const gw = harness()
    await gw.send(
      `/v1/client/sessions/${SESSION}/tokens?__clerk_api_version=2026-05-12`,
      {
        ...formPost("organization_id=", {
          "x-forwarded-for": "6.6.6.6, 7.7.7.7",
          "x-real-ip": "6.6.6.6",
          forwarded: "for=6.6.6.6",
          "clerk-secret-key": "sk_live_attacker",
          "clerk-proxy-url": "https://evil.example",
          cookie: "__client=abc",
        }),
      },
    )
    expect(gw.calls).toHaveLength(1)
    const [call] = gw.calls
    expect(call?.url).toBe(
      `https://frontend-api.clerk.dev/v1/client/sessions/${SESSION}/tokens?__clerk_api_version=2026-05-12`,
    )
    const h = call!.headers
    expect(h.get("clerk-proxy-url")).toBe("https://clerk.i10.tech")
    expect(h.get("clerk-secret-key")).toBe(SECRET)
    expect(h.get("x-forwarded-for")).toBe("203.0.113.7")
    expect(h.get("x-forwarded-host")).toBe("clerk.i10.tech")
    expect(h.get("x-forwarded-proto")).toBe("https")
    expect(h.get("x-real-ip")).toBeNull()
    expect(h.get("forwarded")).toBeNull()
    expect(h.get("cf-connecting-ip")).toBeNull()
    expect(h.get("cf-ray")).toBeNull()
    // The browser's own headers are Clerk's business and go through.
    expect(h.get("cookie")).toBe("__client=abc")
    expect(h.get("origin")).toBe("https://dash.i10.tech")
    expect(call?.init.method).toBe("POST")
    expect(call?.init.redirect).toBe("manual")
    expect(call?.body).toBe("organization_id=")
  })

  it("sends no X-Forwarded-For at all without CF-Connecting-IP", async () => {
    const gw = harness()
    await gw.send("/v1/environment", { headers: { "x-forwarded-for": "6.6.6.6" } })
    expect(gw.calls[0]?.headers.get("x-forwarded-for")).toBeNull()
  })

  it("drops a malformed CF-Connecting-IP rather than extending the chain", async () => {
    const gw = harness()
    await gw.send("/v1/environment", {
      headers: { "cf-connecting-ip": "1.2.3.4, 6.6.6.6" },
    })
    expect(gw.calls[0]?.headers.get("x-forwarded-for")).toBeNull()
  })

  it("keeps the method and the override exactly as clerk-js sent them", async () => {
    const gw = harness()
    await gw.send(
      `/v1/me?_method=PATCH&_clerk_session_id=${SESSION}`,
      formPost("first_name=Ada"),
    )
    expect(gw.calls[0]?.init.method).toBe("POST")
    expect(gw.calls[0]?.url).toEndWith(
      `/v1/me?_method=PATCH&_clerk_session_id=${SESSION}`,
    )
    expect(gw.calls[0]?.body).toBe("first_name=Ada")
  })

  it("streams an upload untouched", async () => {
    const gw = harness()
    const data = new FormData()
    data.append("file", new Blob(["\x89PNG..."], { type: "image/png" }), "me.png")
    const req = new Request(
      `https://clerk.i10.tech/v1/me/profile_image?_clerk_session_id=${SESSION}`,
      { method: "POST", body: data },
    )
    const res = await gw.sendRaw(req)
    expect(res.status).toBe(200)
    expect(gw.calls[0]?.body).toContain("\x89PNG...")
    expect(gw.calls[0]?.headers.get("content-type")).toStartWith("multipart/form-data")
  })

  it("strips hop-by-hop headers both ways", async () => {
    const gw = harness({
      upstream: () =>
        new Response("{}", {
          headers: {
            connection: "x-hop",
            "x-hop": "1",
            "keep-alive": "5",
            "x-keep": "yes",
          },
        }),
    })
    const res = await gw.send("/v1/environment", {
      headers: { connection: "x-client-hop", "x-client-hop": "1", te: "trailers" },
    })
    const sent = gw.calls[0]!.headers
    expect(sent.get("x-client-hop")).toBeNull()
    expect(sent.get("te")).toBeNull()
    expect(res.headers.get("x-hop")).toBeNull()
    expect(res.headers.get("keep-alive")).toBeNull()
    expect(res.headers.get("x-keep")).toBe("yes")
  })
})

describe("responses", () => {
  it("passes every Set-Cookie through separately", async () => {
    const cookies = [
      "__client=abc; Domain=clerk.i10.tech; Path=/; HttpOnly; Secure; SameSite=Lax",
      "__client_uat=1700000000; Domain=.i10.tech; Path=/; Secure; SameSite=Lax",
      "__client_uat_Xyz=1700000000; Domain=.i10.tech; Path=/; Secure; SameSite=Lax",
    ]
    const gw = harness({
      upstream: () => {
        const headers = new Headers({ "content-type": "application/json" })
        for (const c of cookies) headers.append("set-cookie", c)
        return new Response('{"response":{}}', { status: 200, headers })
      },
    })
    const res = await gw.send(
      "/v1/client/sign_ins",
      formPost("strategy=ticket&ticket=t0p.s3cret"),
    )
    expect(res.headers.getSetCookie()).toEqual(cookies)
    expect(await res.text()).toBe('{"response":{}}')
  })

  it("passes redirects through without following them", async () => {
    const target = "https://dash.i10.tech/?__clerk_handshake_nonce=n"
    const gw = harness({
      upstream: () =>
        new Response(null, {
          status: 307,
          headers: { location: target, "set-cookie": "__session=x; Path=/" },
        }),
    })
    const res = await gw.send(
      "/v1/client/handshake?redirect_url=https%3A%2F%2Fdash.i10.tech%2F&__clerk_session=jwt",
    )
    expect(res.status).toBe(307)
    expect(res.headers.get("location")).toBe(target)
    expect(res.headers.getSetCookie()).toEqual(["__session=x; Path=/"])
  })

  it("rewrites only a Location that points back at the FAPI origin", async () => {
    const gw = harness({
      upstream: () =>
        new Response(null, {
          status: 303,
          headers: {
            location: "https://frontend-api.clerk.dev/v1/client/touch?redirect_url=x",
          },
        }),
    })
    const res = await gw.send("/v1/oauth_callback?code=c&state=s")
    expect(res.headers.get("location")).toBe(
      "https://clerk.i10.tech/v1/client/touch?redirect_url=x",
    )
  })

  it("passes Clerk's own errors through, 5xx included", async () => {
    for (const status of [400, 401, 422, 429, 500, 502, 503]) {
      const gw = harness({
        upstream: () => new Response(`{"errors":[{"code":"c${status}"}]}`, { status }),
      })
      const res = await gw.send("/v1/environment")
      expect(res.status).toBe(status)
      expect(await res.text()).toBe(`{"errors":[{"code":"c${status}"}]}`)
      expect(res.headers.get("x-clerk-gateway")).toBeNull()
    }
  })
})

describe("refusals", () => {
  it.each([
    ["POST", "/v1/organizations"],
    ["POST", "/v1/organizations/org_2abc/invitations"],
    ["POST", `/v1/me?_method=DELETE&_clerk_session_id=${SESSION}`],
    ["GET", "/v1/organizations/org_2abc/roles"],
    ["POST", "/v1/dev_browser"],
    ["GET", "/v1/nothing-here"],
  ])("%s %s is a 404 that never reaches Clerk", async (method, path) => {
    const gw = harness()
    const res = await gw.send(
      path,
      method === "GET" ? { headers: BROWSER } : formPost("a=b"),
    )
    expect(res.status).toBe(404)
    expect(gw.calls).toHaveLength(0)
    expect(await res.json()).toMatchObject({ errors: [{ code: "resource_not_found" }] })
    expect(res.headers.get("x-clerk-gateway")).toBe("denied")
    // Readable by our own pages, so clerk-js sees a 404 and not a network error.
    expect(res.headers.get("access-control-allow-origin")).toBe("https://dash.i10.tech")
    expect(res.headers.get("access-control-allow-credentials")).toBe("true")
  })

  it("normalises nothing it forwards: a resolved dot segment is matched as resolved", async () => {
    // The WHATWG parser (and the Workers runtime) resolve this before we see it.
    const gw = harness()
    const res = await gw.send("/v1/client/../organizations", formPost("name=x"))
    expect(res.status).toBe(404)
    expect(gw.calls).toHaveLength(0)
    expect(gw.lastLog()).toMatchObject({ reason: "org_create_via_api" })
  })

  it("refuses an encoded slash before it can be decoded upstream", async () => {
    const gw = harness()
    const res = await gw.send("/v1/client%2F..%2Forganizations", formPost("name=x"))
    expect(res.status).toBe(404)
    expect(gw.calls).toHaveLength(0)
    expect(gw.lastLog()).toMatchObject({ reason: "encoded_path" })
  })

  it("gives no CORS to an origin that is not ours", async () => {
    const gw = harness()
    const res = await gw.send(
      "/v1/organizations",
      formPost("a=b", { origin: "https://evil.example" }),
    )
    expect(res.headers.get("access-control-allow-origin")).toBeNull()
  })

  it("answers a managed sign-in in Clerk's error shape, never 401", async () => {
    const managed: ManagedAccounts = {
      byIdentifier: async () => true,
      bySession: async () => true,
    }
    const gw = harness({ managed })
    const signIn = await gw.send(
      "/v1/client/sign_ins",
      formPost("identifier=ada%40corp.example"),
    )
    expect(signIn.status).toBe(422)
    expect(signIn.headers.get("x-clerk-gateway")).toBe("managed")
    expect(await signIn.json()).toMatchObject({
      errors: [{ code: "sso_required", meta: { param_name: "identifier" } }],
    })
    const self = await gw.send(
      `/v1/me/change_password?_clerk_session_id=${SESSION}`,
      formPost("new_password=x"),
    )
    expect(self.status).toBe(403)
    expect(await self.json()).toMatchObject({ errors: [{ code: "managed_account" }] })
    const ticket = await gw.send(
      "/v1/client/sign_ins",
      formPost("strategy=ticket&ticket=t"),
    )
    expect(ticket.status).toBe(200)
    expect(gw.calls).toHaveLength(1)
  })

  it("refuses a form too large to inspect", async () => {
    const gw = harness()
    const res = await gw.send(
      "/v1/client/sign_ins",
      formPost(`a=${"x".repeat(70_000)}`),
    )
    expect(res.status).toBe(404)
    expect(gw.lastLog()).toMatchObject({ reason: "body_too_large" })
    expect(gw.calls).toHaveLength(0)
  })
})

describe("the outage rule", () => {
  it("answers 503 with Retry-After when Clerk cannot be reached", async () => {
    const gw = harness({
      upstream: () => {
        throw new TypeError("fetch failed")
      },
    })
    const res = await gw.send(`/v1/client/sessions/${SESSION}/tokens`, formPost(""))
    expect(res.status).toBe(503)
    expect(res.headers.get("retry-after")).toBe("5")
    expect(res.headers.get("x-clerk-gateway")).toBe("unavailable")
    expect(res.headers.get("access-control-allow-origin")).toBe("https://dash.i10.tech")
    expect(await res.json()).toMatchObject({
      errors: [{ code: "service_unavailable" }],
    })
    expect(gw.lastLog()).toMatchObject({
      decision: "unavailable",
      reason: "upstream_unreachable",
      status: 503,
      upstream_status: null,
    })
  })

  it("answers 503 when Clerk does not answer in time", async () => {
    const gw = harness({
      env: { UPSTREAM_TIMEOUT_MS: "100" },
      upstream: (seen) =>
        new Promise((_, reject) => {
          seen.init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          )
        }),
    })
    const res = await gw.send(`/v1/client/sessions/${SESSION}/tokens`, formPost(""))
    expect(res.status).toBe(503)
    expect(gw.lastLog()).toMatchObject({ reason: "upstream_timeout" })
  })

  it("answers 503 for everything when it is not configured", async () => {
    for (const env of [
      { CLERK_SECRET_KEY: undefined },
      { CLERK_SECRET_KEY: "sk_test_devkey" },
      { UPSTREAM_ORIGIN: "https://frontend-api.clerk.dev/v1" },
      { PROXY_URL: "not a url" },
      { INSTANCE: "staging" },
    ]) {
      const gw = harness({ env })
      const res = await gw.send("/v1/environment")
      expect(res.status).toBe(503)
      expect(gw.calls).toHaveLength(0)
      expect(gw.lastLog()).toMatchObject({ reason: "not_configured" })
    }
  })
})

describe("logging", () => {
  it("writes one line per request with the agreed fields", async () => {
    const gw = harness({ upstream: () => new Response("{}", { status: 201 }) })
    await gw.send(
      `/v1/client/sessions/${SESSION}/touch`,
      formPost("active_organization_id="),
    )
    expect(gw.logs).toHaveLength(1)
    expect(gw.lastLog()).toEqual({
      msg: "clerk-gateway",
      method: "POST",
      route: "session.touch",
      decision: "pass",
      reason: null,
      status: 201,
      upstream_status: 201,
      duration_ms: 0,
      ip: "203.0.113.7",
      ray: "8d1f2a3b4c5d6e7f-PMO",
    })
  })

  it("never writes a cookie, token, ticket, password or the secret", async () => {
    const secrets = [
      SECRET,
      "__client=c00kie-value",
      "c00kie-value",
      "Bearer eyJhbGciOi.jwt-in-header",
      "jwt-in-header",
      "dvb_devbrowser-token",
      "t1cket-value",
      "pa55word-value",
      "hs-session-jwt",
    ]
    const gw = harness({
      upstream: () =>
        new Response("{}", {
          headers: { "set-cookie": "__client=c00kie-value; Path=/" },
        }),
    })
    const headers = {
      cookie: "__client=c00kie-value",
      authorization: "Bearer eyJhbGciOi.jwt-in-header",
    }
    await gw.send(
      "/v1/client/sign_ins?__clerk_db_jwt=dvb_devbrowser-token",
      formPost("strategy=ticket&ticket=t1cket-value", headers),
    )
    await gw.send(
      "/v1/client/sign_ins?__clerk_db_jwt=dvb_devbrowser-token",
      formPost("identifier=a%40b.co&password=pa55word-value", headers),
    )
    await gw.send("/v1/client/handshake?__clerk_session=hs-session-jwt", { headers })
    // Refused requests log a path; never the query.
    await gw.send(
      "/v1/organizations?__clerk_db_jwt=dvb_devbrowser-token",
      formPost("a=b"),
    )
    // And a failing upstream does not leak its error.
    const failing = harness({
      upstream: () => {
        throw new Error(`boom ${SECRET}`)
      },
    })
    await failing.send(`/v1/client/sessions/${SESSION}/tokens`, formPost("", headers))
    const all = [...gw.logs, ...failing.logs].join("\n")
    for (const secret of secrets) expect(all).not.toContain(secret)
  })
})

describe("the Worker entry", () => {
  it("is wired to the same handler", async () => {
    const worker = (await import("../src/index.js")).default
    const printed: string[] = []
    const spy = spyOn(console, "log").mockImplementation((line: string) => {
      printed.push(line)
    })
    const res = await worker.fetch(
      new Request("https://clerk.i10.tech/v1/organizations", { method: "POST" }),
      ENV,
    )
    spy.mockRestore()
    expect(res.status).toBe(404)
    expect(printed).toHaveLength(1)
    expect(JSON.parse(printed[0] ?? "{}")).toMatchObject({
      reason: "org_create_via_api",
    })
    expect(typeof handle).toBe("function")
  })
})

describe("content coding", () => {
  const compressed = () =>
    new Response("{}", { headers: { "content-encoding": "br", "content-length": "9" } })

  it("keeps a coding the client accepts", async () => {
    const gw = harness({ upstream: compressed })
    const res = await gw.send("/v1/environment", {
      headers: { "accept-encoding": "gzip, deflate, br, zstd" },
    })
    expect(res.headers.get("content-encoding")).toBe("br")
  })

  it("drops a coding the client did not ask for", async () => {
    for (const accept of [null, "gzip", "br;q=0"]) {
      const gw = harness({ upstream: compressed })
      const res = await gw.send("/v1/environment", {
        headers: accept ? { "accept-encoding": accept } : {},
      })
      expect(res.headers.get("content-encoding")).toBeNull()
      expect(res.headers.get("content-length")).toBeNull()
    }
  })
})
