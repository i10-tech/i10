import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { mountTeam } from "../src/routes/console/team.js"
import type { ConsoleDeps } from "../src/routes/console/deps.js"
import { NO_TENANT } from "../src/middleware/tenant.js"
import type { JoinRule } from "../src/db/core.js"
import { ACME, deps } from "./team-access-fixtures.js"

/**
 * The team access routes (#326): the status codes the console branches on,
 * and that the person routes read addresses from Clerk, never the body.
 */

const auto: JoinRule[] = [{ pattern: "*.pslhq.app", mode: "auto", role: "org:member" }]

function appWith(
  t: ReturnType<typeof deps>,
  who: { tenantId?: string; orgId?: string; userId?: string } = {},
  person: { verifiedEmails: string[]; createdAt?: number } = {
    verifiedEmails: ["new@dev.pslhq.app"],
    createdAt: Date.now(),
  },
  fresh = true,
) {
  const app = new Hono()
  app.use("*", async (c, next) => {
    c.set("auth", {
      apiKeyId: "",
      tenantId: who.tenantId ?? NO_TENANT,
      scopes: [],
      mode: "live",
    })
    c.set("user", {
      userId: who.userId ?? "user_new",
      ...(who.orgId ? { orgId: who.orgId } : {}),
    })
    c.set("freshAuth", async () => ({ status: fresh ? "fresh" : "stale" }) as never)
    await next()
  })
  mountTeam(app, {
    teamDomains: {
      ...t.d,
      describe: async () => ({ org_acme: { name: "Acme", imageUrl: null } }),
    },
    people: {
      get: async () => ({ name: "N", primaryEmail: null, ...person }),
    },
  } as unknown as ConsoleDeps)
  return app
}

const call = (app: Hono, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

const admin = { tenantId: ACME.tenantId, orgId: ACME.orgId, userId: "user_admin" }

describe("access domain routes", () => {
  it("refuses a free-mail domain with 422", async () => {
    const res = await call(appWith(deps([]), admin), "POST", "/team/access-domains", {
      name: "gmail.com",
      source: "txt",
    })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { message: string }).message).toMatch(
      /email provider/,
    )
  })

  it("answers 403 for somebody who cannot manage domains", async () => {
    const t = deps([], { can: async () => false })
    const res = await call(appWith(t, admin), "POST", "/team/access-domains", {
      name: "acme.com",
      source: "txt",
    })
    expect(res.status).toBe(403)
  })

  it("answers 422 with no workspace", async () => {
    const res = await call(appWith(deps([])), "POST", "/team/access-domains", {
      name: "acme.com",
      source: "txt",
    })
    expect(res.status).toBe(422)
  })

  // Rule validation itself is team-access.test.ts; this is the route's own guard.
  it("answers 404 for rules on an access domain that is not there", async () => {
    const res = await call(
      appWith(deps([]), admin),
      "PUT",
      `/team/access-domains/${crypto.randomUUID()}/rules`,
      {
        rules: [{ pattern: "*.app", mode: "auto", role: "org:member" }],
      },
    )
    expect(res.status).toBe(404)
  })

  it("lists the access domains and the /domains names to suggest", async () => {
    const res = await call(appWith(deps(auto), admin), "GET", "/team/access-domains")
    const body = (await res.json()) as { data: unknown[]; suggested: string[] }
    expect(body.data[0]).toMatchObject({ name: "pslhq.app", status: "verified" })
    expect(body.suggested).toEqual(["notifications.other.app"])
  })
})

describe("person routes", () => {
  it("suggests with the mode, from Clerk's verified addresses", async () => {
    const res = await call(appWith(deps(auto)), "GET", "/me/join-suggestions")
    expect(await res.json()).toEqual({
      data: [
        {
          tenant_id: ACME.tenantId,
          name: "Acme",
          image_url: null,
          domain: "dev.pslhq.app",
          mode: "auto",
          requested: false,
        },
      ],
    })
  })

  it("joins at once with POST /me/joins", async () => {
    const t = deps(auto)
    const res = await call(appWith(t), "POST", "/me/joins", {
      tenant_id: ACME.tenantId,
    })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ joined: true, organization_id: ACME.orgId })
  })

  it("answers 202 and files a request when the workspace is full", async () => {
    const t = deps(auto, { full: true })
    const res = await call(appWith(t), "POST", "/me/joins", {
      tenant_id: ACME.tenantId,
    })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ joined: false, full: true })
    expect(t.requests).toHaveLength(1)
  })

  it("never trusts an address from the body", async () => {
    const t = deps(auto)
    const res = await call(
      appWith(t, {}, { verifiedEmails: ["x@elsewhere.app"], createdAt: Date.now() }),
      "POST",
      "/me/joins",
      { tenant_id: ACME.tenantId, email: "new@dev.pslhq.app" },
    )
    expect(res.status).toBe(422)
    expect(t.added).toEqual([])
  })

  it("auto-joins on arrival only for a new account", async () => {
    const fresh = deps(auto)
    await call(appWith(fresh), "POST", "/me/arrivals")
    expect(fresh.added).toHaveLength(1)

    const old = deps(auto)
    await call(
      appWith(old, {}, { verifiedEmails: ["new@dev.pslhq.app"], createdAt: 0 }),
      "POST",
      "/me/arrivals",
    )
    expect(old.added).toEqual([])
  })
})

describe("member and request routes", () => {
  it("answers 409 workspace_full when accepting into a full workspace", async () => {
    const t = deps([{ pattern: "*.pslhq.app", mode: "suggest", role: "org:member" }], {
      full: true,
    })
    await t.store.fileRequest(ACME.tenantId, {
      userId: "user_new",
      email: "new@dev.pslhq.app",
      via: "*.pslhq.app",
      full: false,
    })
    const res = await call(
      appWith(t, admin),
      "POST",
      `/team/join-requests/${t.requests[0]!.id}`,
      {
        accept: true,
      },
    )
    expect(res.status).toBe(409)
    expect(((await res.json()) as { name: string }).name).toBe("workspace_full")
  })

  it("removing a member needs a fresh session", async () => {
    const t = deps([])
    const res = await call(
      appWith(t, admin, undefined, false),
      "POST",
      "/team/members/user_9/remove",
      {
        block: true,
      },
    )
    expect(res.status).not.toBe(200)
    expect(t.removed).toEqual([])
  })

  it("remove and block", async () => {
    const t = deps([])
    const res = await call(appWith(t, admin), "POST", "/team/members/user_9/remove", {
      block: true,
    })
    expect(res.status).toBe(200)
    expect(t.exclusions.get("gone@pslhq.app")).toBe("blocked")
  })

  it("the lists are for admins only", async () => {
    const t = deps([], { can: async () => false })
    t.exclusions.set("x@pslhq.app", "blocked")
    const res = await call(appWith(t, admin), "GET", "/team/exclusions")
    expect(await res.json()).toEqual({ data: [] })
  })
})
