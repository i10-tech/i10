import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { enforcementGate, strictestFirst } from "../src/identity/enforcement.js"
import { gateReader, startUrlFor } from "../src/identity/middleware.js"
import { ssoGate } from "../src/identity/gate.js"
import type {
  ClerkIdentity,
  EnforcementRead,
  RequiredConnection,
} from "../src/identity/ports.js"
import { requireTenant } from "../src/middleware/tenant.js"
import {
  CONNECTION,
  TENANT,
  log,
  memoryClerk,
  memoryStore,
  user,
} from "./identity-fakes.js"
import { memoryPolicy } from "./identity-policy-fakes.js"

/**
 * Enforcement (#340, sso.md 2.10, decision 7): who a "required" connection
 * covers, the owner exemption and its passkey, the bypass list, what it costs,
 * and that it fails closed.
 */

const T0 = new Date("2026-10-24T10:00:00Z").getTime()
const OTHER = "44444444-4444-4444-8444-444444444444"

const required = (over: Partial<RequiredConnection> = {}): RequiredConnection => ({
  id: CONNECTION,
  enforcement: "required_domain",
  createdAt: new Date(T0 - 86_400_000),
  domains: ["acme.test"],
  bypassed: false,
  ...over,
})

const facts = (
  over: Partial<Extract<EnforcementRead, { required: true }>> = {},
): EnforcementRead => ({
  required: true,
  connections: [required()],
  exemption: true,
  privileged: false,
  managed: false,
  session: null,
  ...over,
})

function world(read: EnforcementRead, users = [user()]) {
  const policy = memoryPolicy({ reads: { [TENANT]: read } })
  const clerk = memoryClerk({ users })
  let clerkReads = 0
  let clerkDown = false
  const counted: Pick<ClerkIdentity, "user"> = {
    user: async (id) => {
      clerkReads++
      if (clerkDown) throw new Error("clerk down")
      return clerk.clerk.user(id)
    },
  }
  let clock = T0
  const warnings: string[] = []
  const gate = enforcementGate({
    store: policy.store,
    clerk: counted,
    log: { ...log, warn: (_o, m) => warnings.push(m) },
    now: () => clock,
  })
  return {
    gate,
    policy,
    clerk,
    warnings,
    check: (userId = "user_ada", sessionId = "sess_1") =>
      gate.check(TENANT, userId, sessionId),
    clerkReads: () => clerkReads,
    clerkDown: (on: boolean) => (clerkDown = on),
    advance: (ms: number) => (clock += ms),
  }
}

describe("a covered member without a bound session", () => {
  it("is refused under required_all, sent to the connection, without asking Clerk", async () => {
    const w = world(facts({ connections: [required({ enforcement: "required_all" })] }))
    expect(await w.check()).toEqual({
      status: "sso_required",
      connectionId: CONNECTION,
    })
    expect(w.clerkReads()).toBe(0)
  })

  it("is refused under required_domain when they hold a verified address on a live domain", async () => {
    const w = world(facts())
    expect(await w.check()).toEqual({
      status: "sso_required",
      connectionId: CONNECTION,
    })
  })

  it("is not covered by required_domain through an unverified address, or another domain", async () => {
    const unverified = world(facts(), [
      user({ emails: [{ id: "e", address: "ada@acme.test", verified: false }] }),
    ])
    expect(await unverified.check()).toEqual({ status: "pass" })
    const elsewhere = world(facts(), [
      user({ emails: [{ id: "e", address: "ada@sub.acme.test", verified: true }] }),
    ])
    expect(await elsewhere.check()).toEqual({ status: "pass" })
  })

  it("is not covered by a required_domain connection with no live domain", async () => {
    const w = world(facts({ connections: [required({ domains: [] })] }))
    expect(await w.check()).toEqual({ status: "pass" })
    expect(w.clerkReads()).toBe(0)
  })

  it("is sent to the strictest covering connection, then the oldest", async () => {
    const w = world(
      facts({
        connections: [
          required({ id: OTHER, createdAt: new Date(T0 - 1000) }),
          required({ enforcement: "required_all", createdAt: new Date(T0) }),
        ],
      }),
    )
    expect(await w.check()).toEqual({
      status: "sso_required",
      connectionId: CONNECTION,
    })
    const sorted = strictestFirst([
      { enforcement: "required_domain" as const, createdAt: new Date(2), id: "b" },
      { enforcement: "required_domain" as const, createdAt: new Date(1), id: "a" },
      { enforcement: "optional" as const, createdAt: new Date(0), id: "c" },
    ])
    expect(sorted.map((r) => r.id)).toEqual(["a", "b", "c"])
  })

  it("is refused when their bound session is past its connection's idle limit", async () => {
    const w = world(
      facts({
        session: {
          boundAt: new Date(T0 - 3_600_000),
          lastSeenAt: new Date(T0 - 3_600_000),
          revokedAt: null,
          maxSessionSeconds: null,
          idleTimeoutSeconds: 600,
        },
      }),
    )
    expect((await w.check()).status).toBe("sso_required")
  })

  it("passes on a session the bridge bound in this workspace", async () => {
    const w = world(
      facts({
        session: {
          boundAt: new Date(T0 - 60_000),
          lastSeenAt: new Date(T0 - 60_000),
          revokedAt: null,
          maxSessionSeconds: null,
          idleTimeoutSeconds: null,
        },
      }),
    )
    expect(await w.check()).toEqual({ status: "pass" })
  })
})

describe("the owner exemption", () => {
  it("answers passkey_required to an exempt owner or admin with no passkey", async () => {
    const w = world(facts({ privileged: true }))
    expect(await w.check()).toEqual({ status: "passkey_required" })
  })

  it("lets an exempt person with a passkey through, and asks Clerk again only after the window", async () => {
    const w = world(facts({ privileged: true }), [user({ passkeyIds: ["pk_1"] })])
    expect(await w.check()).toEqual({ status: "pass" })
    const reads = w.clerkReads()
    await w.check()
    expect(w.clerkReads()).toBe(reads)
  })

  it("never caches 'no passkey': adding one counts at once", async () => {
    const w = world(facts({ privileged: true }))
    expect(await w.check()).toEqual({ status: "passkey_required" })
    w.clerk.users.set("user_ada", user({ passkeyIds: ["pk_1"] }))
    expect(await w.check()).toEqual({ status: "pass" })
  })

  it("does not exempt anybody once two owners turned it off", async () => {
    const w = world(facts({ privileged: true, exemption: false }), [
      user({ passkeyIds: ["pk_1"] }),
    ])
    expect((await w.check()).status).toBe("sso_required")
  })

  it("does not exempt a managed owner: their way in is the link they have", async () => {
    const w = world(facts({ privileged: true, managed: true }), [
      user({ passkeyIds: ["pk_1"] }),
    ])
    expect((await w.check()).status).toBe("sso_required")
  })

  it("asks nothing of an owner the connection does not cover", async () => {
    const w = world(facts({ privileged: true }), [
      user({ emails: [{ id: "e", address: "ada@gmail.test", verified: true }] }),
    ])
    expect(await w.check()).toEqual({ status: "pass" })
  })
})

describe("the bypass list", () => {
  it("refuses somebody listed on only one of two covering connections", async () => {
    const w = world(
      facts({
        connections: [
          required({ bypassed: true }),
          required({ id: OTHER, enforcement: "required_all", bypassed: false }),
        ],
      }),
    )
    expect(await w.check()).toEqual({ status: "sso_required", connectionId: OTHER })
    expect(w.policy.audit).toHaveLength(0)
  })

  it("lets a listed person through and audits the bypass once per session, with a log line", async () => {
    const w = world(facts({ connections: [required({ bypassed: true })] }))
    for (let i = 0; i < 5; i++) expect(await w.check()).toEqual({ status: "pass" })
    expect(w.policy.audit).toEqual([
      { tenantId: TENANT, sessionId: "sess_1", connectionIds: [CONNECTION] },
    ])
    expect(w.warnings).toEqual(["a bypass sign-in passed the SSO requirement"])
    await w.check("user_ada", "sess_2")
    expect(w.policy.audit.map((a) => a.sessionId)).toEqual(["sess_1", "sess_2"])
  })

  it("audits once across processes: a second gate sees the session already noted", async () => {
    const w = world(facts({ connections: [required({ bypassed: true })] }))
    await w.check()
    const second = enforcementGate({ store: w.policy.store, clerk: w.clerk.clerk, log })
    expect(await second.check(TENANT, "user_ada", "sess_1")).toEqual({ status: "pass" })
    expect(w.policy.audit).toHaveLength(1)
  })

  it("refuses with 503 when the bypass cannot be audited", async () => {
    const w = world(facts({ connections: [required({ bypassed: true })] }))
    w.policy.store.noteBypassSignIn = async () => {
      throw new Error("database down")
    }
    expect(await w.check()).toEqual({ status: "unknown" })
  })
})

describe("failing closed", () => {
  it("is unknown when the database cannot be read", async () => {
    const w = world(facts())
    w.policy.failWith(true)
    expect(await w.check()).toEqual({ status: "unknown" })
  })

  it("is unknown when Clerk cannot be asked for addresses or passkeys", async () => {
    const w = world(facts())
    w.clerkDown(true)
    expect(await w.check()).toEqual({ status: "unknown" })
    const owner = world(facts({ privileged: true }))
    owner.clerkDown(true)
    expect(await owner.check()).toEqual({ status: "unknown" })
  })

  it("is unknown when Clerk does not know the signed-in person", async () => {
    const w = world(facts(), [])
    expect(await w.check()).toEqual({ status: "unknown" })
  })

  it("never caches a failure", async () => {
    const w = world(facts({ connections: [required({ enforcement: "required_all" })] }))
    w.policy.failWith(true)
    expect(await w.check()).toEqual({ status: "unknown" })
    w.policy.failWith(false)
    expect((await w.check()).status).toBe("sso_required")
  })
})

describe("what it costs, and how fast a change is seen", () => {
  it("enforces nothing for off and optional, and reads such a workspace once per window", async () => {
    const w = world({ required: false })
    for (let i = 0; i < 20; i++)
      expect(await w.gate.check(TENANT, `user_${i}`, `sess_${i}`)).toEqual({
        status: "pass",
      })
    expect(w.policy.calls.filter((c) => c === "enforcementRead")).toHaveLength(1)
    expect(w.clerkReads()).toBe(0)
    w.advance(15_001)
    await w.check()
    expect(w.policy.calls.filter((c) => c === "enforcementRead")).toHaveLength(2)
  })

  it("sees a change at once after forgetTenant, and within the window without it", async () => {
    const w = world({ required: false })
    expect(await w.check()).toEqual({ status: "pass" })
    w.policy.reads.set(
      TENANT,
      facts({ connections: [required({ enforcement: "required_all" })] }),
    )
    expect(await w.check()).toEqual({ status: "pass" })
    w.gate.forgetTenant(TENANT)
    expect((await w.check()).status).toBe("sso_required")
    w.policy.reads.set(TENANT, { required: false })
    w.advance(10_001)
    expect(await w.check()).toEqual({ status: "pass" })
  })
})

describe("in the middleware", () => {
  const clerk = memoryClerk()
  const managed = ssoGate({ store: memoryStore().store, clerk: clerk.clerk, log })

  function app(read: EnforcementRead, users = [user()]) {
    const policy = memoryPolicy({ reads: { [TENANT]: read } })
    const enforcement = enforcementGate({
      store: policy.store,
      clerk: memoryClerk({ users }).clerk,
      log,
    })
    const reader = gateReader(
      async () => ({ status: "ok", userId: "user_ada", sessionId: "sess_1" }),
      managed,
      startUrlFor("https://auth.i10.localhost"),
      enforcement,
    )
    const a = new Hono()
    a.use("*", async (c, next) => {
      c.set("ssoGate", reader)
      c.set("tenantAuth", {
        sessions: { verify: async () => ({ status: "signed-in", userId: "user_ada" }) },
        tenants: { resolve: async () => TENANT },
      })
      await next()
    })
    a.get("/tenant", requireTenant, (c) => c.text("ok"))
    return (path: string) => a.request(path, { headers: { Authorization: "Bearer x" } })
  }

  it("refuses a covered member with 403 sso_required and the connection's start URL", async () => {
    const res = await app(facts())("/tenant")
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({
      name: "sso_required",
      startUrl: `https://auth.i10.localhost/sso/start?connection=${CONNECTION}`,
    })
  })

  it("refuses an exempt person without a passkey with 403 passkey_required", async () => {
    const res = await app(facts({ privileged: true }))("/tenant")
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ name: "passkey_required" })
  })

  it("answers 503 when enforcement cannot tell", async () => {
    const res = await app(facts(), [])("/tenant")
    expect(res.status).toBe(503)
  })

  it("lets everybody else through", async () => {
    expect((await app({ required: false })("/tenant")).status).toBe(200)
  })
})
