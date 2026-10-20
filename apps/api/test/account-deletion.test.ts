import { describe, expect, it } from "bun:test"
import { createApp } from "../src/app.js"
import {
  listNames,
  soleOwnerMessage,
  type AccountDeps,
} from "../src/console/account-deletion.js"
import type { ClerkMemberships, RoleRow } from "../src/console/roles.js"
import type { FreshAuthReader } from "../src/middleware/session.js"
import type { ConsoleDeps } from "../src/routes/console.js"
import { ACME, row, rolesDeps } from "./role-fixtures.js"

/**
 * Deleting the whole account through our API (#336): behind step-up, refused
 * while the person is the only owner of a workspace with other members, a
 * ghost co-owner not counted, Clerk's failures refused with 503, an account
 * already gone treated as deleted.
 */

const BEARER = { Authorization: "Bearer stub" }
const fresh: FreshAuthReader = async () => ({ status: "fresh" })
const stale: FreshAuthReader = async () => ({ status: "stale" })
const BETA = { tenantId: "t_beta", orgId: "org_beta" }

interface Setup {
  freshAuth?: FreshAuthReader
  /** Rows per tenant; ACME by default. */
  rows?: Record<string, RoleRow[]>
  /** Members per Clerk organization. */
  members?: Record<string, number>
  clerk?: Partial<ClerkMemberships>
  accounts?: Partial<AccountDeps>
  workspace?: boolean
}

async function deletion(userId: string, setup: Setup = {}) {
  const tables = setup.rows ?? { [ACME.tenantId]: [row(userId, "owner")] }
  const r = rolesDeps({
    rows: tables[ACME.tenantId] ?? [],
    clerk: setup.clerk,
    tenants: { [ACME.orgId]: ACME.tenantId, [BETA.orgId]: BETA.tenantId },
  })
  for (const [tenantId, rows] of Object.entries(tables)) {
    if (tenantId === ACME.tenantId) continue
    await r.d.store.transact(tenantId, () => ({
      writes: rows.map((put) => ({ put })),
      result: null,
    }))
  }
  const removed: string[] = []
  const names: Record<string, string> = { [ACME.orgId]: "Acme", [BETA.orgId]: "Beta" }
  const accounts: AccountDeps = {
    workspaces: async () =>
      Object.keys(setup.members ?? { [ACME.orgId]: 1 }).map((orgId) => ({
        orgId,
        name: names[orgId] ?? orgId,
      })),
    memberCount: async (orgId) => (setup.members ?? { [ACME.orgId]: 1 })[orgId] ?? 0,
    remove: async (id) => {
      removed.push(id)
      return "deleted"
    },
    ...setup.accounts,
  }
  const app = createApp({
    console: {
      sessions: { verify: async () => ({ status: "signed-in", userId }) },
      tenants: {
        resolve: async () => (setup.workspace === false ? null : ACME.tenantId),
      },
      activeOrg: async () =>
        setup.workspace === false
          ? { status: "personal" as const }
          : { status: "org" as const, orgId: ACME.orgId },
      freshAuth: setup.freshAuth ?? fresh,
      roles: r.d,
      accounts,
      queries: {} as ConsoleDeps["queries"],
      usage: {} as ConsoleDeps["usage"],
      onboarding: {} as ConsoleDeps["onboarding"],
      profile: {} as ConsoleDeps["profile"],
      marketing: {} as ConsoleDeps["marketing"],
      log: { error: () => {}, warn: () => {} },
    },
  })
  const res = await app.request("/console/me/account", {
    method: "DELETE",
    headers: BEARER,
  })
  return { res, removed, logged: r.logged, rows: r.rows }
}

describe("DELETE /console/me/account", () => {
  it("asks for the step-up first, with Clerk's hint, and deletes nothing", async () => {
    const t = await deletion("user_ada", { freshAuth: stale })
    expect(t.res.status).toBe(403)
    expect(await t.res.json()).toMatchObject({
      clerk_error: { reason: "reverification-error" },
    })
    expect(t.removed).toEqual([])
  })

  it("deletes a person who is the only member of their workspaces, and audits it", async () => {
    const t = await deletion("user_ada", { members: { [ACME.orgId]: 1 } })
    expect(t.res.status).toBe(200)
    expect(await t.res.json()).toEqual({ deleted: true })
    expect(t.removed).toEqual(["user_ada"])
    expect(t.logged).toMatchObject([
      { o: { audit: "account.deleted", actorUserId: "user_ada", outcome: "deleted" } },
    ])
  })

  it("works with no workspace open", async () => {
    const t = await deletion("user_ada", { workspace: false })
    expect(t.res.status).toBe(200)
    expect(t.removed).toEqual(["user_ada"])
  })

  it("deletes a member, or an owner with another real owner", async () => {
    const member = await deletion("user_ada", {
      rows: { [ACME.tenantId]: [row("user_bo", "owner"), row("user_ada", "member")] },
      members: { [ACME.orgId]: 2 },
    })
    expect(member.res.status).toBe(200)
    const coOwned = await deletion("user_ada", {
      rows: { [ACME.tenantId]: [row("user_ada", "owner"), row("user_bo", "owner")] },
      members: { [ACME.orgId]: 3 },
    })
    expect(coOwned.res.status).toBe(200)
    expect(coOwned.removed).toEqual(["user_ada"])
  })

  it("refuses the only owner of workspaces with other members, naming them", async () => {
    const t = await deletion("user_ada", {
      rows: {
        [ACME.tenantId]: [row("user_ada", "owner"), row("user_m", "member")],
        [BETA.tenantId]: [row("user_ada", "owner"), row("user_n", "admin")],
      },
      members: { [ACME.orgId]: 2, [BETA.orgId]: 2 },
    })
    expect(t.res.status).toBe(409)
    expect(await t.res.json()).toEqual({
      statusCode: 409,
      name: "sole_owner",
      message: "Make someone else an owner of Acme and Beta, or delete them, first.",
      workspaces: ["Acme", "Beta"],
    })
    expect(t.removed).toEqual([])
  })

  it("does not count a deleted co-owner as another owner, and prunes the ghost", async () => {
    const t = await deletion("user_ada", {
      rows: {
        [ACME.tenantId]: [
          row("user_ada", "owner"),
          row("user_ghost", "owner"),
          row("user_m", "member"),
        ],
      },
      members: { [ACME.orgId]: 2 },
      clerk: { stillMember: async (_o, userId) => userId !== "user_ghost" },
    })
    expect(t.res.status).toBe(409)
    expect(await t.res.json()).toMatchObject({ workspaces: ["Acme"] })
    expect(t.rows().map((r) => r.userId)).not.toContain("user_ghost")
    expect(t.removed).toEqual([])
  })

  it("refuses with 503 when Clerk cannot be asked, at any step", async () => {
    const down = () => Promise.reject(new Error("clerk 502"))
    const owned = {
      rows: { [ACME.tenantId]: [row("user_ada", "owner"), row("user_bo", "owner")] },
      members: { [ACME.orgId]: 2 },
    }
    for (const setup of [
      { accounts: { workspaces: down } },
      { ...owned, accounts: { memberCount: down } },
      { ...owned, clerk: { stillMember: down } },
    ] as Setup[]) {
      const t = await deletion("user_ada", setup)
      expect(t.res.status).toBe(503)
      expect(await t.res.json()).toMatchObject({ name: "service_unavailable" })
      expect(t.removed).toEqual([])
    }
  })

  it("counts an account already gone at Clerk as deleted", async () => {
    const t = await deletion("user_ada", {
      accounts: { remove: async () => "already_gone" },
    })
    expect(t.res.status).toBe(200)
    expect(t.logged).toMatchObject([{ o: { outcome: "already_gone" } }])
  })
})

describe("the refusal's wording", () => {
  it("lists one, two and three workspaces", () => {
    expect(listNames(["Acme"])).toBe("Acme")
    expect(listNames(["Acme", "Beta", "Gamma"])).toBe("Acme, Beta and Gamma")
    expect(soleOwnerMessage(["Acme"])).toBe(
      "Make someone else an owner of Acme, or delete it, first.",
    )
  })
})
