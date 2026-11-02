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

/**
 * The console half of a changed IdP subject and the UPN opt-in (sso.md 2.22):
 * who may set the two connection settings, and the pending-relink routes -
 * list, approve, reject - with their owner rule, step-up and conflict.
 */

const ROLES: Record<string, Role> = {
  user_owner: "owner",
  user_admin: "admin",
  user_m: "member",
}

const MISSING = "99999999-9999-4999-8999-999999999999"
const HOUR = 3_600_000

function consoleApp(over: Partial<Connection> = {}, options: { fresh?: boolean } = {}) {
  const world = memoryStore({ connections: [connection({ status: "draft", ...over })] })
  const fresh = options.fresh ?? true
  const apps = new Map<string, Hono>()
  const as = (userId: string) => {
    const cached = apps.get(userId)
    if (cached) return cached
    const app = new Hono()
    app.use("*", async (c, next) => {
      c.set("auth", {
        apiKeyId: "",
        tenantId: TENANT,
        scopes: [],
        mode: "live",
      } as never)
      c.set("user", { userId, orgId: "org_acme" } as never)
      c.set("freshAuth", (async () =>
        fresh ? { status: "fresh" } : { status: "stale" }) as never)
      await next()
    })
    mountIdentity(app, {
      roles: { store: { roleOf: async (_t: string, u: string) => ROLES[u] ?? null } },
      identity: {
        store: world.store,
        clerk: memoryClerk().clerk,
        gate: { forget: () => {} },
        protocols: ["test"],
        deprovision: {},
        log,
      },
    } as unknown as ConsoleDeps)
    apps.set(userId, app)
    return app
  }
  const call = (userId: string, method: string, path: string, body?: unknown) =>
    as(userId).request(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const events = (type: string) => world.events.filter((e) => e.type === type)
  return { world, call, events, base: `/identity/connections/${CONNECTION}` }
}

describe("the two connection settings", () => {
  it("shows both in the connection view, defaulting to ask and off", async () => {
    const w = consoleApp()
    const res = await w.call("user_admin", "GET", "/identity/connections")
    const [row] = ((await res.json()) as { data: Record<string, unknown>[] }).data
    expect(row).toMatchObject({ relink: "ask", upnAsEmail: false })
  })

  it("lets only an owner change relink, in either direction, on any status", async () => {
    for (const status of ["draft", "active"] as const) {
      const w = consoleApp({ status })
      expect((await w.call("user_admin", "PATCH", w.base, { relink: "auto" })).status).toBe(
        403,
      )
      expect((await w.call("user_m", "PATCH", w.base, { relink: "auto" })).status).toBe(403)
      const res = await w.call("user_owner", "PATCH", w.base, { relink: "auto" })
      expect(res.status).toBe(200)
      expect(((await res.json()) as { relink: string }).relink).toBe("auto")
      expect((await w.call("user_admin", "PATCH", w.base, { relink: "ask" })).status).toBe(
        403,
      )
      expect((await w.call("user_owner", "PATCH", w.base, { relink: "ask" })).status).toBe(
        200,
      )
      const [changed] = w.events("connection.updated")
      expect(changed).toMatchObject({
        actorUserId: "user_owner",
        data: { changed: ["relink"], from: { relink: "ask" }, to: { relink: "auto" } },
      })
    }
  })

  it("lets an admin save a connection that leaves relink as it is", async () => {
    const w = consoleApp({ relink: "auto" })
    expect(
      (await w.call("user_admin", "PATCH", w.base, { relink: "auto", name: "Acme" }))
        .status,
    ).toBe(200)
  })

  it("refuses a relink value that is not ask or auto", async () => {
    const w = consoleApp()
    for (const relink of ["whenever", true, null])
      expect((await w.call("user_owner", "PATCH", w.base, { relink })).status).toBe(422)
  })

  it("needs a fresh sign-in to change them", async () => {
    const w = consoleApp({}, { fresh: false })
    expect((await w.call("user_owner", "PATCH", w.base, { relink: "auto" })).status).not.toBe(
      200,
    )
  })

  it("lets an owner turn the UPN on for Entra only, and refuses it on any other provider", async () => {
    const entra = consoleApp({ provider: "entra", protocol: "oidc" })
    expect(
      (await entra.call("user_admin", "PATCH", entra.base, { upnAsEmail: true })).status,
    ).toBe(403)
    const on = await entra.call("user_owner", "PATCH", entra.base, { upnAsEmail: true })
    expect(on.status).toBe(200)
    expect(((await on.json()) as { upnAsEmail: boolean }).upnAsEmail).toBe(true)

    const okta = consoleApp({ provider: "okta", protocol: "oidc" })
    const refused = await okta.call("user_owner", "PATCH", okta.base, { upnAsEmail: true })
    expect(refused.status).toBe(422)
    expect(await refused.json()).toMatchObject({ code: "upn_not_supported" })
    expect((await okta.call("user_owner", "PATCH", okta.base, { upnAsEmail: "yes" })).status).toBe(
      422,
    )
    // Off is never a problem.
    expect(
      (await okta.call("user_owner", "PATCH", okta.base, { upnAsEmail: false })).status,
    ).toBe(200)
  })
})

describe("pending relinks", () => {
  /** Two linked people and a request to move Ada to a new subject. */
  async function pending(over: Partial<Connection> = {}, options = {}) {
    const w = consoleApp(over, options)
    const ada = await w.world.store.link(TENANT, {
      connectionId: CONNECTION,
      subject: "okta|ada",
      clerkUserId: "user_ada",
      email: "ada@acme.test",
    })
    const bob = await w.world.store.link(TENANT, {
      connectionId: CONNECTION,
      subject: "okta|bob",
      clerkUserId: "user_bob",
      email: "bob@acme.test",
    })
    const now = new Date()
    await w.world.store.requestRelink(TENANT, {
      connectionId: CONNECTION,
      identityId: ada.id,
      newSubject: "okta|ada-renamed",
      emailHash: "h",
      now,
      expiresAt: new Date(now.getTime() + 7 * 24 * HOUR),
    })
    const [request] = w.world.relinks
    return { ...w, ada, bob, request: request!, url: (tail: string) =>
      `${w.base}/relinks/${request!.id}/${tail}` }
  }

  it("lists them for an admin, with who they are and nothing else of the subjects", async () => {
    const w = await pending()
    const res = await w.call("user_admin", "GET", `${w.base}/relinks`)
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as { data: Record<string, unknown>[] }
    expect(data).toHaveLength(1)
    expect(data[0]).toMatchObject({
      id: w.request.id,
      identityId: w.ada.id,
      email: "ada@acme.test",
      clerkUserId: "user_ada",
    })
    expect(JSON.stringify(data)).not.toContain("okta|")
    expect((await w.call("user_m", "GET", `${w.base}/relinks`)).status).toBe(403)
    expect(
      (await w.call("user_admin", "GET", `/identity/connections/${MISSING}/relinks`))
        .status,
    ).toBe(404)
  })

  it("lets an owner approve: the subject moves, the request goes, and it is audited with the approver", async () => {
    const w = await pending()
    const res = await w.call("user_owner", "POST", w.url("approve"))
    expect(res.status).toBe(200)
    expect(w.world.identities.find((i) => i.id === w.ada.id)!.subject).toBe(
      "okta|ada-renamed",
    )
    expect(w.world.relinks).toHaveLength(0)
    const [event] = w.events("identity.relinked")
    expect(event).toMatchObject({
      actorUserId: "user_owner",
      subjectUserId: "user_ada",
      connectionId: CONNECTION,
      data: { identityId: w.ada.id, via: "approval", approvedBy: "user_owner" },
    })
    const logged = JSON.stringify(event)
    for (const secret of ["okta|ada", "ada@acme.test"])
      expect(logged).not.toContain(secret)
    expect((await w.call("user_owner", "POST", w.url("approve"))).status).toBe(404)
  })

  it("refuses everyone but an owner, without moving anything", async () => {
    const w = await pending()
    for (const who of ["user_admin", "user_m"]) {
      expect((await w.call(who, "POST", w.url("approve"))).status).toBe(403)
      expect((await w.call(who, "POST", w.url("reject"))).status).toBe(403)
    }
    expect(w.world.identities.find((i) => i.id === w.ada.id)!.subject).toBe("okta|ada")
    expect(w.world.relinks).toHaveLength(1)
    expect(w.events("identity.relinked")).toHaveLength(0)
  })

  it("needs a fresh sign-in", async () => {
    const w = await pending({}, { fresh: false })
    expect((await w.call("user_owner", "POST", w.url("approve"))).status).not.toBe(200)
    expect(w.world.identities.find((i) => i.id === w.ada.id)!.subject).toBe("okta|ada")
  })

  it("answers 409 when the new subject is already somebody else's, and keeps the request", async () => {
    const w = await pending()
    // Bob is, meanwhile, linked under the subject the request would give Ada.
    w.world.identities.find((i) => i.id === w.bob.id)!.subject = "okta|ada-renamed"
    const res = await w.call("user_owner", "POST", w.url("approve"))
    expect(res.status).toBe(409)
    expect(w.world.identities.find((i) => i.id === w.ada.id)!.subject).toBe("okta|ada")
    expect(w.world.relinks).toHaveLength(1)
    expect(w.events("identity.relinked")).toHaveLength(0)
  })

  it("lets an owner reject: the request is deleted and the rejection audited", async () => {
    const w = await pending()
    expect((await w.call("user_owner", "POST", w.url("reject"))).status).toBe(200)
    expect(w.world.relinks).toHaveLength(0)
    expect(w.world.identities.find((i) => i.id === w.ada.id)!.subject).toBe("okta|ada")
    expect(w.events("identity.relink_rejected")[0]).toMatchObject({
      actorUserId: "user_owner",
      data: { identityId: w.ada.id, rejectedBy: "user_owner" },
    })
    expect((await w.call("user_owner", "POST", w.url("reject"))).status).toBe(404)
  })

  it("does not find a request through another connection or a malformed id", async () => {
    const w = await pending()
    const other = `/identity/connections/${MISSING}/relinks/${w.request.id}/approve`
    expect((await w.call("user_owner", "POST", other)).status).toBe(404)
    expect(
      (await w.call("user_owner", "POST", `${w.base}/relinks/not-a-uuid/approve`)).status,
    ).toBe(404)
    expect(w.world.relinks).toHaveLength(1)
  })
})
