import { describe, expect, it, mock } from "bun:test"
import { Hono } from "hono"
import type { AutoForwardingMode } from "@repo/contracts"
import type { AutoForwardingConsoleDeps } from "../src/mailboxes/auto-forwarding.js"
import { mountAutoForwarding } from "../src/routes/console/auto-forwarding.js"
import type { ConsoleDeps } from "../src/routes/console/deps.js"

/**
 * Console HTTP routes for per-workspace automatic forwarding (#526).
 * Refusal order is pinned: role -> step-up -> body validation -> store write.
 */

const TENANT = "3f1a0e00-0000-4000-8000-000000000052"
const people = {
  owner: "user_owner",
  admin: "user_admin",
  member: "user_member",
}

function world(over: { mode?: AutoForwardingMode; wired?: boolean } = {}) {
  let mode: AutoForwardingMode = over.mode ?? "workspace"
  const audit: {
    type: string
    tenantId: string
    actorUserId: string
    before: AutoForwardingMode
    after: AutoForwardingMode
  }[] = []
  const set = mock(
    async (tenantId: string, actor: string, next: AutoForwardingMode) => {
      const before = mode
      mode = next
      audit.push({
        type: "workspace.auto_forwarding_changed",
        tenantId,
        actorUserId: actor,
        before,
        after: next,
      })
      return { before, after: next }
    },
  )
  const forwarding: AutoForwardingConsoleDeps = {
    store: { get: async () => mode, set },
    isAdmin: async (_tenant, userId) =>
      userId === people.owner || userId === people.admin,
  }
  return {
    forwarding,
    set,
    audit,
    mode: () => mode,
    wired: over.wired ?? true,
  }
}

function appFor(w: ReturnType<typeof world>, who: keyof typeof people, fresh = true) {
  const stepUp = mock(async () => ({ status: fresh ? "fresh" : "stale" }))
  const app = new Hono()
  app.use("*", async (c, next) => {
    c.set("auth", { apiKeyId: "", tenantId: TENANT, scopes: [], mode: "live" })
    c.set("user", { userId: people[who], orgId: "org_acme" })
    c.set("freshAuth" as never, stepUp as never)
    await next()
  })
  const deps = (w.wired
    ? { autoForwarding: w.forwarding }
    : {}) as unknown as ConsoleDeps
  mountAutoForwarding(app, deps)
  return { app, stepUp }
}

const call = (app: Hono, method: string, body?: unknown) =>
  app.request("/workspace/auto-forwarding", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

describe("GET /workspace/auto-forwarding", () => {
  it("returns the workspace setting for owners and admins, defaulting to workspace", async () => {
    const w = world()
    for (const who of ["owner", "admin"] as const) {
      const res = await call(appFor(w, who).app, "GET")
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ mode: "workspace" })
    }
  })

  it("refuses a non-admin member with 403", async () => {
    const w = world()
    const res = await call(appFor(w, "member").app, "GET")
    expect(res.status).toBe(403)
    expect(((await res.json()) as { name: string }).name).toBe("forbidden")
  })

  it("answers 501 when not wired", async () => {
    const res = await call(appFor(world({ wired: false }), "owner").app, "GET")
    expect(res.status).toBe(501)
  })
})

describe("PATCH /workspace/auto-forwarding", () => {
  it("lets an owner or admin switch between non-anywhere modes and records audit data", async () => {
    const w = world()
    const r1 = await call(appFor(w, "admin").app, "PATCH", {
      mode: "workspace_and_members",
    })
    expect(r1.status).toBe(200)
    expect(await r1.json()).toEqual({ mode: "workspace_and_members" })

    const r2 = await call(appFor(w, "owner").app, "PATCH", { mode: "off" })
    expect(r2.status).toBe(200)
    expect(await r2.json()).toEqual({ mode: "off" })

    expect(w.audit).toEqual([
      {
        type: "workspace.auto_forwarding_changed",
        tenantId: TENANT,
        actorUserId: people.admin,
        before: "workspace",
        after: "workspace_and_members",
      },
      {
        type: "workspace.auto_forwarding_changed",
        tenantId: TENANT,
        actorUserId: people.owner,
        before: "workspace_and_members",
        after: "off",
      },
    ])
  })

  it("refuses a non-admin with 403 without prompting for step-up or writing", async () => {
    const w = world()
    const { app, stepUp } = appFor(w, "member", false)
    const res = await call(app, "PATCH", { mode: "off" })

    expect(res.status).toBe(403)
    expect(((await res.json()) as { name: string }).name).toBe("forbidden")
    expect(stepUp).not.toHaveBeenCalled()
    expect(w.set).not.toHaveBeenCalled()
  })

  it("asks an admin with a stale session to step up before inspecting the body", async () => {
    const w = world()
    const res = await call(appFor(w, "admin", false).app, "PATCH", {
      mode: "not_a_mode",
    })

    expect(res.status).toBe(403)
    const body = (await res.json()) as {
      name: string
      clerk_error?: { type?: string; reason?: string }
    }
    expect(body.name).toBe("invalid_access")
    expect(body.clerk_error?.type).toBe("forbidden")
    expect(body.clerk_error?.reason).toBe("reverification-error")
    expect(w.set).not.toHaveBeenCalled()
  })

  it("refuses mode=anywhere without explicit confirm_anywhere: true", async () => {
    const w = world()
    const { app } = appFor(w, "owner")

    for (const bad of [
      { mode: "anywhere" },
      { mode: "anywhere", confirm_anywhere: false },
    ]) {
      const res = await call(app, "PATCH", bad)
      expect(res.status).toBe(422)
      expect(((await res.json()) as { name: string }).name).toBe("validation_error")
    }
    expect(w.set).not.toHaveBeenCalled()
    expect(w.mode()).toBe("workspace")
  })

  it("allows mode=anywhere when confirm_anywhere is true", async () => {
    const w = world()
    const res = await call(appFor(w, "admin").app, "PATCH", {
      mode: "anywhere",
      confirm_anywhere: true,
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ mode: "anywhere" })
    expect(w.set).toHaveBeenCalledWith(TENANT, people.admin, "anywhere")
    expect(w.audit).toHaveLength(1)
    expect(w.audit[0]).toMatchObject({
      type: "workspace.auto_forwarding_changed",
      before: "workspace",
      after: "anywhere",
    })
  })

  it("refuses unknown modes and unexpected fields with 422", async () => {
    const w = world()
    const { app } = appFor(w, "admin")

    for (const bad of [
      {},
      { mode: "everyone" },
      { mode: "off", extra: true },
      { mode: 123 },
    ]) {
      const res = await call(app, "PATCH", bad)
      expect(res.status).toBe(422)
    }
    expect(w.set).not.toHaveBeenCalled()
  })

  it("answers 501 when not wired", async () => {
    const res = await call(appFor(world({ wired: false }), "owner").app, "PATCH", {
      mode: "off",
    })
    expect(res.status).toBe(501)
  })
})
