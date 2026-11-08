import { describe, expect, it } from "bun:test"
import { ssoGate } from "../src/identity/gate.js"
import type { IdentityStore } from "../src/identity/ports.js"
import {
  CONNECTION,
  TENANT,
  connection,
  log,
  memoryClerk,
  memoryStore,
} from "./identity-fakes.js"

/**
 * The gate (#337, sso.md 2.2): who passes, what it costs, and that it fails
 * closed.
 */

const T0 = new Date("2026-10-20T10:00:00Z").getTime()

function world(over: Parameters<typeof connection>[0] = {}) {
  const store = memoryStore({ connections: [connection(over)] })
  const clerk = memoryClerk()
  let clock = T0
  let reads = 0
  let touches = 0
  const counted: IdentityStore = {
    ...store.store,
    gateRead: async (u, s) => {
      reads++
      return store.store.gateRead(u, s)
    },
    touchSession: async (t, s, at) => {
      touches++
      return store.store.touchSession(t, s, at)
    },
  }
  const gate = ssoGate({ store: counted, clerk: clerk.clerk, log, now: () => clock })
  const manage = () =>
    store.managed.set("user_ada", {
      clerkUserId: "user_ada",
      tenantId: TENANT,
      connectionId: CONNECTION,
      reason: "claimed",
      emails: ["ada@acme.test"],
    })
  const bindSession = (sessionId = "sess_1", at = new Date(clock)) =>
    store.store.bindSession(TENANT, {
      sessionId,
      clerkUserId: "user_ada",
      connectionId: CONNECTION,
      identityId: null,
      idpSession: null,
      authTime: at,
      at,
      freshAt: at,
    })
  return {
    gate,
    store,
    clerk,
    manage,
    bindSession,
    advance: (ms: number) => (clock += ms),
    now: () => new Date(clock),
    reads: () => reads,
    touches: () => touches,
  }
}

describe("somebody who is not managed", () => {
  it("passes, and is read once per cache window, never from Clerk", async () => {
    const w = world()
    for (let i = 0; i < 50; i++)
      expect(await w.gate.check("user_bob", `sess_${i}`)).toEqual({ status: "pass" })
    expect(w.reads()).toBe(1)
    w.advance(15_001)
    await w.gate.check("user_bob", "sess_1")
    expect(w.reads()).toBe(2)
    expect(w.clerk.calls).toHaveLength(0)
  })

  it("is unknown (503), not a pass, when the database cannot answer - and that is not cached", async () => {
    const w = world()
    w.store.fail.gateRead = true
    expect(await w.gate.check("user_bob", "sess_1")).toEqual({ status: "unknown" })
    w.store.fail.gateRead = false
    expect(await w.gate.check("user_bob", "sess_1")).toEqual({ status: "pass" })
  })
})

describe("a managed account", () => {
  it("is refused on a session that was never bound (an email-code session)", async () => {
    const w = world()
    w.manage()
    expect(await w.gate.check("user_ada", "sess_email_code")).toEqual({
      status: "sso_required",
      connectionId: CONNECTION,
      reason: "unbound",
    })
  })

  it("does not cache 'unbound', so its first page after binding passes", async () => {
    const w = world()
    w.manage()
    expect((await w.gate.check("user_ada", "sess_1")).status).toBe("sso_required")
    await w.bindSession()
    expect(await w.gate.check("user_ada", "sess_1")).toEqual({ status: "pass" })
  })

  it("passes on a bound session, and caches it", async () => {
    const w = world()
    w.manage()
    await w.bindSession()
    await w.gate.check("user_ada", "sess_1")
    await w.gate.check("user_ada", "sess_1")
    expect(w.reads()).toBe(1)
  })

  it("is refused on a revoked session and on a connection no longer active", async () => {
    const w = world()
    w.manage()
    await w.bindSession()
    await w.store.store.revokeSessionRow(TENANT, "sess_1", "admin", new Date(T0))
    expect((await w.gate.check("user_ada", "sess_1")) as unknown).toMatchObject({
      reason: "revoked",
    })
    const off = world({ status: "disabled" })
    off.manage()
    await off.bindSession()
    expect((await off.gate.check("user_ada", "sess_1")) as unknown).toMatchObject({
      reason: "connection_inactive",
    })
  })

  it("is refused AND revoked past the connection's maximum session length", async () => {
    const w = world({ maxSessionSeconds: 3600 })
    w.manage()
    await w.bindSession()
    w.advance(3600 * 1000 + 1)
    expect((await w.gate.check("user_ada", "sess_1")) as unknown).toMatchObject({
      reason: "max_age",
    })
    expect(w.clerk.calls).toContain("revokeSession:sess_1")
    expect(w.store.sessions.get("sess_1")!.revokedReason).toBe("max_age")
    expect(w.store.events.at(-1)).toMatchObject({
      type: "session.revoked",
      reason: "max_age",
    })
  })

  it("is refused past the idle timeout, and stays refused if Clerk cannot revoke", async () => {
    const w = world({ idleTimeoutSeconds: 600 })
    w.manage()
    await w.bindSession()
    w.clerk.fail.revokeSession = true
    w.advance(600 * 1000 + 1)
    expect((await w.gate.check("user_ada", "sess_1")) as unknown).toMatchObject({
      reason: "idle",
    })
    expect(w.store.sessions.get("sess_1")!.revokedAt).toBeNull()
    expect((await w.gate.check("user_ada", "sess_1")).status).toBe("sso_required")
  })

  it("records it as seen at most once a minute, which keeps it inside the idle timeout", async () => {
    const w = world({ idleTimeoutSeconds: 600 })
    w.manage()
    await w.bindSession()
    for (let i = 0; i < 20; i++) {
      w.advance(5_000)
      expect((await w.gate.check("user_ada", "sess_1")).status).toBe("pass")
    }
    // 100 seconds of requests: one write at the minute mark.
    expect(w.touches()).toBe(1)
    for (let i = 0; i < 12; i++) {
      w.advance(550_000)
      w.gate.forget({ userId: "user_ada" })
      expect((await w.gate.check("user_ada", "sess_1")).status).toBe("pass")
    }
  })

  it("answers freshness from fresh_at, ten minutes", async () => {
    const w = world()
    expect(await w.gate.freshness("user_bob", "sess_x")).toEqual({ managed: false })
    w.manage()
    await w.bindSession()
    expect(await w.gate.freshness("user_ada", "sess_1")).toEqual({
      managed: true,
      fresh: true,
    })
    w.advance(10 * 60 * 1000 + 1)
    expect(await w.gate.freshness("user_ada", "sess_1")).toEqual({
      managed: true,
      fresh: false,
    })
    expect(await w.gate.freshness("user_ada", "sess_unbound")).toEqual({
      managed: true,
      fresh: false,
    })
  })

  it("refuses a bound session once its connection covers no live domain (displacement)", async () => {
    const w = world()
    w.manage()
    await w.bindSession()
    expect((await w.gate.check("user_ada", "sess_1")).status).toBe("pass")
    w.store.live[CONNECTION] = []
    w.gate.forget({ sessionId: "sess_1" })
    expect(await w.gate.check("user_ada", "sess_1")).toMatchObject({
      status: "sso_required",
      reason: "connection_inactive",
    })
  })

  it("sees a step-up at once, even with the session's read still cached", async () => {
    const w = world()
    w.manage()
    await w.bindSession()
    w.advance(10 * 60 * 1000 + 1)
    // Cache the bound read through the gate, then step up behind its back.
    expect((await w.gate.check("user_ada", "sess_1")).status).toBe("pass")
    expect(await w.gate.freshness("user_ada", "sess_1")).toEqual({
      managed: true,
      fresh: false,
    })
    await w.store.store.setFresh(TENANT, "sess_1", w.now())
    expect(await w.gate.freshness("user_ada", "sess_1")).toEqual({
      managed: true,
      fresh: true,
    })
  })

  it("forgets on request, so a revocation here takes effect at once", async () => {
    const w = world()
    w.manage()
    await w.bindSession()
    expect((await w.gate.check("user_ada", "sess_1")).status).toBe("pass")
    await w.store.store.revokeSessionRow(TENANT, "sess_1", "admin", new Date(T0))
    // Still cached...
    expect((await w.gate.check("user_ada", "sess_1")).status).toBe("pass")
    w.gate.forget({ sessionId: "sess_1" })
    expect((await w.gate.check("user_ada", "sess_1")).status).toBe("sso_required")
  })
})
