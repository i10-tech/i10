import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { mountTeamInboxes } from "../src/routes/console/team-inboxes.js"
import type { ConsoleDeps } from "../src/routes/console/deps.js"
import { onTeamInboxEvent } from "../src/team-inboxes/sync.js"
import { ACME, GLOBEX, people, world } from "./team-inbox-fixtures.js"

/**
 * The team inbox routes: the statuses a session gets back, the visibility rule
 * as the console sees it, and the webhook that keeps membership in step.
 */

function appFor(
  w: ReturnType<typeof world>,
  who: keyof typeof people,
  workspace: { tenantId: string; orgId: string } = ACME,
) {
  const app = new Hono()
  app.use("*", async (c, next) => {
    c.set("auth", {
      apiKeyId: "",
      tenantId: workspace.tenantId,
      scopes: [],
      mode: "live",
    })
    c.set("user", { userId: people[who].userId, orgId: workspace.orgId })
    await next()
  })
  mountTeamInboxes(app, { teamInboxes: w.service } as unknown as ConsoleDeps)
  return app
}

const call = (app: Hono, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

const create = {
  address: "support@acme.test",
  members: ["bob@acme.test", "carol@acme.test"],
}

describe("creating and reading", () => {
  it("lets an admin create one and answers with its members", async () => {
    const w = world()
    const res = await call(appFor(w, "alice"), "POST", "/team-inboxes", create)

    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({
      object: "team_inbox",
      address: "support@acme.test",
      members: [{ address: "bob@acme.test" }, { address: "carol@acme.test" }],
    })
  })

  it("answers 403 to a member who tries to create one", async () => {
    const w = world()
    const res = await call(appFor(w, "bob"), "POST", "/team-inboxes", create)
    expect(res.status).toBe(403)
    expect(w.rows).toHaveLength(0)
  })

  it("lists all of them for an admin and only their own for a member", async () => {
    const w = world()
    await call(appFor(w, "alice"), "POST", "/team-inboxes", create)
    await call(appFor(w, "alice"), "POST", "/team-inboxes", {
      address: "sales@acme.test",
      members: ["carol@acme.test"],
    })

    const names = async (who: keyof typeof people) =>
      (
        (await (await call(appFor(w, who), "GET", "/team-inboxes")).json()) as {
          data: { address: string }[]
        }
      ).data
        .map((i) => i.address)
        .sort()

    expect(await names("alice")).toEqual(["sales@acme.test", "support@acme.test"])
    expect(await names("bob")).toEqual(["support@acme.test"])
    expect(await names("dave")).toEqual([])
  })

  it("answers 404, not 403, to a member who is not in the inbox", async () => {
    const w = world()
    await call(appFor(w, "alice"), "POST", "/team-inboxes", create)

    expect(
      (await call(appFor(w, "bob"), "GET", "/team-inboxes/support@acme.test")).status,
    ).toBe(200)
    expect(
      (await call(appFor(w, "dave"), "GET", "/team-inboxes/support@acme.test")).status,
    ).toBe(404)
    expect(
      (await call(appFor(w, "alice"), "GET", "/team-inboxes/nobody@acme.test")).status,
    ).toBe(404)
    expect(
      (await call(appFor(w, "alice"), "GET", "/team-inboxes/not-an-address")).status,
    ).toBe(404)
  })

  it("answers 422 for a body that is not valid, and 409 for a taken address", async () => {
    const w = world()
    const admin = appFor(w, "alice")

    expect(
      (
        await call(admin, "POST", "/team-inboxes", {
          address: "support@acme.test",
          members: [],
        })
      ).status,
    ).toBe(422)
    expect(
      (await call(admin, "POST", "/team-inboxes", { ...create, address: "nope" }))
        .status,
    ).toBe(422)
    expect(
      (
        await call(admin, "POST", "/team-inboxes", {
          ...create,
          members: ["erin@acme.test"],
        })
      ).status,
    ).toBe(422)

    await call(admin, "POST", "/team-inboxes", create)
    expect((await call(admin, "POST", "/team-inboxes", create)).status).toBe(409)
  })

  it("answers 501 when team inboxes are not configured", async () => {
    const app = new Hono()
    app.use("*", async (c, next) => {
      c.set("auth", { apiKeyId: "", tenantId: ACME.tenantId, scopes: [], mode: "live" })
      c.set("user", { userId: people.alice.userId, orgId: ACME.orgId })
      await next()
    })
    mountTeamInboxes(app, {} as unknown as ConsoleDeps)
    expect((await call(app, "GET", "/team-inboxes")).status).toBe(501)
  })
})

describe("members and deletion", () => {
  it("lets an admin replace the members and a member see the change", async () => {
    const w = world()
    await call(appFor(w, "alice"), "POST", "/team-inboxes", create)

    const res = await call(
      appFor(w, "alice"),
      "PUT",
      "/team-inboxes/support@acme.test/members",
      { members: ["dave@acme.test"] },
    )
    expect(res.status).toBe(200)

    expect(
      (await call(appFor(w, "dave"), "GET", "/team-inboxes/support@acme.test")).status,
    ).toBe(200)
    expect(
      (await call(appFor(w, "bob"), "GET", "/team-inboxes/support@acme.test")).status,
    ).toBe(404)
  })

  it("refuses a member changing the members, and an admin of another workspace", async () => {
    const w = world()
    await call(appFor(w, "alice"), "POST", "/team-inboxes", create)

    const body = { members: ["bob@acme.test"] }
    const path = "/team-inboxes/support@acme.test/members"
    expect((await call(appFor(w, "bob"), "PUT", path, body)).status).toBe(403)
    expect((await call(appFor(w, "zed", GLOBEX), "PUT", path, body)).status).toBe(404)
    expect(w.rows[0]!.members).toHaveLength(2)
  })

  it("deletes for an admin, and the former member then gets 404", async () => {
    const w = world()
    await call(appFor(w, "alice"), "POST", "/team-inboxes", create)

    expect(
      (await call(appFor(w, "bob"), "DELETE", "/team-inboxes/support@acme.test"))
        .status,
    ).toBe(403)
    expect(
      (await call(appFor(w, "alice"), "DELETE", "/team-inboxes/support@acme.test"))
        .status,
    ).toBe(204)
    expect(
      (await call(appFor(w, "bob"), "GET", "/team-inboxes/support@acme.test")).status,
    ).toBe(404)
    expect(
      (await call(appFor(w, "alice"), "DELETE", "/team-inboxes/support@acme.test"))
        .status,
    ).toBe(404)
  })
})

describe("the webhook that follows the workspace", () => {
  const sync = (w: ReturnType<typeof world>) => ({
    inboxes: w.service,
    tenantOf: async (orgId: string) =>
      orgId === ACME.orgId
        ? ACME.tenantId
        : orgId === GLOBEX.orgId
          ? GLOBEX.tenantId
          : null,
    log: { info: () => {} },
  })

  const removed = (orgId: string, userId: string) => ({
    id: "orgmem_1",
    organization: { id: orgId },
    public_user_data: { user_id: userId },
  })

  it("takes a removed member out of the inboxes, so they lose access", async () => {
    const w = world()
    await call(appFor(w, "alice"), "POST", "/team-inboxes", create)

    const outcome = await onTeamInboxEvent(
      sync(w),
      "organizationMembership.deleted",
      removed(ACME.orgId, people.bob.userId),
    )

    expect(outcome).toBe("removed:1")
    expect(
      (await call(appFor(w, "bob"), "GET", "/team-inboxes/support@acme.test")).status,
    ).toBe(404)
    expect(
      (await call(appFor(w, "carol"), "GET", "/team-inboxes/support@acme.test")).status,
    ).toBe(200)
  })

  it("ignores a removal from a workspace we do not know, and other events", async () => {
    const w = world()
    await call(appFor(w, "alice"), "POST", "/team-inboxes", create)

    expect(
      await onTeamInboxEvent(
        sync(w),
        "organizationMembership.deleted",
        removed("org_unknown", people.bob.userId),
      ),
    ).toBeNull()
    expect(
      await onTeamInboxEvent(sync(w), "organizationMembership.created", {}),
    ).toBeNull()
    expect(
      await onTeamInboxEvent(sync(w), "organizationMembership.deleted", {}),
    ).toBeNull()
    expect(w.rows[0]!.members).toHaveLength(2)
  })

  it("removes a deleted workspace's inboxes and their accounts", async () => {
    const w = world()
    await call(appFor(w, "alice"), "POST", "/team-inboxes", create)

    const outcome = await onTeamInboxEvent(sync(w), "organization.deleted", {
      id: ACME.orgId,
      deleted: true,
    })

    expect(outcome).toBe("deleted:1")
    expect(w.rows).toHaveLength(0)
    expect(w.destroyed).toEqual(["support@acme.test"])
  })
})
