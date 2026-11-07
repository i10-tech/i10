import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { mountIdentity } from "../src/routes/console/identity.js"
import { createSsoRoutes, type SsoRouteDeps } from "../src/routes/sso.js"
import type { ConsoleDeps } from "../src/routes/console/deps.js"
import type { Role } from "../src/console/roles.js"
import type { Connection } from "../src/identity/model.js"
import { fixedWindow } from "../src/identity/rate-limit.js"
import { ssoGate } from "../src/identity/gate.js"
import type { OidcEngine } from "../src/identity/oidc.js"
import {
  CONNECTION,
  TENANT,
  connection,
  log,
  memoryClerk,
  memoryStore,
} from "./identity-fakes.js"
import { memoryPolicy } from "./identity-policy-fakes.js"
import { EDGE_PROOF, EDGE_SECRET } from "./edge-fixture.js"

/**
 * Setup links (#340): made by an admin for one draft or testing connection,
 * shown once, stored hashed, revocable; and what the token alone can and
 * cannot do at `/sso/setup/<token>`.
 */

const ROLES: Record<string, Role> = {
  user_owner: "owner",
  user_admin: "admin",
  user_m: "member",
}
const BINDING = "b".repeat(43)

function world(
  over: Partial<Connection> = {},
  limits?: { perLink?: number; perIp?: number },
) {
  const store = memoryStore({
    connections: [
      connection({ protocol: "oidc", provider: "okta", status: "draft", ...over }),
    ],
  })
  const policy = memoryPolicy()
  const clerk = memoryClerk()
  const engine = {
    redirectUri: "https://auth.i10.localhost/sso/callback",
    googleRedirectUri: "https://auth.i10.localhost/sso/callback/google",
    google: false,
    discover: async () => ({}),
  } as unknown as OidcEngine
  const identity = {
    store: store.store,
    clerk: clerk.clerk,
    gate: { forget: () => {} },
    protocols: ["oidc"],
    deprovision: {},
    log,
    policy: policy.store,
    oidc: {
      engine,
      jwksUrl: (id: string) => `https://auth.i10.localhost/sso/jwks/${id}`,
      backchannelLogoutUrl: (id: string) =>
        `https://api.i10.localhost/sso/oidc/backchannel/${id}`,
    },
  }
  let fresh = true
  const consoleApp = new Hono()
  consoleApp.use("*", async (c, next) => {
    c.set("auth", { apiKeyId: "", tenantId: TENANT, scopes: [], mode: "live" } as never)
    c.set("user", { userId: c.req.header("x-user") ?? "", orgId: "org_acme" } as never)
    c.set("freshAuth", (async () => ({ status: fresh ? "fresh" : "stale" })) as never)
    await next()
  })
  mountIdentity(consoleApp, {
    roles: { store: { roleOf: async (_t: string, u: string) => ROLES[u] ?? null } },
    identity,
  } as unknown as ConsoleDeps)

  const bridge = {
    store: store.store,
    clerk: clerk.clerk,
    engines: new Map([
      [
        "oidc" as const,
        {
          protocol: "oidc" as const,
          pkce: false,
          begin: async () => ({ redirectUrl: "https://idp.acme.test/authorize" }),
        },
      ],
    ]),
    join: async () => "added" as const,
    isExempt: async () => false,
    log,
  }
  const deps: SsoRouteDeps = {
    bridge,
    gate: ssoGate({ store: store.store, clerk: clerk.clerk, log }),
    identify: async () => ({ status: "signed-out" }),
    returnOrigins: ["https://dash.i10.localhost"],
    testEngine: false,
    mayManage: async () => false,
    tenantOfConnection: async () => TENANT,
    setup: {
      links: policy.store,
      identity: identity as unknown as NonNullable<ConsoleDeps["identity"]>,
      bridge,
      returnOrigins: ["https://dash.i10.localhost"],
      take: fixedWindow(null),
      contextSecret: undefined,
      edgeSecret: EDGE_SECRET,
      ...(limits
        ? {
            limits: {
              perLink: { max: limits.perLink ?? 100, windowSeconds: 60 },
              perIp: { max: limits.perIp ?? 100, windowSeconds: 60 },
            },
          }
        : {}),
    },
  }
  const sso = new Hono().route("/sso", createSsoRoutes(deps))

  const admin = (userId: string, method: string, path: string, body?: unknown) =>
    consoleApp.request(path, {
      method,
      headers: { "content-type": "application/json", "x-user": userId },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const link = (
    token: string,
    method: string,
    path = "",
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    sso.request(`/sso/setup/${token}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const make = async (body: unknown = {}) => {
    const res = await admin(
      "user_admin",
      "POST",
      `/identity/connections/${CONNECTION}/setup-links`,
      body,
    )
    expect(res.status).toBe(201)
    return (await res.json()) as { id: string; token: string; expiresAt: string }
  }
  const events = (type: string) => store.events.filter((e) => e.type === type)
  return {
    store,
    policy,
    admin,
    link,
    make,
    events,
    stale: () => (fresh = false),
  }
}

const links = `/identity/connections/${CONNECTION}/setup-links`

describe("making a setup link", () => {
  it("refuses members, stale sessions, and connections past setup", async () => {
    expect((await world().admin("user_m", "POST", links, {})).status).toBe(403)
    const stale = world()
    stale.stale()
    expect((await stale.admin("user_admin", "POST", links, {})).status).toBe(403)
    for (const status of ["active", "disabled"] as const)
      expect(
        (await world({ status }).admin("user_admin", "POST", links, {})).status,
      ).toBe(422)
  })

  it("refuses a life under an hour or over a week, and a contact that is not an address", async () => {
    const w = world()
    for (const body of [
      { expiresInHours: 0 },
      { expiresInHours: 169 },
      { expiresInHours: 1.5 },
      { contactEmail: "not an address" },
      { extra: true },
    ])
      expect((await w.admin("user_admin", "POST", links, body)).status).toBe(422)
    expect(w.policy.links.size).toBe(0)
  })

  it("shows the token once, stores only its hash, and never audits or lists it", async () => {
    const w = world()
    const made = await w.make({ contactEmail: "IT@Acme.test" })
    expect(made.token).toMatch(/^i10_setup_[A-Za-z0-9_-]{43}$/)
    const stored = [...w.policy.links.values()][0]!
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(stored.contactEmail).toBe("it@acme.test")
    expect(new Date(made.expiresAt).getTime() - Date.now()).toBeGreaterThan(
      71 * 3600_000,
    )
    const listed = await (await w.admin("user_admin", "GET", links)).text()
    expect(listed).not.toContain(made.token)
    expect(listed).not.toContain(stored.tokenHash)
    expect(JSON.stringify(w.store.events)).not.toContain(made.token)
    expect(JSON.stringify(w.store.events)).not.toContain(stored.tokenHash)
    expect(w.events("setup_link.created")[0]).toMatchObject({
      actorUserId: "user_admin",
      data: { setupLinkId: made.id },
    })
  })

  it("revokes with a reason only, audited", async () => {
    const w = world()
    const made = await w.make()
    const revoke = `${links}/${made.id}/revoke`
    expect((await w.admin("user_admin", "POST", revoke, {})).status).toBe(422)
    expect((await w.admin("user_m", "POST", revoke, { reason: "done" })).status).toBe(
      403,
    )
    expect(
      (await w.admin("user_admin", "POST", revoke, { reason: "done" })).status,
    ).toBe(200)
    expect(
      (await w.admin("user_admin", "POST", revoke, { reason: "again" })).status,
    ).toBe(404)
    expect(w.events("setup_link.revoked")[0]).toMatchObject({
      reason: "admin",
      data: { setupLinkId: made.id, note: "done" },
    })
  })
})

describe("using a setup link", () => {
  it("refuses a malformed or unknown token without looking further", async () => {
    const w = world()
    expect((await w.link("nope", "GET")).status).toBe(404)
    expect((await w.link(`i10_setup_${"x".repeat(43)}`, "GET")).status).toBe(404)
  })

  it("refuses a revoked or expired link, audited as refused", async () => {
    const w = world()
    const made = await w.make()
    await w.admin("user_admin", "POST", `${links}/${made.id}/revoke`, {
      reason: "done",
    })
    expect((await w.link(made.token, "GET")).status).toBe(404)
    const other = await w.make()
    w.policy.links.get(other.id)!.expiresAt = new Date(Date.now() - 1)
    expect((await w.link(other.token, "GET")).status).toBe(404)
    expect(w.events("setup_link.refused").map((e) => e.reason)).toEqual([
      "revoked",
      "expired",
    ])
  })

  it("stops serving the moment the connection leaves setup", async () => {
    const w = world()
    const made = await w.make()
    w.store.connections.get(CONNECTION)!.status = "active"
    expect((await w.link(made.token, "GET")).status).toBe(404)
    expect(
      (await w.link(made.token, "PUT", "/oidc", { clientId: "evil" })).status,
    ).toBe(404)
    expect(w.events("setup_link.refused")[0]!.reason).toBe("connection_left_setup")
  })

  it("can never activate, change enforcement, domains or the bypass list", async () => {
    const w = world()
    const made = await w.make()
    for (const [method, path] of [
      ["PATCH", ""],
      ["POST", "/activate"],
      ["PATCH", "/enforcement"],
      ["POST", "/domains"],
      ["POST", "/bypass"],
      ["GET", "/secrets"],
    ] as const)
      expect(
        (await w.link(made.token, method, path, { status: "active" })).status,
      ).toBe(404)
    expect(w.store.connections.get(CONNECTION)!.status).toBe("draft")
  })

  it("is rate limited per link and per address, before the token is looked up", async () => {
    const perLink = world({}, { perLink: 2 })
    const made = await perLink.make()
    await perLink.link(made.token, "GET")
    await perLink.link(made.token, "GET")
    expect((await perLink.link(made.token, "GET")).status).toBe(429)
    const perIp = world({}, { perIp: 1 })
    const ip = { "cf-connecting-ip": "203.0.113.9", ...EDGE_PROOF }
    await perIp.link(`i10_setup_${"x".repeat(43)}`, "GET", "", undefined, ip)
    expect(
      (await perIp.link(`i10_setup_${"y".repeat(43)}`, "GET", "", undefined, ip))
        .status,
    ).toBe(429)
  })

  it("reads the connection's settings and our values, never a secret, and audits first use", async () => {
    const w = world()
    w.store.secrets.set(CONNECTION, { oidc: { clientSecret: "s3cret-value" } })
    const made = await w.make()
    const res = await w.link(made.token, "GET")
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain("s3cret-value")
    expect(JSON.parse(text)).toMatchObject({
      connection: { id: CONNECTION, protocol: "oidc", status: "draft" },
      oidc: {
        redirectUri: "https://auth.i10.localhost/sso/callback",
        clientSecretSet: false,
      },
      saml: null,
    })
    await w.link(made.token, "GET")
    expect(w.events("setup_link.used")).toHaveLength(1)
  })

  it("updates IdP settings with the console's validation, audited as the link", async () => {
    const w = world()
    const made = await w.make()
    expect((await w.link(made.token, "PUT", "/oidc", { clientId: "" })).status).toBe(
      422,
    )
    expect(
      (await w.link(made.token, "PUT", "/oidc", { issuer: "http://idp.acme.test" }))
        .status,
    ).toBe(422)
    const ok = await w.link(made.token, "PUT", "/oidc", { clientId: "client-acme" })
    expect(ok.status).toBe(200)
    expect(w.events("connection.oidc_updated")[0]).toMatchObject({
      actorUserId: null,
      data: { changed: ["clientId"], setupLinkId: made.id },
    })
    const secret = await w.link(made.token, "PUT", "/oidc/secret", {
      clientSecret: "from-the-it-contact",
    })
    expect(secret.status).toBe(200)
    expect(await secret.text()).not.toContain("from-the-it-contact")
    expect(w.events("connection.secret_set")[0]).toMatchObject({
      actorUserId: null,
      data: { setupLinkId: made.id },
    })
    // A SAML route on an OIDC connection does not exist for this link.
    expect((await w.link(made.token, "PUT", "/saml", {})).status).toBe(404)
  })

  it("starts a test run only once the connection is testing", async () => {
    const draft = world()
    const made = await draft.make()
    expect((await draft.link(made.token, "POST", "/test", {})).status).toBe(422)
    expect(
      (await draft.link(made.token, "POST", "/test", { binding: BINDING })).status,
    ).toBe(409)
    const testing = world({ status: "testing" })
    const link = await testing.make()
    const res = await testing.link(link.token, "POST", "/test", {
      binding: BINDING,
      returnTo: "https://evil.test/",
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      redirectUrl: "https://idp.acme.test/authorize",
      protocol: "oidc",
    })
    const attempt = [...testing.store.attempts.values()][0]!
    expect(attempt.purpose).toBe("test_run")
    expect(attempt.returnTo).toBeNull()
    expect(testing.events("setup_link.test_started")).toHaveLength(1)
  })

  it("answers 503, never a pass, when the link cannot be read", async () => {
    const w = world()
    const made = await w.make()
    w.policy.failWith(true)
    expect((await w.link(made.token, "GET")).status).toBe(503)
  })
})
