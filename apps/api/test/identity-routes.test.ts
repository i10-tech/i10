import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import {
  createInternalIdentityRoutes,
  createSsoRoutes,
  type SsoRouteDeps,
} from "../src/routes/sso.js"
import { requireTenant } from "../src/middleware/tenant.js"
import {
  requireFreshAuth,
  requireUser,
  type SsoGateReader,
} from "../src/middleware/session.js"
import {
  gateReader,
  startUrlFor,
  withSsoFreshness,
} from "../src/identity/middleware.js"
import type { Engine } from "../src/identity/bridge.js"
import { ssoGate } from "../src/identity/gate.js"
import { testEngine, testEngineOn } from "../src/identity/test-engine.js"
import {
  configuredOidcIssuer,
  decideConnectionPrompt,
  hashSecret,
  isFresh,
  onLiveDomain,
  provedMfa,
  readSecret,
  safeReturnTo,
  sameHash,
  sessionVerdict,
  thirdPartyIssuerMatches,
} from "../src/identity/model.js"
import { FAILURE_TYPES } from "../src/identity/health.js"
import { fixedWindow, ssoRateLimit } from "../src/identity/rate-limit.js"
import { loadEnv } from "../src/env.js"
import {
  CONNECTION,
  OTHER_TENANT,
  TENANT,
  connection as makeConnection,
  log,
  memoryClerk,
  memoryStore,
} from "./identity-fakes.js"

/**
 * The identity core's HTTP edges (#337): the bridge routes, the gateway's
 * lookup, the gate in `requireUser` / `requireTenant`, step-up in
 * `requireFreshAuth`, and the test engine's locks.
 */

const BINDING = "b".repeat(43)

describe("the small rules", () => {
  it("hashes secrets and compares them in constant time", () => {
    expect(sameHash(hashSecret("a".repeat(43)), hashSecret("a".repeat(43)))).toBe(true)
    expect(sameHash(hashSecret("a".repeat(43)), hashSecret("b".repeat(43)))).toBe(false)
    expect(sameHash("", "")).toBe(false)
    expect(readSecret("short")).toBeNull()
    expect(readSecret("a b".repeat(20))).toBeNull()
    expect(readSecret("A".repeat(43))).toBe("A".repeat(43))
  })

  it("matches only exact live domains", () => {
    expect(onLiveDomain("a@acme.test", ["acme.test"])).toBe(true)
    expect(onLiveDomain("a@eu.acme.test", ["acme.test"])).toBe(false)
    expect(onLiveDomain("a@notacme.test", ["acme.test"])).toBe(false)
  })

  it("reads MFA from amr", () => {
    expect(provedMfa(["pwd"])).toBe(false)
    expect(provedMfa(undefined)).toBe(false)
    expect(provedMfa(["pwd", "otp"])).toBe(true)
    expect(provedMfa(["MFA"])).toBe(true)
  })

  it("measures sessions against the policy", () => {
    const t = new Date("2026-10-20T10:00:00Z")
    const s = { boundAt: t, lastSeenAt: t }
    const later = (ms: number) => new Date(t.getTime() + ms)
    expect(
      sessionVerdict(
        s,
        { maxSessionSeconds: null, idleTimeoutSeconds: null },
        later(1e10),
      ),
    ).toBe("ok")
    expect(
      sessionVerdict(
        s,
        { maxSessionSeconds: 60, idleTimeoutSeconds: null },
        later(61_000),
      ),
    ).toBe("max_age")
    expect(
      sessionVerdict(
        s,
        { maxSessionSeconds: null, idleTimeoutSeconds: 60 },
        later(61_000),
      ),
    ).toBe("idle")
    expect(isFresh(t, later(10 * 60 * 1000))).toBe(true)
    expect(isFresh(t, later(10 * 60 * 1000 + 1))).toBe(false)
    expect(isFresh(later(39_000), t)).toBe(true)
    expect(isFresh(later(120_000), t)).toBe(true)
    expect(isFresh(later(120_001), t)).toBe(false)
    expect(isFresh(null, t)).toBe(false)
  })

  it("sends a browser back only to our own origins", () => {
    const origins = ["https://dash.i10.tech", "https://dash.i10.localhost"]
    expect(safeReturnTo("https://dash.i10.tech/x?y=1", origins)).toBe(
      "https://dash.i10.tech/x?y=1",
    )
    expect(safeReturnTo("https://evil.test/", origins)).toBeNull()
    expect(safeReturnTo("https://user:pw@dash.i10.tech/", origins)).toBeNull()
    expect(safeReturnTo("http://dash.i10.tech/", origins)).toBeNull()
    expect(safeReturnTo("javascript:alert(1)", origins)).toBeNull()
    expect(safeReturnTo("/relative", origins)).toBeNull()
  })
})

describe("the test engine's locks", () => {
  const base = {
    DATABASE_URL: "postgres://i10_api:pw@localhost:5432/i10",
    REDIS_URL: "redis://localhost:6379",
    CLERK_WEBHOOK_SECRET: "whsec_test",
    CLERK_SECRET_KEY: "sk_test_abc",
    MAIL_DOMAINS: "i10.tech",
    SES_CONFIGURATION_SET: "i10-events",
  }
  it("is off unless asked for", () => {
    expect(loadEnv(base).IDENTITY_TEST_ENGINE).toBe("off")
    expect(testEngineOn(loadEnv(base))).toBe(false)
  })
  it("is refused at boot in production, and against a live Clerk instance", () => {
    expect(() =>
      loadEnv({
        ...base,
        IDENTITY_TEST_ENGINE: "on",
        NODE_ENV: "production",
        SENTRY_ENVIRONMENT: "production",
      }),
    ).toThrow(/IDENTITY_TEST_ENGINE/)
    expect(() =>
      loadEnv({ ...base, IDENTITY_TEST_ENGINE: "on", CLERK_SECRET_KEY: "sk_live_abc" }),
    ).toThrow(/sk_test_/)
    expect(testEngineOn(loadEnv({ ...base, IDENTITY_TEST_ENGINE: "on" }))).toBe(true)
  })
  it("is re-checked where it is used, whatever loaded the environment", () => {
    expect(
      testEngineOn({
        IDENTITY_TEST_ENGINE: "on",
        NODE_ENV: "production",
        CLERK_SECRET_KEY: "sk_test_x",
      }),
    ).toBe(false)
    expect(
      testEngineOn({
        IDENTITY_TEST_ENGINE: "on",
        NODE_ENV: "development",
        CLERK_SECRET_KEY: "sk_live_x",
      }),
    ).toBe(false)
  })
})

function ssoApp(
  options: {
    testEngine?: boolean
    signedIn?: { userId: string; sessionId: string } | "down"
    rateLimit?: SsoRouteDeps["rateLimit"]
  } = {},
) {
  const store = memoryStore()
  const clerk = memoryClerk()
  const gate = ssoGate({ store: store.store, clerk: clerk.clerk, log })
  const deps: SsoRouteDeps = {
    bridge: {
      store: store.store,
      clerk: clerk.clerk,
      engines: new Map([["test", testEngine("https://auth.i10.localhost")]]),
      join: async () => "added",
      isExempt: async () => false,
      log,
    },
    gate,
    identify: async () =>
      options.signedIn === "down"
        ? { status: "unavailable" }
        : options.signedIn
          ? { status: "signed-in", ...options.signedIn }
          : { status: "signed-out" },
    returnOrigins: ["https://dash.i10.localhost"],
    testEngine: options.testEngine ?? true,
    ...(options.rateLimit ? { rateLimit: options.rateLimit } : {}),
    mayManage: async () => false,
    tenantOfConnection: async () => TENANT,
  }
  const app = new Hono().route("/sso", createSsoRoutes(deps))
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(`/sso${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  return {
    app,
    post,
    store,
    clerk,
    engines: deps.bridge.engines as Map<string, Engine>,
  }
}

describe("the bridge's routes", () => {
  it("drive a whole sign-in through the test engine", async () => {
    const w = ssoApp({ signedIn: { userId: "user_ada", sessionId: "sess_1x" } })
    const started = await w.post("/attempts", {
      connection: CONNECTION,
      binding: BINDING,
      returnTo: "https://dash.i10.localhost/home",
    })
    expect(started.status).toBe(200)
    const { redirectUrl } = (await started.json()) as { redirectUrl: string }
    const state = new URL(redirectUrl).searchParams.get("state")
    const asserted = await w.post("/test/assert", {
      state,
      binding: BINDING,
      subject: "okta|ada",
      email: "ada@acme.test",
    })
    expect(asserted.status).toBe(200)
    const done = (await asserted.json()) as { outcome: string; code: string }
    expect(done.outcome).toBe("signed_in")
    const swapped = await w.post("/handoff", { code: done.code, binding: BINDING })
    const { ticket, handoff } = (await swapped.json()) as {
      ticket: string
      handoff: string
    }
    expect(ticket).toMatch(/^ticket_/)
    w.clerk.redeem(ticket, new Date())
    const bound = await w.post("/bind", { handoff }, { authorization: "Bearer t" })
    expect(bound.status).toBe(200)
    expect(await bound.json()).toEqual({ returnTo: "https://dash.i10.localhost/home" })
  })

  it("passes a valid login hint to the engine lowercased, and drops an invalid one", async () => {
    const w = ssoApp()
    const seen: (string | null | undefined)[] = []
    const engine = w.engines.get("test")!
    w.engines.set("test", {
      ...engine,
      begin: (connection, attempt) => {
        seen.push(attempt.loginHint)
        return engine.begin(connection, attempt)
      },
    })
    const start = (loginHint: unknown, purpose = "sign_in") =>
      w.post("/attempts", {
        connection: CONNECTION,
        binding: BINDING,
        purpose,
        loginHint,
      })
    await start("  Ada@Acme.Test ")
    await start("no-at-sign")
    await start("a b@acme.test")
    await start(`${"a".repeat(250)}@acme.test`)
    await start("a@b@acme.test")
    await start(42)
    expect(seen).toEqual(["ada@acme.test", null, null, null, null, null])
  })

  it("forces a fresh IdP login only for a sign-in that asks with `fresh: true`", async () => {
    const w = ssoApp()
    const seen: (boolean | undefined)[] = []
    const engine = w.engines.get("test")!
    w.engines.set("test", {
      ...engine,
      begin: (connection, attempt) => {
        seen.push(attempt.forceLogin)
        return engine.begin(connection, attempt)
      },
    })
    const start = (fresh: unknown) =>
      w.post("/attempts", { connection: CONNECTION, binding: BINDING, fresh })
    await start(true)
    await start("1")
    await start(undefined)
    expect(seen).toEqual([true, false, false])
  })

  it("drops a return path off our origins rather than redirecting there", async () => {
    const w = ssoApp()
    await w.post("/attempts", {
      connection: CONNECTION,
      binding: BINDING,
      returnTo: "https://evil.test/",
    })
    expect([...w.store.attempts.values()][0]!.returnTo).toBeNull()
  })

  it("refuses a malformed start, and answers a refusal as 409 with a reason", async () => {
    const w = ssoApp()
    expect(
      (await w.post("/attempts", { connection: CONNECTION, binding: "short" })).status,
    ).toBe(422)
    const unknown = await w.post("/attempts", {
      connection: "33333333-3333-4333-8333-000000000000",
      binding: BINDING,
    })
    expect(unknown.status).toBe(409)
    expect(await unknown.json()).toMatchObject({
      name: "sso_refused",
      reason: "connection_inactive",
    })
  })

  it("make a test run an admin's only", async () => {
    const out = ssoApp()
    expect(
      (
        await out.post("/attempts", {
          connection: CONNECTION,
          binding: BINDING,
          purpose: "test_run",
        })
      ).status,
    ).toBe(401)
    const member = ssoApp({ signedIn: { userId: "user_m", sessionId: "sess_m" } })
    expect(
      (
        await member.post("/attempts", {
          connection: CONNECTION,
          binding: BINDING,
          purpose: "test_run",
        })
      ).status,
    ).toBe(403)
  })

  it("answer 404 for the test engine when it is off", async () => {
    const w = ssoApp({ testEngine: false })
    expect(
      (
        await w.post("/test/assert", {
          state: "s".repeat(43),
          binding: BINDING,
          subject: "x",
          email: "a@b.co",
        })
      ).status,
    ).toBe(404)
  })

  it("bind only a signed-in session, and say 503 when Clerk cannot tell", async () => {
    expect((await ssoApp().post("/bind", { handoff: "h".repeat(43) })).status).toBe(401)
    expect(
      (await ssoApp({ signedIn: "down" }).post("/bind", { handoff: "h".repeat(43) }))
        .status,
    ).toBe(503)
  })

  it("answer 503, never a refusal, when the store fails", async () => {
    const w = ssoApp()
    w.store.store.connectionForStart = async () => {
      throw new Error("database down")
    }
    expect(
      (await w.post("/attempts", { connection: CONNECTION, binding: BINDING })).status,
    ).toBe(503)
  })
})

describe("the gateway's lookup", () => {
  const SECRET = "g".repeat(40)
  const app = (
    over: Partial<Parameters<typeof createInternalIdentityRoutes>[0] & object> = {},
  ) =>
    new Hono().route(
      "/internal/identity",
      createInternalIdentityRoutes({
        secret: SECRET,
        managedByIdentifier: async (id) => id === "ada@acme.test",
        managedBySession: async (sid) => sid === "sess_ada",
        log,
        ...over,
      }),
    )
  const ask = (a: Hono, body: unknown, secret = SECRET) =>
    a.request("/internal/identity/managed", {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    })

  it("answers by identifier, lower-cased, and by session", async () => {
    expect(await (await ask(app(), { identifier: " Ada@Acme.test " })).json()).toEqual({
      managed: true,
    })
    expect(await (await ask(app(), { identifier: "bob@acme.test" })).json()).toEqual({
      managed: false,
    })
    expect(await (await ask(app(), { sessionId: "sess_ada" })).json()).toEqual({
      managed: true,
    })
    expect((await ask(app(), { sessionId: "not-a-session" })).status).toBe(422)
  })

  it("refuses a wrong secret, and is 503 with none configured or on any failure", async () => {
    expect((await ask(app(), { identifier: "a@b.co" }, "wrong")).status).toBe(401)
    expect(
      (await ask(app({ secret: undefined }), { identifier: "a@b.co" })).status,
    ).toBe(503)
    const broken = app({
      managedByIdentifier: async () => {
        throw new Error("down")
      },
    })
    expect((await ask(broken, { identifier: "a@b.co" })).status).toBe(503)
  })
})

describe("the gate in the middleware", () => {
  const verdicts: Record<string, Awaited<ReturnType<SsoGateReader>>> = {
    pass: { status: "pass" },
    sso: {
      status: "sso_required",
      startUrl: "https://auth.i10.localhost/sso/start?connection=c",
      reason: "unbound",
    },
    unknown: { status: "unknown" },
  }
  function app(verdict: keyof typeof verdicts) {
    const a = new Hono()
    a.use("*", async (c, next) => {
      c.set("ssoGate", async () => verdicts[verdict]!)
      c.set("sessionAuth", {
        verify: async () => ({ status: "signed-in", userId: "user_ada" }),
      })
      c.set("tenantAuth", {
        sessions: { verify: async () => ({ status: "signed-in", userId: "user_ada" }) },
        tenants: { resolve: async () => TENANT },
      })
      await next()
    })
    a.get("/user", requireUser, (c) => c.text("ok"))
    a.get("/tenant", requireTenant, (c) => c.text("ok"))
    return a
  }
  const get = (a: Hono, path: string) =>
    a.request(path, { headers: { Authorization: "Bearer x" } })

  it("lets a pass through both", async () => {
    expect((await get(app("pass"), "/user")).status).toBe(200)
    expect((await get(app("pass"), "/tenant")).status).toBe(200)
  })

  it("refuses a managed account's unbound session with 403 sso_required and the start URL", async () => {
    for (const path of ["/user", "/tenant"]) {
      const res = await get(app("sso"), path)
      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({
        name: "sso_required",
        startUrl: "https://auth.i10.localhost/sso/start?connection=c",
      })
    }
  })

  it("answers 503 when the gate cannot tell", async () => {
    for (const path of ["/user", "/tenant"])
      expect((await get(app("unknown"), path)).status).toBe(503)
  })

  it("reads the session id itself, and treats a different user as unknown", async () => {
    const store = memoryStore()
    const gate = ssoGate({ store: store.store, clerk: memoryClerk().clerk, log })
    const reader = gateReader(
      async () => ({ status: "ok", userId: "user_eve", sessionId: "s" }),
      gate,
      startUrlFor("https://auth.x"),
    )
    expect(await reader(new Request("https://api.x"), "user_ada")).toEqual({
      status: "unknown",
    })
  })
})

describe("step-up for managed accounts", () => {
  function app(fresh: boolean | "not_managed") {
    const a = new Hono()
    const inner = async () => ({ status: "fresh" as const })
    const reader = withSsoFreshness(
      inner,
      async () => ({ status: "ok", userId: "user_ada", sessionId: "sess_1" }),
      {
        check: async () => ({ status: "pass" }),
        freshness: async () =>
          fresh === "not_managed" ? { managed: false } : { managed: true, fresh },
        forget: () => {},
      },
      startUrlFor("https://auth.i10.localhost", "/sso/step-up"),
      async () => CONNECTION,
      log,
    )
    a.use("*", async (c, next) => {
      c.set("freshAuth", reader)
      await next()
    })
    a.post("/delete", requireFreshAuth, (c) => c.text("deleted"))
    return a
  }

  it("lets everybody else through Clerk's own check, unchanged", async () => {
    expect(
      (await app("not_managed").request("/delete", { method: "POST" })).status,
    ).toBe(200)
  })

  it("accepts a fresh IdP authentication", async () => {
    expect((await app(true).request("/delete", { method: "POST" })).status).toBe(200)
  })

  it("sends a stale managed account to its IdP, not to Clerk's dialog", async () => {
    const res = await app(false).request("/delete", { method: "POST" })
    expect(res.status).toBe(403)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      name: "sso_step_up_required",
      startUrl: `https://auth.i10.localhost/sso/step-up?connection=${CONNECTION}`,
    })
    expect(body.clerk_error).toBeUndefined()
  })
})

describe("outside starts and POST /sso/connection", () => {
  const OKTA_ISS = "https://integrator-2590605.okta.com"
  const UNKNOWN = "99999999-9999-4999-8999-999999999999"

  it("resolves configuredOidcIssuer, thirdPartyIssuerMatches and decideConnectionPrompt purely", () => {
    const oidcConn = makeConnection({
      protocol: "oidc",
      provider: "okta",
      config: { oidc: { issuer: OKTA_ISS } },
    })
    const googleConn = makeConnection({
      protocol: "oidc",
      provider: "google",
      config: { oidc: { issuer: "https://evil.example" } },
    })
    const samlConn = makeConnection({ protocol: "saml", provider: "entra" })

    expect(configuredOidcIssuer(oidcConn)).toBe(OKTA_ISS)
    expect(configuredOidcIssuer(googleConn)).toBe("https://accounts.google.com")
    expect(configuredOidcIssuer(samlConn)).toBeNull()

    expect(thirdPartyIssuerMatches(oidcConn, undefined)).toBe(true)
    expect(thirdPartyIssuerMatches(oidcConn, OKTA_ISS)).toBe(true)
    expect(thirdPartyIssuerMatches(oidcConn, `${OKTA_ISS}/`)).toBe(false)
    expect(thirdPartyIssuerMatches(oidcConn, "")).toBe(false)
    expect(thirdPartyIssuerMatches(googleConn, "https://accounts.google.com")).toBe(
      true,
    )
    expect(thirdPartyIssuerMatches(googleConn, "https://evil.example")).toBe(false)
    expect(thirdPartyIssuerMatches(samlConn, "https://anything.example")).toBe(true)

    expect(decideConnectionPrompt(null, OKTA_ISS)).toEqual({ outcome: "invalid" })
    expect(
      decideConnectionPrompt({ ...oidcConn, status: "disabled" }, OKTA_ISS),
    ).toEqual({ outcome: "invalid" })
    expect(decideConnectionPrompt(oidcConn, "https://wrong.okta.com")).toEqual({
      outcome: "issuer_mismatch",
      tenantId: TENANT,
      connectionId: CONNECTION,
    })

    // Outside-start audit events never count as connection failures for health alerts.
    expect(FAILURE_TYPES).not.toContain("sign_in.interstitial")
    expect(FAILURE_TYPES).not.toContain("sign_in.issuer_mismatch")
  })

  it("returns only name, protocol and provider for an active connection and audits the interstitial", async () => {
    const { post, store } = ssoApp()
    store.connections.set(
      CONNECTION,
      makeConnection({
        name: "Acme Okta",
        protocol: "oidc",
        provider: "okta",
        status: "active",
        config: {
          oidc: {
            issuer: OKTA_ISS,
            clientId: "secret-client-id",
            discoveryUrl: `${OKTA_ISS}/.well-known/openid-configuration`,
          },
        },
      }),
    )

    const res = await post("/connection", {
      connection: CONNECTION.toUpperCase(),
      iss: OKTA_ISS,
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toEqual({
      name: "Acme Okta",
      protocol: "oidc",
      provider: "okta",
    })
    expect(store.events).toEqual([
      {
        tenantId: TENANT,
        type: "sign_in.interstitial",
        connectionId: CONNECTION,
        data: { thirdPartyInitiated: true },
      },
    ])
  })

  it("audits sign_in.issuer_mismatch without storing untrusted strings and answers the same 404 as unknown ids", async () => {
    const { post, store } = ssoApp()
    store.connections.set(
      CONNECTION,
      makeConnection({
        name: "Acme Okta",
        protocol: "oidc",
        provider: "okta",
        status: "active",
        config: { oidc: { issuer: OKTA_ISS } },
      }),
    )

    const unknownRes = await post("/connection", { connection: UNKNOWN })
    expect(unknownRes.status).toBe(404)
    const unknownBody = await unknownRes.json()

    const mismatchRes = await post("/connection", {
      connection: CONNECTION,
      iss: "https://attacker.okta.com",
    })
    expect(mismatchRes.status).toBe(404)
    expect(await mismatchRes.json()).toEqual(unknownBody)

    const overlongRes = await post("/connection", {
      connection: CONNECTION,
      iss: `https://${"a".repeat(2500)}.okta.com`,
    })
    expect(overlongRes.status).toBe(404)

    expect(store.events).toEqual([
      {
        tenantId: TENANT,
        type: "sign_in.issuer_mismatch",
        connectionId: CONNECTION,
        data: {},
      },
      {
        tenantId: TENANT,
        type: "sign_in.issuer_mismatch",
        connectionId: CONNECTION,
        data: {},
      },
    ])
  })

  it("ignores iss on SAML connections and hides draft, testing and disabled connections across workspaces", async () => {
    const { post, store } = ssoApp()
    store.connections.set(
      CONNECTION,
      makeConnection({
        name: "Acme Entra",
        protocol: "saml",
        provider: "entra",
        status: "active",
      }),
    )

    const samlRes = await post("/connection", {
      connection: CONNECTION,
      iss: "https://ignored.example",
    })
    expect(samlRes.status).toBe(200)
    expect(await samlRes.json()).toEqual({
      name: "Acme Entra",
      protocol: "saml",
      provider: "entra",
    })
    expect(store.events.at(-1)).toEqual({
      tenantId: TENANT,
      type: "sign_in.interstitial",
      connectionId: CONNECTION,
      data: {},
    })

    for (const status of ["draft", "testing", "disabled"] as const) {
      const otherId = "44444444-4444-4444-8444-444444444444"
      store.connections.set(
        otherId,
        makeConnection({
          id: otherId,
          tenantId: OTHER_TENANT,
          status,
          protocol: "oidc",
          provider: "okta",
          config: { oidc: { issuer: OKTA_ISS } },
        }),
      )
      const countBefore = store.events.length
      const inactive = await post("/connection", {
        connection: otherId,
        iss: "https://wrong.okta.com",
      })
      expect(inactive.status).toBe(404)
      expect(store.events.length).toBe(countBefore)
    }

    expect((await post("/connection", { connection: "not-a-uuid" })).status).toBe(404)
    expect((await post("/connection", {})).status).toBe(422)
    expect(
      (await post("/connection", { connection: CONNECTION, extra: 1 })).status,
    ).toBe(422)
  })

  it("checks iss on POST /sso/attempts as well and audits mismatches without creating an attempt", async () => {
    const { post, store, engines } = ssoApp()
    engines.set("oidc", {
      protocol: "oidc",
      pkce: true,
      begin: async () => ({ redirectUrl: `${OKTA_ISS}/authorize?state=1` }),
    })
    store.connections.set(
      CONNECTION,
      makeConnection({
        protocol: "oidc",
        provider: "okta",
        status: "active",
        config: { oidc: { issuer: OKTA_ISS } },
      }),
    )

    const bad = await post("/attempts", {
      connection: CONNECTION,
      purpose: "sign_in",
      binding: BINDING,
      iss: "https://wrong.okta.com",
      loginHint: "ada@acme.test",
    })
    expect(bad.status).toBe(409)
    expect(await bad.json()).toMatchObject({ reason: "issuer_mismatch" })
    expect(store.attempts.size).toBe(0)
    expect(store.events).toEqual([
      {
        tenantId: TENANT,
        type: "sign_in.issuer_mismatch",
        connectionId: CONNECTION,
        data: {},
      },
    ])

    const good = await post("/attempts", {
      connection: CONNECTION,
      purpose: "sign_in",
      binding: BINDING,
      iss: OKTA_ISS,
      loginHint: "Ada@Acme.test",
    })
    expect(good.status).toBe(200)
    expect(store.attempts.size).toBe(1)
  })

  it("applies the public /sso rate limit and 503 outage handling to POST /sso/connection", async () => {
    const edgeSecret = "edge-secret-for-test"
    const limiter = ssoRateLimit({
      take: fixedWindow(null, () => 1_000),
      contextSecret: undefined,
      edgeSecret,
      perConnectionStarts: true,
    })
    const { post } = ssoApp({ rateLimit: limiter })
    const headers = {
      "cf-connecting-ip": "203.0.113.10",
      "x-i10-edge": edgeSecret,
    }

    for (let i = 0; i < 60; i++) {
      const ok = await post("/connection", { connection: CONNECTION }, headers)
      expect(ok.status).toBe(200)
    }
    const limited = await post("/connection", { connection: CONNECTION }, headers)
    expect(limited.status).toBe(429)

    // Per-connection cap applies even across distinct caller IPs.
    const perConnKeys: string[] = []
    const perConnLimiter = ssoRateLimit({
      take: async (key) => {
        perConnKeys.push(key)
        return key.startsWith("conn:") ? { ok: false, retryAfter: 30 } : { ok: true }
      },
      contextSecret: undefined,
      edgeSecret,
      perConnectionStarts: true,
    })
    const perConnApp = ssoApp({ rateLimit: perConnLimiter })
    const perConnRes = await perConnApp.post("/connection", {
      connection: CONNECTION,
    })
    expect(perConnRes.status).toBe(429)
    expect(perConnKeys).toContain(`conn:${CONNECTION}`)

    // Store failure fails closed with 503.
    const broken = ssoApp()
    broken.store.store.connectionForStart = async () => {
      throw new Error("db down")
    }
    const down = await broken.post("/connection", { connection: CONNECTION })
    expect(down.status).toBe(503)
  })
})
