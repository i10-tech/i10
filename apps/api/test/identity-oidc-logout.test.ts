import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import type { Connection } from "../src/identity/model.js"
import { oidcEngine } from "../src/identity/oidc.js"
import { guardedFetch } from "../src/identity/oidc-fetch.js"
import {
  backchannelLogout,
  LOGOUT_MAX_AGE_MS,
  type LogoutFailure,
} from "../src/identity/oidc-logout.js"
import { fixedWindow, ssoRateLimit } from "../src/identity/rate-limit.js"
import { createSsoRoutes, type SsoRouteDeps } from "../src/routes/sso.js"
import type { EgressVerdict } from "../src/webhooks/egress.js"
import {
  CONNECTION,
  OTHER_TENANT,
  TENANT,
  connection,
  log,
  memoryClerk,
  memoryReplay,
  memorySaml,
  memoryStore,
} from "./identity-fakes.js"
import { testIssuer } from "./oidc-issuer.js"

/**
 * OpenID Connect Back-Channel Logout (#345): an IdP's signed Logout Token ends
 * the sessions we bound to it. Every refusal first: a token anyone could have
 * made, one that is stale, meant for someone else, replayed, or not a logout
 * at all revokes nothing and is answered with a bare 400.
 */

const PUBLIC: EgressVerdict = { ok: true, address: "93.184.216.34", family: 4 }
const EVENT = "http://schemas.openid.net/event/backchannel-logout"
const OTHER_CONNECTION = "44444444-4444-4444-8444-444444444444"

function oidcConnection(over: Partial<Connection> = {}) {
  return connection({
    protocol: "oidc",
    provider: "okta",
    config: {
      oidc: {
        issuer: "https://idp.acme.test",
        clientId: "client-acme",
        clientAuth: "client_secret_basic",
        clientSecretSet: true,
      },
    },
    ...over,
  })
}

async function world(options: { connection?: Connection; more?: Connection[] } = {}) {
  const idp = await testIssuer()
  const store = memoryStore({
    connections: [options.connection ?? oidcConnection(), ...(options.more ?? [])],
  })
  const clerk = memoryClerk()
  const replay = memoryReplay()
  const saml = memorySaml(store)
  const forgotten: { userId?: string; sessionId?: string }[] = []
  const engine = oidcEngine({
    store: store.store,
    fetch: guardedFetch({ vet: async () => PUBLIC, fetch: idp.fetch }),
    redirectUri: "https://auth.i10.localhost/sso/callback",
    google: null,
    log,
  })
  const logout = backchannelLogout(
    {
      store: store.store,
      sessions: saml.saml,
      clerk: clerk.clerk,
      replay: replay.replay,
      forget: (input) => forgotten.push(input),
      fetch: guardedFetch({ vet: async () => PUBLIC, fetch: idp.fetch }),
      log,
    },
    engine,
  )
  let n = 0
  /** A session bound through `connectionId` for the person `subject` there. */
  const bound = (
    sessionId: string,
    over: {
      sub?: string
      sid?: string | null
      connectionId?: string
      tenantId?: string
    } = {},
  ) => {
    const subject = over.sub ?? "idp|ada"
    const connectionId = over.connectionId ?? CONNECTION
    const tenantId = over.tenantId ?? TENANT
    let identity = store.identities.find(
      (i) => i.subject === subject && i.connectionId === connectionId,
    )
    if (!identity) {
      identity = {
        id: `00000000-0000-4000-a000-${String(++n).padStart(12, "0")}`,
        tenantId,
        connectionId,
        subject,
        clerkUserId: `user_${subject.replace(/\\W/g, "")}`,
        email: null,
        lastLoginAt: null,
      }
      store.identities.push(identity)
    }
    store.sessions.set(sessionId, {
      sessionId,
      tenantId,
      clerkUserId: identity.clerkUserId,
      connectionId,
      identityId: identity.id,
      idpSession: over.sid === undefined ? "idp-session-1" : over.sid,
      authTime: null,
      boundAt: new Date(),
      freshAt: new Date(),
      lastSeenAt: new Date(),
      revokedAt: null,
      revokedReason: null,
    })
  }
  const call = (token: string, connectionId = CONNECTION) =>
    logout({ connectionId, logoutToken: token })
  const live = (sessionId: string) => store.sessions.get(sessionId)!.revokedAt === null
  const failures = () => store.events.filter((e) => e.type === "logout.failed")
  return { idp, store, clerk, replay, forgotten, bound, call, live, failures, logout }
}

describe("a Logout Token we refuse", () => {
  const refusals: [
    string,
    (idp: Awaited<ReturnType<typeof testIssuer>>) => Promise<string>,
    LogoutFailure,
  ][] = [
    [
      "signed by a key the IdP does not publish",
      (i) => i.logoutToken({}, { rogueKey: true }),
      "bad_signature",
    ],
    [
      "signed with a key id we do not know",
      (i) => i.logoutToken({}, { kid: "unknown" }),
      "bad_signature",
    ],
    [
      "signed HS256 with the client secret",
      (i) => i.logoutToken({}, { alg: "HS256" }),
      "bad_signature",
    ],
    ["unsigned (alg none)", (i) => i.logoutToken({}, { alg: "none" }), "malformed"],
    [
      "from another issuer",
      (i) => i.logoutToken({ iss: "https://evil.test" }),
      "issuer",
    ],
    [
      "meant for another client",
      (i) => i.logoutToken({ aud: "someone-else" }),
      "audience",
    ],
    [
      "meant for several clients but not us",
      (i) => i.logoutToken({ aud: ["a", "b"] }),
      "audience",
    ],
    [
      "expired",
      (i) =>
        i.logoutToken({
          iat: Math.floor(Date.now() / 1000) - 600,
          exp: Math.floor(Date.now() / 1000) - 300,
        }),
      "expired",
    ],
    [
      "from the future",
      (i) => i.logoutToken({ iat: Math.floor(Date.now() / 1000) + 3600 }),
      "iat",
    ],
    [
      "old, though its exp is far off",
      (i) =>
        i.logoutToken({
          iat: Math.floor((Date.now() - LOGOUT_MAX_AGE_MS - 60_000) / 1000),
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      "iat",
    ],
    ["without an iat", (i) => i.logoutToken({}, { omit: ["iat"] }), "malformed"],
    ["without an exp", (i) => i.logoutToken({}, { omit: ["exp"] }), "malformed"],
    ["without a jti", (i) => i.logoutToken({}, { omit: ["jti"] }), "malformed"],
    [
      "carrying a nonce (an ID token in disguise)",
      (i) => i.logoutToken({ nonce: "n-0S6_WzA2Mj" }),
      "nonce",
    ],
    ["carrying an empty nonce", (i) => i.logoutToken({ nonce: "" }), "nonce"],
    [
      "without the events claim",
      (i) => i.logoutToken({}, { omit: ["events"] }),
      "events",
    ],
    [
      "with events for another event",
      (i) => i.logoutToken({ events: { "http://other/event": {} } }),
      "events",
    ],
    [
      "with events that are not an object",
      (i) => i.logoutToken({ events: [EVENT] }),
      "events",
    ],
    [
      "with the event's value not an object",
      (i) => i.logoutToken({ events: { [EVENT]: true } }),
      "events",
    ],
    [
      "with neither sub nor sid",
      (i) => i.logoutToken({}, { omit: ["sub", "sid"] }),
      "no_subject",
    ],
    ["with a sub that is not a string", (i) => i.logoutToken({ sub: 42 }), "malformed"],
    ["with an empty sid", (i) => i.logoutToken({ sid: "" }), "malformed"],
  ]
  for (const [name, make, failure] of refusals)
    it(`refuses one ${name}`, async () => {
      const w = await world()
      w.bound("sess_1")
      const done = await w.call(await make(w.idp))
      expect(done).toEqual({ outcome: "refused", failure })
      expect(w.live("sess_1")).toBe(true)
      expect(w.clerk.calls.filter((c) => c.startsWith("revokeSession"))).toEqual([])
      expect(w.failures()[0]).toMatchObject({
        connectionId: CONNECTION,
        reason: failure,
      })
    })

  for (const [name, token] of [
    ["not a JWT", "hello"],
    ["a JWE-shaped string", "a.b.c.d.e"],
    ["empty segments", "..."],
    ["huge", `${"a".repeat(9000)}.b.c`],
  ] as const)
    it(`refuses a token that is ${name}`, async () => {
      const w = await world()
      w.bound("sess_1")
      expect(await w.call(token)).toMatchObject({
        outcome: "refused",
        failure: "malformed",
      })
      expect(w.live("sess_1")).toBe(true)
    })

  it("refuses a replayed token and ends nothing the second time", async () => {
    const w = await world()
    w.bound("sess_1")
    const token = await w.idp.logoutToken()
    expect(await w.call(token)).toEqual({ outcome: "logged_out", revoked: 1 })
    w.bound("sess_2")
    expect(await w.call(token)).toEqual({ outcome: "refused", failure: "replayed" })
    expect(w.live("sess_2")).toBe(true)
    expect(w.failures().at(-1)).toMatchObject({ reason: "replayed" })
  })

  it("does not let a forged token spend a real token's jti", async () => {
    const w = await world()
    w.bound("sess_1")
    const real = await w.idp.logoutToken({ jti: "shared-id" })
    const forged = await w.idp.logoutToken({ jti: "shared-id" }, { rogueKey: true })
    expect((await w.call(forged)).outcome).toBe("refused")
    expect(await w.call(real)).toEqual({ outcome: "logged_out", revoked: 1 })
  })

  it("refuses a token on a connection that is not OIDC, is Google, is not live, or is unknown", async () => {
    const cases: Partial<Connection>[] = [
      { protocol: "saml" },
      { provider: "google" },
      { status: "draft" },
      { status: "testing" },
    ]
    for (const over of cases) {
      const w = await world({ connection: oidcConnection(over) })
      const done = await w.call(await w.idp.logoutToken())
      expect(done).toEqual({ outcome: "refused", failure: "unknown_connection" })
    }
    const w = await world()
    expect(await w.call(await w.idp.logoutToken(), OTHER_CONNECTION)).toEqual({
      outcome: "refused",
      failure: "unknown_connection",
    })
  })

  it("refuses a token for a connection whose settings are incomplete", async () => {
    const w = await world({ connection: oidcConnection({ config: {} }) })
    expect(await w.call(await w.idp.logoutToken())).toEqual({
      outcome: "refused",
      failure: "not_configured",
    })
  })

  it("does not take a token the same IdP signed for another workspace's connection", async () => {
    const other = oidcConnection({ id: OTHER_CONNECTION, tenantId: OTHER_TENANT })
    const w = await world({ more: [other] })
    w.bound("sess_other", { connectionId: OTHER_CONNECTION, tenantId: OTHER_TENANT })
    w.bound("sess_mine")
    expect(await w.call(await w.idp.logoutToken())).toEqual({
      outcome: "logged_out",
      revoked: 1,
    })
    expect(w.live("sess_mine")).toBe(false)
    expect(w.live("sess_other")).toBe(true)
  })

  it("audits an unauthenticated refusal once a minute per kind, not once per request", async () => {
    const w = await world()
    for (let i = 0; i < 5; i += 1) await w.call("hello")
    expect(w.failures()).toHaveLength(1)
    await w.call(await w.idp.logoutToken({}, { rogueKey: true }))
    expect(w.failures()).toHaveLength(2)
  })
})

describe("an outage is a retry, never an accepted or refused token", () => {
  it("answers unavailable when the IdP's keys cannot be fetched", async () => {
    const w = await world()
    w.idp.fail.jwks = 503
    expect(await w.call(await w.idp.logoutToken())).toEqual({ outcome: "unavailable" })
  })

  it("answers unavailable when discovery fails", async () => {
    const w = await world()
    w.idp.fail.discovery = 503
    expect(await w.call(await w.idp.logoutToken())).toEqual({ outcome: "unavailable" })
  })

  it("answers unavailable when the replay cache is down, and ends nothing", async () => {
    const w = await world()
    w.bound("sess_1")
    w.replay.fail.down = true
    expect(await w.call(await w.idp.logoutToken())).toEqual({ outcome: "unavailable" })
    expect(w.live("sess_1")).toBe(true)
  })

  it("gives the token back when Clerk fails, so the IdP's retry is accepted", async () => {
    const w = await world()
    w.bound("sess_1")
    const token = await w.idp.logoutToken()
    w.clerk.fail.revokeSession = true
    await expect(w.call(token)).rejects.toThrow()
    // Our row was not marked revoked behind Clerk's back.
    expect(w.live("sess_1")).toBe(true)
    w.clerk.fail.revokeSession = false
    expect(await w.call(token)).toEqual({ outcome: "logged_out", revoked: 1 })
    expect(w.live("sess_1")).toBe(false)
  })
})

describe("what an accepted token ends", () => {
  it("the session its sid names, Clerk first, then our row, then the gate's cache", async () => {
    const w = await world()
    w.bound("sess_1", { sid: "sid-a" })
    w.bound("sess_2", { sid: "sid-b" })
    const done = await w.call(await w.idp.logoutToken({ sid: "sid-a", sub: undefined }))
    expect(done).toEqual({ outcome: "logged_out", revoked: 1 })
    expect(w.live("sess_1")).toBe(false)
    expect(w.live("sess_2")).toBe(true)
    expect(w.store.sessions.get("sess_1")!.revokedReason).toBe("idp_logout")
    expect(w.clerk.calls).toContain("revokeSession:sess_1")
    expect(w.forgotten).toContainEqual({
      userId: w.store.sessions.get("sess_1")!.clerkUserId,
      sessionId: "sess_1",
    })
    expect(w.store.events.map((e) => e.type)).toEqual(["session.revoked", "logout.idp"])
    expect(w.store.events.at(-1)).toMatchObject({
      data: { revoked: 1, by: "sid" },
    })
  })

  it("every session of the subject on that connection when only a sub is given", async () => {
    const w = await world()
    w.bound("sess_1", { sid: "sid-a" })
    w.bound("sess_2", { sid: "sid-b" })
    w.bound("sess_bob", { sub: "idp|bob", sid: "sid-c" })
    const done = await w.call(await w.idp.logoutToken({}, { omit: ["sid"] }))
    expect(done).toEqual({ outcome: "logged_out", revoked: 2 })
    expect(w.live("sess_bob")).toBe(true)
    expect(w.store.events.at(-1)).toMatchObject({ data: { by: "sub" } })
  })

  it("only the subject's session with that sid when both are given", async () => {
    const w = await world()
    w.bound("sess_ada", { sid: "sid-a" })
    w.bound("sess_bob", { sub: "idp|bob", sid: "sid-a" })
    const done = await w.call(await w.idp.logoutToken({ sid: "sid-a", sub: "idp|ada" }))
    expect(done).toEqual({ outcome: "logged_out", revoked: 1 })
    expect(w.live("sess_bob")).toBe(true)
  })

  it("nothing, with a 200, for a session we do not hold", async () => {
    const w = await world()
    w.bound("sess_1")
    expect(
      await w.call(await w.idp.logoutToken({ sid: "nobody", sub: undefined })),
    ).toEqual({
      outcome: "logged_out",
      revoked: 0,
    })
    expect(w.live("sess_1")).toBe(true)
  })

  it("not a session already ended, and a paused connection's sessions still end", async () => {
    const w = await world({ connection: oidcConnection({ status: "disabled" }) })
    w.bound("sess_1")
    w.bound("sess_2", { sid: "idp-session-2" })
    w.store.sessions.get("sess_2")!.revokedAt = new Date()
    expect(await w.call(await w.idp.logoutToken({}, { omit: ["sid"] }))).toEqual({
      outcome: "logged_out",
      revoked: 1,
    })
  })

  it("accepts a token whose audience lists several clients including ours", async () => {
    const w = await world()
    w.bound("sess_1")
    expect(
      await w.call(await w.idp.logoutToken({ aud: ["other", "client-acme"] })),
    ).toEqual({
      outcome: "logged_out",
      revoked: 1,
    })
  })

  it("does not let unsigned callers make it refetch the IdP's keys more than twice a minute", async () => {
    const w = await world()
    await w.call(await w.idp.logoutToken({}, { kid: "rotated-1" }))
    const fetched = w.idp.calls.jwks
    for (let i = 0; i < 5; i += 1)
      await w.call(await w.idp.logoutToken({}, { kid: `rotated-${i + 2}` }))
    expect(w.idp.calls.jwks).toBe(fetched)
  })
})

describe("POST /sso/oidc/backchannel/:connection", () => {
  async function routes(over: { limit?: boolean } = {}) {
    const w = await world()
    let wired = true
    const deps = {
      bridge: { store: w.store.store, log },
      gate: { forget: () => {} },
      identify: async () => ({ status: "signed-out" }),
      returnOrigins: [],
      testEngine: false,
      oidcLogout: wired ? w.logout : undefined,
      mayManage: async () => true,
      tenantOfConnection: async () => TENANT,
      ...(over.limit
        ? {
            rateLimit: ssoRateLimit({
              take: fixedWindow(null, () => 1_000_000),
              contextSecret: undefined,
            }),
          }
        : {}),
    } as unknown as SsoRouteDeps
    const app = new Hono().route("/sso", createSsoRoutes(deps))
    const post = (
      token: string | null,
      init: { path?: string; type?: string; body?: string; ip?: string } = {},
    ) =>
      app.request(init.path ?? `/sso/oidc/backchannel/${CONNECTION}`, {
        method: "POST",
        headers: {
          "content-type": init.type ?? "application/x-www-form-urlencoded",
          ...(init.ip ? { "cf-connecting-ip": init.ip } : {}),
        },
        body:
          init.body ??
          (token === null
            ? ""
            : new URLSearchParams({ logout_token: token }).toString()),
      })
    wired = true
    return { ...w, app, post }
  }

  it("answers a bare 400 for everything it refuses, and tells nothing apart", async () => {
    const w = await routes()
    w.bound("sess_1")
    const real = await w.idp.logoutToken()
    const bodies = new Set<string>()
    for (const res of [
      await w.post(await w.idp.logoutToken({}, { rogueKey: true })),
      await w.post(await w.idp.logoutToken({ nonce: "x" })),
      await w.post(await w.idp.logoutToken({ aud: "nope" })),
      await w.post("hello"),
      await w.post(null),
      await w.post(real, {
        type: "application/json",
        body: JSON.stringify({ logout_token: real }),
      }),
      await w.post(real, { path: "/sso/oidc/backchannel/not-a-uuid" }),
      await w.post(real, { path: `/sso/oidc/backchannel/${OTHER_CONNECTION}` }),
      await w.post(real, {
        body: `logout_token=${encodeURIComponent(real)}&logout_token=${encodeURIComponent(real)}`,
      }),
      await w.post(real, { body: `logout_token=${"a".repeat(9000)}` }),
    ]) {
      expect(res.status).toBe(400)
      expect(res.headers.get("cache-control")).toBe("no-store")
      bodies.add(await res.text())
    }
    expect([...bodies]).toEqual(['{"error":"invalid_request"}'])
    expect(w.live("sess_1")).toBe(true)
  })

  it("answers 200 and ends the session for a valid token", async () => {
    const w = await routes()
    w.bound("sess_1")
    const res = await w.post(await w.idp.logoutToken())
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.text()).toBe("")
    expect(w.live("sess_1")).toBe(false)
  })

  it("answers 400 to the same token the second time", async () => {
    const w = await routes()
    w.bound("sess_1")
    const token = await w.idp.logoutToken()
    expect((await w.post(token)).status).toBe(200)
    expect((await w.post(token)).status).toBe(400)
  })

  it("answers 503 with a retry hint when it could not tell", async () => {
    const w = await routes()
    w.replay.fail.down = true
    const res = await w.post(await w.idp.logoutToken())
    expect(res.status).toBe(503)
    expect(res.headers.get("retry-after")).toBe("5")
  })

  it("answers 503 when revoking fails, so the IdP retries", async () => {
    const w = await routes()
    w.bound("sess_1")
    w.clerk.fail.revokeSession = true
    expect((await w.post(await w.idp.logoutToken())).status).toBe(503)
  })

  it("is not there when back-channel logout is not wired", async () => {
    const app = new Hono().route(
      "/sso",
      createSsoRoutes({
        bridge: { store: {}, log },
        gate: {},
        identify: async () => ({ status: "signed-out" }),
        returnOrigins: [],
        testEngine: false,
        mayManage: async () => true,
        tenantOfConnection: async () => null,
      } as unknown as SsoRouteDeps),
    )
    const res = await app.request(`/sso/oidc/backchannel/${CONNECTION}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "logout_token=x",
    })
    expect(res.status).toBe(404)
  })

  it("is rate limited per address and per connection", async () => {
    const w = await routes({ limit: true })
    let last = 0
    for (let i = 0; i < 301; i += 1)
      last = (await w.post("hello", { ip: "198.51.100.5" })).status
    expect(last).toBe(429)
    // Another address is still heard, until the connection's total is spent.
    expect((await w.post("hello", { ip: "198.51.100.6" })).status).toBe(400)
    let total = 0
    for (let i = 0; i < 400; i += 1)
      total = (await w.post("hello", { ip: `203.0.113.${i % 250}` })).status
    expect(total).toBe(429)
  })
})
