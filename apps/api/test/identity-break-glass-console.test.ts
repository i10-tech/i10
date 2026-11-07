import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { enforcementChange, mountIdentity } from "../src/routes/console/identity.js"
import type { ConsoleDeps } from "../src/routes/console/deps.js"
import type { Role } from "../src/console/roles.js"
import type { Connection } from "../src/identity/model.js"
import {
  CONNECTION,
  TENANT,
  connection,
  log,
  memoryClerk,
  memoryStore,
} from "./identity-fakes.js"
import { memoryPolicy } from "./identity-policy-fakes.js"

/**
 * The console half of #340: "required" needs an owner and a passed test run,
 * the bypass list is trust, and the owner exemption takes two owners to turn
 * off and one to turn on. Every refusal first.
 */

const ROLES: Record<string, Role> = {
  user_owner: "owner",
  user_owner2: "owner",
  user_admin: "admin",
  user_m: "member",
}

function consoleApp(over: Partial<Connection> = {}) {
  const store = memoryStore({
    connections: [connection(over)],
    live: { [CONNECTION]: ["acme.test"] },
  })
  const roles: Record<string, Role> = { ...ROLES }
  const policy = memoryPolicy({ roles })
  let forgotten = 0
  let fresh = true
  const app = new Hono()
  app.use("*", async (c, next) => {
    c.set("auth", { apiKeyId: "", tenantId: TENANT, scopes: [], mode: "live" } as never)
    c.set("user", { userId: c.req.header("x-user") ?? "", orgId: "org_acme" } as never)
    c.set("freshAuth", (async () => ({ status: fresh ? "fresh" : "stale" })) as never)
    await next()
  })
  mountIdentity(app, {
    roles: { store: { roleOf: async (_t: string, u: string) => roles[u] ?? null } },
    identity: {
      store: store.store,
      clerk: memoryClerk().clerk,
      gate: { forget: () => {} },
      protocols: ["test"],
      deprovision: {},
      policy: policy.store,
      enforcement: { forgetTenant: () => forgotten++ },
      log,
    },
  } as unknown as ConsoleDeps)
  const call = (userId: string, method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { "content-type": "application/json", "x-user": userId },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const events = (type: string) => store.events.filter((e) => e.type === type)
  return {
    store,
    policy,
    roles,
    call,
    events,
    forgotten: () => forgotten,
    stale: () => (fresh = false),
    passTestRun: (at = new Date()) =>
      policy.passedRuns.push({ connectionId: CONNECTION, at }),
  }
}

const patch = `/identity/connections/${CONNECTION}`

describe("making a connection required", () => {
  it("refuses an admin setting required on an active connection", async () => {
    const w = consoleApp()
    w.passTestRun()
    const res = await w.call("user_admin", "PATCH", patch, {
      enforcement: "required_all",
    })
    expect(res.status).toBe(403)
    expect(w.store.connections.get(CONNECTION)!.enforcement).toBe("off")
  })

  it("refuses an owner without a test run that passed", async () => {
    const w = consoleApp()
    const res = await w.call("user_owner", "PATCH", patch, {
      enforcement: "required_domain",
    })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { message: string }).message).toContain(
      "passed test run",
    )
  })

  it("refuses an owner whose passed test run is older than a day", async () => {
    const w = consoleApp()
    w.passTestRun(new Date(Date.now() - 25 * 3600_000))
    const res = await w.call("user_owner", "PATCH", patch, {
      enforcement: "required_domain",
    })
    expect(res.status).toBe(422)
  })

  it("refuses an admin activating a draft that already says required", async () => {
    const w = consoleApp({ status: "testing", enforcement: "required_all" })
    w.passTestRun()
    expect(
      (await w.call("user_admin", "PATCH", patch, { status: "active" })).status,
    ).toBe(403)
  })

  it("refuses an owner activating a required connection with no passed test run", async () => {
    const w = consoleApp({ status: "testing", enforcement: "required_all" })
    expect(
      (await w.call("user_owner", "PATCH", patch, { status: "active" })).status,
    ).toBe(422)
    expect(w.store.connections.get(CONNECTION)!.status).toBe("testing")
  })

  it("refuses an admin loosening a live connection's enforcement", async () => {
    const w = consoleApp({ enforcement: "required_all" })
    expect(
      (await w.call("user_admin", "PATCH", patch, { enforcement: "off" })).status,
    ).toBe(403)
    expect(
      (await w.call("user_admin", "PATCH", patch, { enforcement: "required_domain" }))
        .status,
    ).toBe(403)
  })

  it("refuses without step-up", async () => {
    const w = consoleApp()
    w.passTestRun()
    w.stale()
    expect(
      (await w.call("user_owner", "PATCH", patch, { enforcement: "required_all" }))
        .status,
    ).toBe(403)
  })

  it("lets an owner require SSO after a passed test run, audited, and drops the gate's cache", async () => {
    const w = consoleApp()
    w.passTestRun()
    const res = await w.call("user_owner", "PATCH", patch, {
      enforcement: "required_all",
    })
    expect(res.status).toBe(200)
    expect(w.store.connections.get(CONNECTION)!.enforcement).toBe("required_all")
    expect(w.events("connection.updated")[0]).toMatchObject({
      actorUserId: "user_owner",
      data: { to: { enforcement: "required_all" } },
    })
    expect(w.forgotten()).toBe(1)
  })

  it("leaves off to optional on a live connection an admin's, and draft enforcement too", async () => {
    const live = consoleApp()
    expect(
      (await live.call("user_admin", "PATCH", patch, { enforcement: "optional" }))
        .status,
    ).toBe(200)
    const draft = consoleApp({ status: "draft" })
    expect(
      (await draft.call("user_admin", "PATCH", patch, { enforcement: "required_all" }))
        .status,
    ).toBe(200)
  })

  it("says what each change is, as a pure rule", () => {
    expect(
      enforcementChange(
        { status: "active", enforcement: "off" },
        { enforcement: "optional" },
      ),
    ).toEqual({ becomesRequired: false, ownerOnly: false })
    expect(
      enforcementChange(
        { status: "disabled", enforcement: "off" },
        { enforcement: "required_domain" },
      ),
    ).toEqual({ becomesRequired: false, ownerOnly: true })
    expect(
      enforcementChange(
        { status: "disabled", enforcement: "required_all" },
        { status: "active" },
      ),
    ).toEqual({ becomesRequired: true, ownerOnly: true })
    expect(
      enforcementChange({ status: "active", enforcement: "required_all" }, {
        name: "x",
      } as never),
    ).toEqual({ becomesRequired: false, ownerOnly: false })
  })

  it("revokes a connection's setup links when it leaves setup, audited", async () => {
    const w = consoleApp({ status: "testing" })
    await w.policy.store.createSetupLink(TENANT, {
      connectionId: CONNECTION,
      tokenHash: "a".repeat(64),
      contactEmail: null,
      createdBy: "user_admin",
      expiresAt: new Date(Date.now() + 3600_000),
    })
    expect(
      (await w.call("user_admin", "PATCH", patch, { status: "active" })).status,
    ).toBe(200)
    expect([...w.policy.links.values()][0]!.revokedReason).toBe("connection_left_setup")
    expect(w.events("setup_link.revoked")).toHaveLength(1)
  })
})

describe("the bypass list", () => {
  const path = `/identity/connections/${CONNECTION}/bypass`

  it("refuses members, and admins on an active connection", async () => {
    const w = consoleApp()
    expect((await w.call("user_m", "GET", path)).status).toBe(403)
    expect(
      (
        await w.call("user_admin", "POST", path, {
          userId: "user_m",
          reason: "IdP outage",
        })
      ).status,
    ).toBe(403)
    expect(w.policy.bypass.size).toBe(0)
  })

  it("refuses without step-up, without a reason, and for somebody who is not a member", async () => {
    const w = consoleApp({ status: "draft" })
    expect(
      (await w.call("user_admin", "POST", path, { userId: "user_m" })).status,
    ).toBe(422)
    expect(
      (await w.call("user_admin", "POST", path, { userId: "user_m", reason: " " }))
        .status,
    ).toBe(422)
    expect(
      (await w.call("user_admin", "POST", path, { userId: "user_eve", reason: "x" }))
        .status,
    ).toBe(404)
    w.stale()
    expect(
      (await w.call("user_admin", "POST", path, { userId: "user_m", reason: "x" }))
        .status,
    ).toBe(403)
    expect(w.policy.bypass.size).toBe(0)
  })

  it("lets an admin add and remove on a draft, and an owner on an active one, audited", async () => {
    const draft = consoleApp({ status: "draft" })
    const added = await draft.call("user_admin", "POST", path, {
      userId: "user_m",
      reason: "IT break-glass",
    })
    expect(added.status).toBe(201)
    expect(
      (
        await draft.call("user_admin", "POST", path, {
          userId: "user_m",
          reason: "again",
        })
      ).status,
    ).toBe(409)

    const live = consoleApp()
    expect(
      (
        await live.call("user_owner", "POST", path, {
          userId: "user_m",
          reason: "IdP outage",
        })
      ).status,
    ).toBe(201)
    expect(live.events("bypass.added")[0]).toMatchObject({
      actorUserId: "user_owner",
      subjectUserId: "user_m",
      data: { reason: "IdP outage", status: "active" },
    })
    const listed = (await (await live.call("user_admin", "GET", path)).json()) as {
      data: { userId: string }[]
    }
    expect(listed.data.map((r) => r.userId)).toEqual(["user_m"])
    expect((await live.call("user_admin", "DELETE", `${path}/user_m`)).status).toBe(403)
    expect((await live.call("user_owner", "DELETE", `${path}/user_m`)).status).toBe(200)
    expect((await live.call("user_owner", "DELETE", `${path}/user_m`)).status).toBe(404)
    expect(live.events("bypass.removed")).toHaveLength(1)
    expect(live.forgotten()).toBe(2)
  })
})

describe("the owner exemption", () => {
  const base = "/identity/owner-exemption"

  it("refuses admins anything but reading it", async () => {
    const w = consoleApp()
    expect((await w.call("user_admin", "GET", base)).status).toBe(200)
    for (const [method, path] of [
      ["POST", `${base}/off-request`],
      ["POST", `${base}/off-request/approve`],
      ["DELETE", `${base}/off-request`],
      ["POST", `${base}/on`],
    ] as const)
      expect((await w.call("user_admin", method, path)).status).toBe(403)
    expect((await w.call("user_m", "GET", base)).status).toBe(403)
  })

  it("refuses the requesting owner approving their own request", async () => {
    const w = consoleApp()
    expect((await w.call("user_owner", "POST", `${base}/off-request`)).status).toBe(202)
    expect(
      (await w.call("user_owner", "POST", `${base}/off-request/approve`)).status,
    ).toBe(403)
    expect((await w.policy.store.ownerExemption(TENANT, new Date())).enabled).toBe(true)
  })

  it("refuses an approval with no request, a second request, and one older than a day", async () => {
    const w = consoleApp()
    expect(
      (await w.call("user_owner2", "POST", `${base}/off-request/approve`)).status,
    ).toBe(409)
    await w.call("user_owner", "POST", `${base}/off-request`)
    expect((await w.call("user_owner2", "POST", `${base}/off-request`)).status).toBe(
      409,
    )
    w.policy.settings.set(TENANT, {
      enabled: true,
      requestedBy: "user_owner",
      requestedAt: new Date(Date.now() - 25 * 3600_000),
    })
    expect(
      (await w.call("user_owner2", "POST", `${base}/off-request/approve`)).status,
    ).toBe(409)
  })

  it("refuses an approval of a request whose maker is no longer an owner", async () => {
    const w = consoleApp()
    await w.call("user_owner", "POST", `${base}/off-request`)
    w.policy.roles.set("user_owner", "admin")
    expect(
      (await w.call("user_owner2", "POST", `${base}/off-request/approve`)).status,
    ).toBe(409)
  })

  it("refuses without step-up", async () => {
    const w = consoleApp()
    w.stale()
    expect((await w.call("user_owner", "POST", `${base}/off-request`)).status).toBe(403)
  })

  it("turns off with two owners, back on with one, every step audited", async () => {
    const w = consoleApp()
    const asked = await w.call("user_owner", "POST", `${base}/off-request`)
    expect(
      ((await asked.json()) as { pending: { requestedBy: string } }).pending,
    ).toMatchObject({ requestedBy: "user_owner" })
    const applied = await w.call("user_owner2", "POST", `${base}/off-request/approve`)
    expect(applied.status).toBe(200)
    expect(await applied.json()).toEqual({ enabled: false, pending: null })
    expect((await w.call("user_owner", "POST", `${base}/off-request`)).status).toBe(409)
    expect((await w.call("user_owner", "POST", `${base}/on`)).status).toBe(200)
    expect((await w.policy.store.ownerExemption(TENANT, new Date())).enabled).toBe(true)
    expect(w.events("owner_exemption.off_requested")[0]!.actorUserId).toBe("user_owner")
    expect(w.events("owner_exemption.disabled")[0]).toMatchObject({
      actorUserId: "user_owner2",
      data: { requestedBy: "user_owner" },
    })
    expect(w.events("owner_exemption.enabled")).toHaveLength(1)
    expect(w.forgotten()).toBe(2)
  })

  it("lets any owner withdraw a request", async () => {
    const w = consoleApp()
    await w.call("user_owner", "POST", `${base}/off-request`)
    expect((await w.call("user_owner2", "DELETE", `${base}/off-request`)).status).toBe(
      200,
    )
    expect((await w.call("user_owner2", "DELETE", `${base}/off-request`)).status).toBe(
      404,
    )
    expect(w.events("owner_exemption.off_withdrawn")).toHaveLength(1)
  })
})
