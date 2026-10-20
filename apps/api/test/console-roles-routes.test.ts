import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { createApp } from "../src/app.js"
import { mountTeam } from "../src/routes/console/team.js"
import type { ConsoleDeps } from "../src/routes/console.js"
import type { FreshAuthReader } from "../src/middleware/session.js"
import {
  createWorkspace,
  releaseMember,
  type ClerkMemberships,
  type RoleRow,
} from "../src/console/roles.js"
import { deps as teamDeps } from "./team-access-fixtures.js"
import { ACME, row, rolesDeps } from "./role-fixtures.js"

/**
 * The console's role routes (#335): the codes the Team page branches on, who
 * may give what, the last owner kept, workspace deletion for owners only and
 * behind step-up, and the logo through our API.
 */

const call = (app: Hono, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

const TEAM: RoleRow[] = [
  row("user_owner", "owner"),
  row("user_admin", "admin"),
  row("user_m", "member"),
]

function teamApp(
  userId: string,
  rows: RoleRow[] = TEAM,
  clerk: Partial<ClerkMemberships> = {},
) {
  const r = rolesDeps({ rows, clerk })
  const t = teamDeps([], {
    can: async () => true,
    release: (tenantId, orgId, actorUserId, memberUserId) =>
      releaseMember(r.d, { tenantId, orgId, actorUserId, userId: memberUserId }),
  })
  const app = new Hono()
  app.use("*", async (c, next) => {
    c.set("auth", { apiKeyId: "", tenantId: ACME.tenantId, scopes: [], mode: "live" })
    c.set("user", { userId, orgId: ACME.orgId })
    c.set("freshAuth", async () => ({ status: "fresh" }) as never)
    await next()
  })
  mountTeam(app, { teamDomains: t.d, roles: r.d } as unknown as ConsoleDeps)
  return { app, r, t }
}

describe("GET /team/roles", () => {
  it("lists every role and the reader's own access", async () => {
    const { app } = teamApp("user_admin")
    expect(await (await call(app, "GET", "/team/roles")).json()).toEqual({
      data: [
        { user_id: "user_owner", role: "owner" },
        { user_id: "user_admin", role: "admin" },
        { user_id: "user_m", role: "member" },
      ],
      me: {
        role: "admin",
        permissions: [
          "members:manage",
          "access_domains:manage",
          "roles:manage",
          "workspace:manage",
          "sso:manage",
        ],
        grantable: ["admin", "member"],
        invitable: ["member", "admin"],
      },
    })
  })
})

describe("PUT /team/members/:userId/role", () => {
  const put = (userId: string, target: string, role: unknown) =>
    call(teamApp(userId).app, "PUT", `/team/members/${target}/role`, { role })

  it("an admin makes a member an admin", async () => {
    const res = await put("user_admin", "user_m", "admin")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ user_id: "user_m", role: "admin" })
  })
  it("a member changes nobody's: 403", async () => {
    expect((await put("user_m", "user_m", "admin")).status).toBe(403)
  })
  it("an admin cannot make or unmake an owner: 403 with why", async () => {
    const made = await put("user_admin", "user_m", "owner")
    expect(made.status).toBe(403)
    expect(((await made.json()) as { message: string }).message).toBe(
      "Only an owner can make or remove owners.",
    )
    expect((await put("user_admin", "user_owner", "member")).status).toBe(403)
  })
  it("an owner makes an owner", async () => {
    expect((await put("user_owner", "user_admin", "owner")).status).toBe(200)
  })
  it("the last owner stepping down: 409 last_owner", async () => {
    const res = await put("user_owner", "user_owner", "admin")
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ name: "last_owner" })
  })
  it("an unknown role: 422", async () => {
    expect(
      (await put("user_owner", "user_m", "org:sys_memberships:manage")).status,
    ).toBe(422)
  })
})

describe("POST /team/leave", () => {
  it("refuses the only owner with 409 and a reason", async () => {
    const res = await call(teamApp("user_owner").app, "POST", "/team/leave")
    expect(res.status).toBe(409)
    expect(((await res.json()) as { message: string }).message).toMatch(/only owner/)
  })
  it("answers 503 when the other owner cannot be confirmed with Clerk", async () => {
    const { app, r } = teamApp("user_owner", [...TEAM, row("user_o2", "owner")], {
      stillMember: async () => {
        throw new Error("clerk 503")
      },
    })
    const res = await call(app, "POST", "/team/leave")
    expect(res.status).toBe(503)
    expect(r.calls.removed).toEqual([])
  })
  it("lets anybody else go", async () => {
    const { app, r } = teamApp("user_m")
    expect((await call(app, "POST", "/team/leave")).status).toBe(200)
    expect(r.calls.removed).toEqual(["user_m"])
  })
})

describe("POST /team/members/:userId/remove", () => {
  it("an admin cannot remove an owner, and nothing is listed or removed", async () => {
    const { app, t } = teamApp("user_admin")
    const res = await call(app, "POST", "/team/members/user_owner/remove", {
      block: false,
    })
    expect(res.status).toBe(403)
    expect(t.removed).toEqual([])
    expect(t.exclusions.size).toBe(0)
  })
  it("an owner can", async () => {
    const { app, t, r } = teamApp("user_owner", [...TEAM, row("user_o2", "owner")])
    const res = await call(app, "POST", "/team/members/user_o2/remove", {
      block: false,
    })
    expect(res.status).toBe(200)
    expect(t.removed).toEqual(["user_o2"])
    expect(r.rows().some((x) => x.userId === "user_o2")).toBe(false)
  })
})

// ── Through the whole console: step-up, the body limit, /me ────────────────

const BEARER = { Authorization: "Bearer stub" }
const fresh: FreshAuthReader = async () => ({ status: "fresh" })
const stale: FreshAuthReader = async () => ({ status: "stale" })

function consoleApp(
  userId: string,
  freshAuth: FreshAuthReader = fresh,
  opts: { workspace?: boolean; allowed?: boolean } = {},
) {
  const r = rolesDeps({ rows: TEAM })
  const removed: string[] = []
  const logos: { orgId: string; type: string; size: number; by: string }[] = []
  const app = createApp({
    console: {
      sessions: { verify: async () => ({ status: "signed-in", userId }) },
      tenants: {
        resolve: async () => (opts.workspace === false ? null : ACME.tenantId),
      },
      activeOrg: async () =>
        opts.workspace === false
          ? { status: "personal" as const }
          : { status: "org" as const, orgId: ACME.orgId },
      freshAuth,
      roles: r.d,
      organizations: {
        rename: async () => {},
        create: async (by: string, name: string) =>
          opts.allowed === false
            ? ("not_allowed" as const)
            : createWorkspace(r.d, { name, userId: by }),
        remove: async (orgId: string) => {
          removed.push(orgId)
          return "deleted" as const
        },
        setLogo: async (orgId: string, file: Blob, by: string) =>
          void logos.push({ orgId, type: file.type, size: file.size, by }),
        removeLogo: async () => {},
      },
      queries: {} as ConsoleDeps["queries"],
      usage: {
        billing: async () => ({ plan: null }),
      } as unknown as ConsoleDeps["usage"],
      onboarding: { get: async () => null } as unknown as ConsoleDeps["onboarding"],
      profile: { get: async () => null } as unknown as ConsoleDeps["profile"],
      marketing: {} as ConsoleDeps["marketing"],
      log: { error: () => {}, warn: () => {} },
    },
  })
  return { app, removed, logos, logged: r.logged, calls: r.calls }
}

describe("DELETE /console/workspace", () => {
  it("an owner, freshly proved, deletes the organization", async () => {
    const t = consoleApp("user_owner")
    const res = await t.app.request("/console/workspace", {
      method: "DELETE",
      headers: BEARER,
    })
    expect(res.status).toBe(200)
    expect(t.removed).toEqual([ACME.orgId])
    expect(t.logged).toMatchObject([{ o: { audit: "workspace.deleted" } }])
  })
  it("asks for the step-up first, with Clerk's hint", async () => {
    const t = consoleApp("user_owner", stale)
    const res = await t.app.request("/console/workspace", {
      method: "DELETE",
      headers: BEARER,
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({
      clerk_error: { reason: "reverification-error" },
    })
    expect(t.removed).toEqual([])
  })
  it("refuses an admin and a member", async () => {
    for (const who of ["user_admin", "user_m"]) {
      const t = consoleApp(who)
      const res = await t.app.request("/console/workspace", {
        method: "DELETE",
        headers: BEARER,
      })
      expect(res.status).toBe(403)
      expect(t.removed).toEqual([])
    }
  })
})

describe("PUT /console/workspace/logo", () => {
  const upload = (
    app: ReturnType<typeof consoleApp>["app"],
    type: string,
    bytes = new Uint8Array(300 * 1024),
  ) =>
    app.request("/console/workspace/logo", {
      method: "PUT",
      headers: { ...BEARER, "content-type": type },
      body: bytes,
    })

  it("an admin sets it, larger than the JSON limit", async () => {
    const t = consoleApp("user_admin")
    expect((await upload(t.app, "image/png")).status).toBe(200)
    expect(t.logos).toEqual([
      { orgId: ACME.orgId, type: "image/png", size: 300 * 1024, by: "user_admin" },
    ])
  })
  it("a member may not", async () => {
    const t = consoleApp("user_m")
    expect((await upload(t.app, "image/png")).status).toBe(403)
    expect(t.logos).toEqual([])
  })
  it("refuses something that is not an image", async () => {
    expect((await upload(consoleApp("user_admin").app, "text/html")).status).toBe(422)
  })
})

describe("GET /console/me", () => {
  it("says what the reader may do, from our table", async () => {
    const res = await consoleApp("user_admin").app.request("/console/me", {
      headers: BEARER,
    })
    expect(((await res.json()) as { access: unknown }).access).toEqual({
      role: "admin",
      permissions: [
        "members:manage",
        "access_domains:manage",
        "roles:manage",
        "workspace:manage",
        "sso:manage",
      ],
    })
  })
})

describe("POST /console/workspaces", () => {
  const create = (app: ReturnType<typeof consoleApp>["app"], body: unknown) =>
    app.request("/console/workspaces", {
      method: "POST",
      headers: { ...BEARER, "content-type": "application/json" },
      body: JSON.stringify(body),
    })

  it("creates it, demotes the creator in Clerk, with no workspace open", async () => {
    const t = consoleApp("user_new", fresh, { workspace: false })
    const res = await create(t.app, { name: " Acme " })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ organization_id: "org_new_1" })
    expect(t.calls.orgs).toEqual([{ name: "Acme", createdBy: "user_new" }])
    expect(t.calls.demoted).toEqual(["org_new_1:user_new"])
  })
  it("refuses somebody Clerk would not let create one", async () => {
    const t = consoleApp("user_new", fresh, { allowed: false })
    expect((await create(t.app, { name: "Acme" })).status).toBe(403)
    expect(t.calls.orgs).toEqual([])
  })
  it("needs a name", async () => {
    expect((await create(consoleApp("user_new").app, { name: "  " })).status).toBe(422)
  })
})
