import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { mountIdentity } from "../src/routes/console/identity.js"
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

const ROLES: Record<string, Role> = {
  user_owner: "owner",
  user_admin: "admin",
  user_member: "member",
}
const OTHER = "11111111-1111-4111-8111-111111111111"

function appFor(
  over: Partial<Connection> = {},
  options: { fresh?: boolean; otherTenant?: boolean } = {},
) {
  const world = memoryStore({
    connections: [
      connection({
        status: "draft",
        ...over,
        ...(options.otherTenant ? { tenantId: "other-tenant" } : {}),
      }),
    ],
  })
  const app = new Hono()
  let currentUser = "user_owner"
  app.use("*", async (c, next) => {
    c.set("auth", {
      apiKeyId: "",
      tenantId: TENANT,
      scopes: [],
      mode: "live",
    } as never)
    c.set("user", { userId: currentUser, orgId: "org_acme" } as never)
    c.set("freshAuth", (async () =>
      options.fresh === false ? { status: "stale" } : { status: "fresh" }) as never)
    await next()
  })
  mountIdentity(app, {
    roles: {
      store: { roleOf: async (_tenant: string, user: string) => ROLES[user] ?? null },
    },
    identity: {
      store: world.store,
      clerk: memoryClerk().clerk,
      gate: { forget: () => {} },
      protocols: ["test"],
      deprovision: {},
      log,
    },
  } as unknown as ConsoleDeps)
  const call = (userId: string, method: string, path: string) => {
    currentUser = userId
    return app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(path.endsWith("/domains")
        ? { body: JSON.stringify({ joinDomainId: crypto.randomUUID() }) }
        : {}),
    })
  }
  return { world, call, path: `/identity/connections/${CONNECTION}` }
}

describe("delete draft connection console route", () => {
  it("deletes a draft and records its audit event", async () => {
    const w = appFor({ name: "Draft to delete", protocol: "saml", provider: "okta" })
    const response = await w.call("user_owner", "DELETE", w.path)
    expect(response.status).toBe(200)
    expect(w.world.connections.has(CONNECTION)).toBe(false)
    expect(w.world.events).toContainEqual(
      expect.objectContaining({
        type: "connection.deleted",
        actorUserId: "user_owner",
        connectionId: CONNECTION,
        data: { name: "Draft to delete", protocol: "saml", provider: "okta" },
      }),
    )
  })

  it("limits deletion to owners", async () => {
    for (const user of ["user_admin", "user_member"]) {
      const w = appFor()
      expect((await w.call(user, "DELETE", w.path)).status).toBe(403)
      expect(w.world.connections.has(CONNECTION)).toBe(true)
    }
  })

  it("lets an owner without a fresh sign-in delete an unused draft", async () => {
    const stale = appFor({}, { fresh: false })
    expect((await stale.call("user_owner", "DELETE", stale.path)).status).toBe(200)
    expect(stale.world.connections.has(CONNECTION)).toBe(false)
  })

  it("refuses live statuses and used drafts without deleting them", async () => {
    for (const status of ["active", "testing", "disabled"] as const) {
      const w = appFor({ status })
      const response = await w.call("user_owner", "DELETE", w.path)
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ name: "connection_not_draft" })
      expect(w.world.connections.has(CONNECTION)).toBe(true)
    }
    const w = appFor()
    await w.world.store.link(TENANT, {
      connectionId: CONNECTION,
      subject: "subject",
      clerkUserId: "user_used",
      email: "used@example.test",
    })
    const response = await w.call("user_owner", "DELETE", w.path)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ name: "connection_in_use" })
    expect(w.world.connections.has(CONNECTION)).toBe(true)
  })

  it("hides another tenant and unknown ids", async () => {
    const w = appFor({}, { otherTenant: true })
    expect((await w.call("user_owner", "DELETE", w.path)).status).toBe(404)
    expect(
      (await w.call("user_owner", "DELETE", `/identity/connections/${OTHER}`)).status,
    ).toBe(404)
  })

  it("keeps the domain conflict message from the store", async () => {
    const w = appFor()
    w.world.store.addDomain = async () => "taken"
    const response = await w.call("user_owner", "POST", `${w.path}/domains`)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      message: "Another connection covers that domain.",
    })
  })
})
