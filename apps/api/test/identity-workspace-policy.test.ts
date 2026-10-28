import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { mintKey } from "../src/auth/api-key.js"
import { gateReader } from "../src/identity/middleware.js"
import {
  FACTOR_TTL_CEILING_MS,
  effectiveLimits,
  workspaceGate,
  workspaceVerdict,
  type ConsoleRequest,
  type WorkspaceGate,
} from "../src/identity/workspace-policy.js"
import { requireApiKey } from "../src/middleware/auth.js"
import { ssoGateRefusal } from "../src/middleware/session.js"
import {
  CONNECTION,
  OTHER_TENANT,
  TENANT,
  connection,
  log,
  memoryClerk,
  memoryStore,
  user,
} from "./identity-fakes.js"
import { memoryWorkspacePolicy } from "./identity-workspace-fakes.js"

/**
 * The workspace policy gate (#345): the IP allowlist for console and API
 * keys, the session policy, and the second-factor rule. Every refusal first.
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const T0 = Date.parse("2026-10-24T09:00:00Z")
const SESSION = "sess_ada"

const headersFrom = (ip: string | null, extra: Record<string, string> = {}) =>
  new Headers({ ...(ip ? { "cf-connecting-ip": ip } : {}), ...extra })

function gateWorld(
  over: {
    connection?: Parameters<typeof connection>[0]
    users?: Parameters<typeof user>[0][]
    policy?: Parameters<typeof memoryWorkspacePolicy>[1]
    factorTtlMs?: number
  } = {},
) {
  let clock = T0
  const world = memoryStore({
    connections: [connection(over.connection ?? {})],
  })
  const clerk = memoryClerk({
    users: (over.users ?? [{ id: "user_ada" }]).map((u) => user(u)),
  })
  const policy = memoryWorkspacePolicy(world, over.policy)
  const forgotten: { userId?: string; sessionId?: string }[] = []
  const gate = workspaceGate({
    store: policy.store,
    identity: world.store,
    clerk: clerk.clerk,
    forget: (input) => forgotten.push(input),
    contextSecret: undefined,
    log,
    now: () => clock,
    ...(over.factorTtlMs !== undefined ? { factorTtlMs: over.factorTtlMs } : {}),
  })
  /** Clerk's session for `SESSION`, created `ageMs` ago. */
  const clerkSession = (ageMs: number, userId = "user_ada", sid = SESSION) =>
    clerk.clerkSessions.set(sid, {
      id: sid,
      userId,
      clientId: `client_${sid}`,
      status: "active",
      createdAt: new Date(clock - ageMs),
    })
  const request = (over: Partial<ConsoleRequest> = {}): ConsoleRequest => ({
    tenantId: TENANT,
    userId: "user_ada",
    sessionId: SESSION,
    headers: headersFrom("203.0.113.7"),
    method: "GET",
    path: "/console/domains",
    ...over,
  })
  /** An SSO bind of `SESSION`, `ageMs` old and last seen `seenAgoMs` ago. */
  const bind = (ageMs: number, seenAgoMs = 0, sid = SESSION) =>
    world.sessions.set(sid, {
      sessionId: sid,
      tenantId: TENANT,
      clerkUserId: "user_ada",
      connectionId: CONNECTION,
      identityId: null,
      idpSession: null,
      authTime: null,
      boundAt: new Date(clock - ageMs),
      freshAt: new Date(clock - ageMs),
      lastSeenAt: new Date(clock - seenAgoMs),
      revokedAt: null,
      revokedReason: null,
    })
  return {
    world,
    clerk,
    policy,
    gate,
    forgotten,
    clerkSession,
    request,
    bind,
    advance: (ms: number) => (clock += ms),
    events: (type: string) => world.events.filter((e) => e.type === type),
  }
}

describe("the IP allowlist for console sessions", () => {
  const on = (ranges: string[], extra: Record<string, unknown> = {}) => ({
    [TENANT]: {
      network: { console: true, apiKeys: false, ranges, grace: null, ...extra },
    },
  })

  it("refuses an address outside the list and says nothing else", async () => {
    const w = gateWorld({ policy: on(["198.51.100.0/24"]) })
    expect(await w.gate.admit(w.request())).toEqual({ status: "ip_not_allowed" })
    // No session was read or made for a caller the workspace does not admit.
    expect(w.policy.calls).not.toContain("sessionFacts")
  })

  it("refuses when no trustworthy address is known", async () => {
    const w = gateWorld({ policy: on(["203.0.113.0/24"]) })
    expect(await w.gate.admit(w.request({ headers: headersFrom(null) }))).toEqual({
      status: "ip_not_allowed",
    })
    expect(
      await w.gate.admit(w.request({ headers: headersFrom("not-an-ip") })),
    ).toEqual({ status: "ip_not_allowed" })
  })

  it("refuses a forged x-forwarded-for naming a listed address", async () => {
    const w = gateWorld({ policy: on(["203.0.113.0/24"]) })
    const forged = headersFrom("198.51.100.9", { "x-forwarded-for": "203.0.113.7" })
    expect(await w.gate.admit(w.request({ headers: forged }))).toEqual({
      status: "ip_not_allowed",
    })
    const bare = new Headers({ "x-forwarded-for": "203.0.113.7" })
    expect(await w.gate.admit(w.request({ headers: bare }))).toEqual({
      status: "ip_not_allowed",
    })
  })

  it("admits listed IPv4, IPv6 and IPv4-mapped addresses", async () => {
    const w = gateWorld({ policy: on(["203.0.113.0/24", "2001:db8::/32"]) })
    for (const ip of ["203.0.113.7", "2001:db8::42", "::ffff:203.0.113.7"])
      expect(await w.gate.admit(w.request({ headers: headersFrom(ip) }))).toEqual({
        status: "pass",
      })
    for (const ip of ["203.0.114.7", "2001:db9::1", "::ffff:203.0.114.7"])
      expect(await w.gate.admit(w.request({ headers: headersFrom(ip) }))).toEqual({
        status: "ip_not_allowed",
      })
  })

  it("holds API keys to the list only when that switch is on", async () => {
    const w = gateWorld({
      policy: {
        [TENANT]: {
          network: {
            console: true,
            apiKeys: false,
            ranges: ["198.51.100.0/24"],
            grace: null,
          },
        },
      },
    })
    expect(await w.gate.admitApiKey(TENANT, headersFrom("203.0.113.7"))).toEqual({
      status: "pass",
    })
  })

  it("does not apply to a workspace whose switch is off or that has no policy", async () => {
    const off = gateWorld({
      policy: {
        [TENANT]: {
          network: {
            console: false,
            apiKeys: false,
            ranges: ["198.51.100.0/24"],
            grace: null,
          },
        },
      },
    })
    expect(await off.gate.admit(off.request())).toEqual({ status: "pass" })
    const nothing = gateWorld()
    expect(
      await nothing.gate.admit(nothing.request({ headers: headersFrom(null) })),
    ).toEqual({
      status: "pass",
    })
  })

  it("keeps one workspace's list out of another's", async () => {
    const w = gateWorld({ policy: on(["198.51.100.0/24"]) })
    expect(await w.gate.admit(w.request({ tenantId: OTHER_TENANT }))).toEqual({
      status: "pass",
    })
  })

  it("audits a refused address once in a while, not once per request", async () => {
    const w = gateWorld({ policy: on(["198.51.100.0/24"]) })
    for (let i = 0; i < 5; i += 1) await w.gate.admit(w.request())
    expect(w.events("network.ip_denied")).toHaveLength(1)
    expect(w.events("network.ip_denied")[0]).toMatchObject({
      reason: "outside_allowlist",
      data: { surface: "console", address: "203.0.113.7" },
    })
    await w.gate.admit(w.request({ headers: headersFrom("203.0.113.8") }))
    expect(w.events("network.ip_denied")).toHaveLength(2)
    w.advance(6 * MINUTE)
    await w.gate.admit(w.request())
    expect(w.events("network.ip_denied")).toHaveLength(3)
  })

  describe("the saving owner's grace", () => {
    const grace = (over: Record<string, unknown> = {}) =>
      on(["198.51.100.0/24"], {
        grace: {
          userId: "user_ada",
          address: "203.0.113.7",
          until: new Date(T0 + 10 * MINUTE),
          ...over,
        },
      })

    it("lets the saver's own address in until it runs out", async () => {
      const w = gateWorld({ policy: grace() })
      expect(await w.gate.admit(w.request())).toEqual({ status: "pass" })
      w.advance(9 * MINUTE)
      w.gate.forgetTenant(TENANT)
      expect(await w.gate.admit(w.request())).toEqual({ status: "pass" })
      w.advance(2 * MINUTE)
      w.gate.forgetTenant(TENANT)
      expect(await w.gate.admit(w.request())).toEqual({ status: "ip_not_allowed" })
    })

    it("lets in nobody else at that address, and the saver nowhere else", async () => {
      const w = gateWorld({ policy: grace() })
      expect(await w.gate.admit(w.request({ userId: "user_bob" }))).toEqual({
        status: "ip_not_allowed",
      })
      expect(
        await w.gate.admit(w.request({ headers: headersFrom("203.0.113.8") })),
      ).toEqual({ status: "ip_not_allowed" })
    })

    it("does not extend to API keys", async () => {
      const w = gateWorld({
        policy: {
          [TENANT]: {
            network: {
              console: true,
              apiKeys: true,
              ranges: ["198.51.100.0/24"],
              grace: {
                userId: "user_ada",
                address: "203.0.113.7",
                until: new Date(T0 + HOUR),
              },
            },
          },
        },
      })
      expect(await w.gate.admitApiKey(TENANT, headersFrom("203.0.113.7"))).toEqual({
        status: "ip_not_allowed",
      })
    })
  })

  it("answers unknown, never a pass, when the policy cannot be read, and recovers", async () => {
    const w = gateWorld({ policy: on(["203.0.113.0/24"]) })
    w.policy.fail()
    expect(await w.gate.admit(w.request())).toEqual({ status: "unknown" })
    expect(await w.gate.admitApiKey(TENANT, headersFrom("203.0.113.7"))).toEqual({
      status: "unknown",
    })
    w.policy.fail(false)
    expect(await w.gate.admit(w.request())).toEqual({ status: "pass" })
  })

  it("sees a change at once on this process, and a stale list for at most the cache window", async () => {
    const w = gateWorld({ policy: on(["203.0.113.0/24"]) })
    expect(await w.gate.admit(w.request())).toEqual({ status: "pass" })
    w.policy.setNetwork(TENANT, { ranges: ["198.51.100.0/24"] })
    // Another replica's change: still cached here.
    expect(await w.gate.admit(w.request())).toEqual({ status: "pass" })
    w.gate.forgetTenant(TENANT)
    expect(await w.gate.admit(w.request())).toEqual({ status: "ip_not_allowed" })
  })
})

describe("the IP allowlist for API keys", () => {
  const keysOn = {
    [TENANT]: {
      network: {
        console: false,
        apiKeys: true,
        ranges: ["203.0.113.0/24"],
        grace: null,
      },
    },
  }

  it("refuses an address outside the list", async () => {
    const w = gateWorld({ policy: keysOn })
    expect(await w.gate.admitApiKey(TENANT, headersFrom("198.51.100.9"))).toEqual({
      status: "ip_not_allowed",
    })
    expect(w.events("network.ip_denied")[0]).toMatchObject({
      data: { surface: "api_key", address: "198.51.100.9" },
    })
  })

  it("refuses an unknown address", async () => {
    const w = gateWorld({ policy: keysOn })
    expect(await w.gate.admitApiKey(TENANT, headersFrom(null))).toEqual({
      status: "ip_not_allowed",
    })
    expect(w.events("network.ip_denied")[0]).toMatchObject({
      reason: "address_unknown",
    })
  })

  it("admits a listed address, IPv4-mapped too", async () => {
    const w = gateWorld({ policy: keysOn })
    for (const ip of ["203.0.113.200", "::ffff:203.0.113.200"])
      expect(await w.gate.admitApiKey(TENANT, headersFrom(ip))).toEqual({
        status: "pass",
      })
  })

  it("is enforced by requireApiKey: a verified key outside the list gets 403, inside gets through", async () => {
    const minted = mintKey("live")
    const row = {
      id: "key_1",
      tenantId: TENANT,
      scopes: ["emails:send"],
      mode: "live",
      revokedAt: null,
      expiresAt: null,
    }
    const w = gateWorld({ policy: keysOn })
    const app = new Hono()
    app.use("*", async (c, next) => {
      c.set("apiKeyAuth", {
        lookup: { byHash: async () => row },
        cache: { get: async () => null, set: async () => {}, del: async () => {} },
        ttlSeconds: 60,
      })
      c.set("apiKeyNetwork", (tenantId, headers) =>
        w.gate.admitApiKey(tenantId, headers),
      )
      await next()
    })
    app.get("/ping", requireApiKey, (c) => c.text("ok"))
    const call = (ip: string | null) =>
      app.request("/ping", {
        headers: {
          authorization: `Bearer ${minted.secret}`,
          ...(ip ? { "cf-connecting-ip": ip } : {}),
        },
      })
    const outside = await call("198.51.100.9")
    expect(outside.status).toBe(403)
    expect(await outside.json()).toMatchObject({ name: "ip_not_allowed" })
    expect((await call(null)).status).toBe(403)
    expect((await call("203.0.113.7")).status).toBe(200)
    w.policy.fail()
    w.gate.forgetTenant(TENANT)
    const down = await call("203.0.113.7")
    expect(down.status).toBe(503)
    expect(down.headers.get("retry-after")).toBe("5")
  })
})

describe("the session policy", () => {
  const limits = (
    maxSessionSeconds: number | null,
    idleTimeoutSeconds: number | null,
  ) => ({
    [TENANT]: { maxSessionSeconds, idleTimeoutSeconds },
  })

  it("refuses and ends a session past the workspace's maximum", async () => {
    const w = gateWorld({ policy: limits(HOUR / 1000, null) })
    w.clerkSession(61 * MINUTE)
    expect(await w.gate.admit(w.request())).toEqual({
      status: "session_expired",
      reason: "max_age",
    })
    expect(w.clerk.calls).toContain(`revokeSession:${SESSION}`)
    expect(w.policy.activity.get(`${TENANT}:${SESSION}`)!.reason).toBe("max_age")
    expect(w.events("session.revoked")).toHaveLength(1)
    expect(w.events("session.revoked")[0]).toMatchObject({
      sessionId: SESSION,
      reason: "max_age",
      data: { source: "workspace_policy" },
    })
    expect(w.forgotten).toContainEqual({ userId: "user_ada", sessionId: SESSION })
  })

  it("keeps refusing a session it already ended, without asking Clerk again", async () => {
    const w = gateWorld({ policy: limits(HOUR / 1000, null) })
    w.clerkSession(61 * MINUTE)
    await w.gate.admit(w.request())
    const before = w.clerk.calls.length
    w.advance(30_000)
    expect(await w.gate.admit(w.request())).toEqual({
      status: "session_expired",
      reason: "revoked",
    })
    expect(w.clerk.calls.length).toBe(before)
  })

  it("refuses a session idle past the timeout", async () => {
    const w = gateWorld({ policy: limits(null, 600) })
    w.clerkSession(5 * MINUTE)
    expect(await w.gate.admit(w.request())).toEqual({ status: "pass" })
    w.advance(11 * MINUTE)
    w.gate.forgetTenant(TENANT)
    expect(await w.gate.admit(w.request())).toEqual({
      status: "session_expired",
      reason: "idle",
    })
  })

  it("refuses with 503 semantics when Clerk does not know a verified session", async () => {
    const w = gateWorld({ policy: limits(HOUR / 1000, null) })
    expect(await w.gate.admit(w.request())).toEqual({ status: "unknown" })
    w.clerkSession(5 * MINUTE, "user_someone_else")
    expect(await w.gate.admit(w.request())).toEqual({ status: "unknown" })
    expect(w.policy.activity.size).toBe(0)
  })

  it("is refused even when ending the session at Clerk fails", async () => {
    const w = gateWorld({ policy: limits(HOUR / 1000, null) })
    w.clerkSession(2 * HOUR)
    w.clerk.fail.revokeSession = true
    expect(await w.gate.admit(w.request())).toEqual({
      status: "session_expired",
      reason: "max_age",
    })
    // Nothing was marked revoked behind Clerk's back, so the next request revokes again.
    expect(w.policy.activity.get(`${TENANT}:${SESSION}`)!.revokedAt).toBeNull()
    w.clerk.fail.revokeSession = false
    w.gate.forgetTenant(TENANT)
    expect((await w.gate.admit(w.request())).status).toBe("session_expired")
    expect(w.clerk.calls).toContain(`revokeSession:${SESSION}`)
  })

  it("lets a session inside both limits through and records that it was seen", async () => {
    const w = gateWorld({ policy: limits(HOUR / 1000, 1800) })
    w.clerkSession(10 * MINUTE)
    expect(await w.gate.admit(w.request())).toEqual({ status: "pass" })
    w.advance(2 * MINUTE)
    w.gate.forgetTenant(TENANT)
    expect(await w.gate.admit(w.request())).toEqual({ status: "pass" })
    w.advance(10 * 1000)
    await w.gate.admit(w.request())
    expect(w.policy.calls.filter((c) => c === "touchActivity")).toHaveLength(1)
    expect(w.policy.activity.get(`${TENANT}:${SESSION}`)!.startedAt.getTime()).toBe(
      T0 - 10 * MINUTE,
    )
  })

  it("costs a workspace with no limits no session read at all", async () => {
    const w = gateWorld()
    expect(await w.gate.admit(w.request())).toEqual({ status: "pass" })
    expect(w.policy.calls).toEqual(["policy"])
  })

  describe("the stricter of the workspace's and the connection's limits wins", () => {
    it("the connection's, when it is stricter", async () => {
      const w = gateWorld({
        connection: { maxSessionSeconds: 1800 },
        policy: limits(HOUR / 1000, null),
      })
      w.bind(45 * MINUTE)
      expect(await w.gate.admit(w.request())).toEqual({
        status: "session_expired",
        reason: "max_age",
      })
      // A bound session's row is the managed gate's, so it is the bind that ends.
      expect(w.world.sessions.get(SESSION)!.revokedReason).toBe("max_age")
    })

    it("the workspace's, when it is stricter", async () => {
      const w = gateWorld({
        connection: { maxSessionSeconds: 8 * 3600 },
        policy: limits(1800, null),
      })
      w.bind(45 * MINUTE)
      expect(await w.gate.admit(w.request())).toEqual({
        status: "session_expired",
        reason: "max_age",
      })
    })

    it("each limit on its own: idle from one side, maximum from the other", async () => {
      const w = gateWorld({
        connection: { idleTimeoutSeconds: 600 },
        policy: limits(HOUR / 1000, null),
      })
      w.bind(20 * MINUTE, 11 * MINUTE)
      expect(await w.gate.admit(w.request())).toEqual({
        status: "session_expired",
        reason: "idle",
      })
    })

    it("a session inside both passes", async () => {
      const w = gateWorld({
        connection: { maxSessionSeconds: 2 * 3600 },
        policy: limits(HOUR / 1000, null),
      })
      w.bind(30 * MINUTE)
      expect(await w.gate.admit(w.request())).toEqual({ status: "pass" })
    })

    it("the pure rule: smaller of two, and a silent side loosens nothing", () => {
      expect(
        effectiveLimits(
          { maxSessionSeconds: 3600, idleTimeoutSeconds: null },
          { maxSessionSeconds: 1800, idleTimeoutSeconds: 300 },
        ),
      ).toEqual({ maxSessionSeconds: 1800, idleTimeoutSeconds: 300 })
      expect(
        effectiveLimits(
          { maxSessionSeconds: 900, idleTimeoutSeconds: 600 },
          { maxSessionSeconds: null, idleTimeoutSeconds: null },
        ),
      ).toEqual({ maxSessionSeconds: 900, idleTimeoutSeconds: 600 })
      expect(
        effectiveLimits({ maxSessionSeconds: null, idleTimeoutSeconds: null }, null),
      ).toEqual({ maxSessionSeconds: null, idleTimeoutSeconds: null })
      const facts = {
        bound: {
          boundAt: new Date(T0 - 45 * MINUTE),
          lastSeenAt: new Date(T0),
          connectionMaxSessionSeconds: 8 * 3600,
          connectionIdleTimeoutSeconds: null,
        },
        activity: null,
      }
      expect(
        workspaceVerdict(
          { maxSessionSeconds: 1800, idleTimeoutSeconds: null },
          facts,
          new Date(T0),
        ),
      ).toBe("max_age")
    })
  })
})

describe("a second factor for members outside SSO", () => {
  const required = { [TENANT]: { requireSecondFactor: true } }
  const withUser = (extra: Parameters<typeof user>[0] = {}) =>
    gateWorld({ policy: required, users: [{ id: "user_ada", ...extra }] })

  it("refuses a member with no second factor", async () => {
    const w = withUser()
    expect(await w.gate.secondFactor(w.request())).toEqual({ status: "mfa_required" })
  })

  it("passes a member who has one (two-factor or an authenticator app)", async () => {
    for (const extra of [{ twoFactorEnabled: true }, { totpEnabled: true }]) {
      const w = withUser(extra)
      expect(await w.gate.secondFactor(w.request())).toEqual({ status: "pass" })
    }
  })

  it("does not count a passkey, a password or a backup code alone", async () => {
    const w = withUser({
      passkeyIds: ["pk_1"],
      passwordEnabled: true,
      backupCodeEnabled: true,
    })
    expect(await w.gate.secondFactor(w.request())).toEqual({ status: "mfa_required" })
  })

  it("ignores a session the IdP bound: no Clerk call, no second factor needed", async () => {
    const w = withUser()
    w.bind(5 * MINUTE)
    expect(await w.gate.secondFactor(w.request())).toEqual({ status: "pass" })
    expect(w.clerk.calls).toEqual([])
  })

  it("does not exempt a bound session that was revoked", async () => {
    const w = withUser()
    w.bind(5 * MINUTE)
    w.world.sessions.get(SESSION)!.revokedAt = new Date(T0)
    expect(await w.gate.secondFactor(w.request())).toEqual({ status: "mfa_required" })
  })

  it("never caches 'no second factor': adding one lets the next request in", async () => {
    const w = withUser()
    expect(await w.gate.secondFactor(w.request())).toEqual({ status: "mfa_required" })
    w.clerk.users.get("user_ada")!.totpEnabled = true
    expect(await w.gate.secondFactor(w.request())).toEqual({ status: "pass" })
  })

  it("believes 'has a second factor' for under a minute, and no longer", async () => {
    const w = withUser({ twoFactorEnabled: true })
    expect((await w.gate.secondFactor(w.request())).status).toBe("pass")
    w.clerk.users.get("user_ada")!.twoFactorEnabled = false
    w.advance(FACTOR_TTL_CEILING_MS - 1)
    expect((await w.gate.secondFactor(w.request())).status).toBe("pass")
    w.advance(2)
    expect(await w.gate.secondFactor(w.request())).toEqual({ status: "mfa_required" })
  })

  it("clamps a longer window to a minute", async () => {
    const w = gateWorld({
      policy: required,
      users: [{ id: "user_ada", twoFactorEnabled: true }],
      factorTtlMs: 60 * HOUR,
    })
    await w.gate.secondFactor(w.request())
    w.clerk.users.get("user_ada")!.twoFactorEnabled = false
    w.advance(FACTOR_TTL_CEILING_MS + 1)
    expect(await w.gate.secondFactor(w.request())).toEqual({ status: "mfa_required" })
  })

  it("leaves a workspace that does not require it alone, with no Clerk call", async () => {
    const w = gateWorld()
    expect(await w.gate.secondFactor(w.request())).toEqual({ status: "pass" })
    expect(w.clerk.calls).toEqual([])
  })

  it("still lets the person leave the workspace, and only that", async () => {
    const w = withUser()
    expect(
      await w.gate.secondFactor(
        w.request({ method: "POST", path: "/console/team/leave" }),
      ),
    ).toEqual({ status: "pass" })
    expect(
      await w.gate.secondFactor(
        w.request({ method: "GET", path: "/console/team/leave" }),
      ),
    ).toEqual({ status: "mfa_required" })
    expect(
      await w.gate.secondFactor(w.request({ path: "/console/team/members/x/leave" })),
    ).toEqual({ status: "mfa_required" })
  })

  it("is a 503, never a pass, when Clerk cannot say or does not know the person", async () => {
    const w = gateWorld({ policy: required, users: [{ id: "user_other" }] })
    expect(await w.gate.secondFactor(w.request())).toEqual({ status: "unknown" })
    w.policy.fail()
    w.gate.forgetTenant(TENANT)
    expect(await w.gate.secondFactor(w.request())).toEqual({ status: "unknown" })
  })

  it("leaves no activity row behind for a workspace that only asks for a second factor", async () => {
    const w = withUser({ twoFactorEnabled: true })
    await w.gate.secondFactor(w.request())
    expect(w.policy.activity.size).toBe(0)
    expect(w.policy.calls).not.toContain("startActivity")
  })
})

describe("the gate reader's order and the responses the middleware gives", () => {
  const ids = async () => ({
    status: "ok" as const,
    userId: "user_ada",
    sessionId: SESSION,
  })
  const checker = { check: async () => ({ status: "pass" as const }) } as never
  const startUrl = (id: string | null) =>
    id ? `https://auth.test/sso/start?c=${id}` : null

  function app(over: {
    workspace?: WorkspaceGate
    enforcement?: { check: () => Promise<unknown> }
  }) {
    const reader = gateReader(
      ids,
      checker,
      startUrl,
      over.enforcement as never,
      over.workspace,
    )
    const a = new Hono()
    a.use("*", async (c, next) => {
      c.set("ssoGate", reader)
      await next()
    })
    a.all(
      "/*",
      async (c) => (await ssoGateRefusal(c, "user_ada", TENANT)) ?? c.text("ok"),
    )
    return a
  }
  const stub = (over: Partial<WorkspaceGate>): WorkspaceGate => ({
    admit: async () => ({ status: "pass" }),
    secondFactor: async () => ({ status: "pass" }),
    admitApiKey: async () => ({ status: "pass" }),
    forgetTenant: () => {},
    ...over,
  })

  it("answers an address outside the allowlist with 403 ip_not_allowed, before SSO is asked", async () => {
    let asked = false
    const a = app({
      workspace: stub({ admit: async () => ({ status: "ip_not_allowed" }) }),
      enforcement: {
        check: async () => {
          asked = true
          return { status: "pass" }
        },
      },
    })
    const res = await a.request("/console/x")
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ name: "ip_not_allowed" })
    expect(asked).toBe(false)
  })

  it("answers an expired session with 401 session_expired and the reason", async () => {
    const a = app({
      workspace: stub({
        admit: async () => ({ status: "session_expired", reason: "idle" }),
      }),
    })
    const res = await a.request("/console/x")
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ name: "session_expired", reason: "idle" })
  })

  it("answers a missing second factor with 403 mfa_required, after SSO enforcement", async () => {
    const order: string[] = []
    const a = app({
      workspace: stub({
        admit: async () => (order.push("admit"), { status: "pass" }),
        secondFactor: async () => (order.push("factor"), { status: "mfa_required" }),
      }),
      enforcement: { check: async () => (order.push("sso"), { status: "pass" }) },
    })
    const res = await a.request("/console/x")
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ name: "mfa_required" })
    expect(order).toEqual(["admit", "sso", "factor"])
  })

  it("tells a covered member to use SSO rather than to add a factor", async () => {
    const a = app({
      workspace: stub({ secondFactor: async () => ({ status: "mfa_required" }) }),
      enforcement: {
        check: async () => ({ status: "sso_required", connectionId: CONNECTION }),
      },
    })
    const res = await a.request("/console/x")
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ name: "sso_required" })
  })

  it("answers 503 when the workspace gate cannot tell", async () => {
    const a = app({ workspace: stub({ admit: async () => ({ status: "unknown" }) }) })
    const res = await a.request("/console/x")
    expect(res.status).toBe(503)
  })

  it("hands the path and method on, so the leave route can be exempted", async () => {
    const seen: ConsoleRequest[] = []
    const a = app({
      workspace: stub({
        secondFactor: async (r) => (seen.push(r), { status: "pass" }),
      }),
    })
    await a.request("/console/team/leave", { method: "POST" })
    expect(seen[0]).toMatchObject({ method: "POST", path: "/console/team/leave" })
  })
})
