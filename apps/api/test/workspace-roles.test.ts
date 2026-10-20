import { describe, expect, test } from "bun:test"
import {
  JOIN_ROLES,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  accessOf,
  addMember,
  can,
  changeRole,
  createWorkspace,
  grantable,
  invitable,
  leaveWorkspace,
  may,
  mayCreateWorkspace,
  onClerkEvent,
  parseJoinRole,
  parseRole,
  readJoinRole,
  readRole,
  releaseMember,
  seedOwner,
  setRole,
  type RoleRow,
} from "../src/console/roles.js"
import { ACME, memoryRoles, row, rolesDeps } from "./role-fixtures.js"

/**
 * Workspace roles (#335): the map, the checks against our table, every path
 * that keeps it in step with Clerk - in any order and redelivered - and the
 * rules that keep a workspace owned. The SQL and its policy are
 * workspace-roles-db.test.ts.
 */

const membership = (userId: string, membershipId: string, orgId = ACME.orgId) => ({
  id: membershipId,
  organization: { id: orgId },
  public_user_data: { user_id: userId },
})
const created = (userId: string, membershipId: string) =>
  ["organizationMembership.created", membership(userId, membershipId)] as const
const deleted = (userId: string, membershipId: string) =>
  ["organizationMembership.deleted", membership(userId, membershipId)] as const
const orgCreated = (createdBy = "user_creator") =>
  ["organization.created", { id: ACME.orgId, created_by: createdBy }] as const

const roleOf = (rows: RoleRow[], userId: string) =>
  rows.find((r) => r.userId === userId)?.role ?? null

describe("the role map", () => {
  test("is exactly this, and nothing else", () => {
    expect(ROLE_PERMISSIONS).toEqual({
      owner: [
        "members:manage",
        "access_domains:manage",
        "roles:manage",
        "owners:manage",
        "workspace:manage",
        "workspace:delete",
        "sso:manage",
      ],
      admin: [
        "members:manage",
        "access_domains:manage",
        "roles:manage",
        "workspace:manage",
        "sso:manage",
      ],
      member: [],
    })
  })
  test("an owner holds everything; an admin all but owners and deletion", () => {
    for (const p of PERMISSIONS) expect(may("owner", p)).toBe(true)
    expect(may("admin", "workspace:delete")).toBe(false)
    expect(may("admin", "owners:manage")).toBe(false)
    for (const p of PERMISSIONS) expect(may("member", p)).toBe(false)
  })
  test("who may give which role, and invite with which", () => {
    expect(grantable("owner")).toEqual(["owner", "admin", "member"])
    expect(grantable("admin")).toEqual(["admin", "member"])
    expect(grantable("member")).toEqual([])
    expect(invitable("owner")).toEqual(["member", "admin"])
    expect(invitable("admin")).toEqual(["member", "admin"])
    expect(invitable("member")).toEqual([])
    // ⚠ Nobody joins as owner, by rule or invitation.
    expect(JOIN_ROLES).not.toContain("owner" as never)
  })
})

describe("legacy Clerk keys", () => {
  test("read as ours; anything unknown reads as member", () => {
    expect(readRole("org:admin")).toBe("admin")
    expect(readRole("org:member")).toBe("member")
    expect(readRole("owner")).toBe("owner")
    expect(readRole("org:billing")).toBe("member")
    expect(readRole(undefined)).toBe("member")
    // A stored rule or invitation never makes an owner, whatever it says.
    expect(readJoinRole("owner")).toBe("member")
    expect(readJoinRole("org:admin")).toBe("admin")
  })
  test("are accepted from a request and turned into ours", () => {
    expect(parseRole("org:admin")).toBe("admin")
    expect(parseRole(" owner ")).toBe("owner")
    expect(parseRole("org:sys_memberships:manage")).toBeNull()
    expect(parseRole(3)).toBeNull()
    expect(parseJoinRole("owner")).toBeNull()
    expect(parseJoinRole("org:member")).toBe("member")
  })
})

describe("can, against our table", () => {
  test("no row is member: least privilege, never admin", async () => {
    const { store } = memoryRoles({ [ACME.tenantId]: [row("user_admin", "admin")] })
    expect(await can(store, ACME.tenantId, "user_nobody", "members:manage")).toBe(false)
    expect(await can(store, ACME.tenantId, "user_admin", "members:manage")).toBe(true)
    expect(await can(store, ACME.tenantId, "user_admin", "workspace:delete")).toBe(
      false,
    )
    // Another workspace's admin is nobody here.
    expect(await can(store, "t_other", "user_admin", "members:manage")).toBe(false)
  })
  test("the reader's access, for the console", async () => {
    const { store } = memoryRoles({ [ACME.tenantId]: [row("user_o", "owner")] })
    expect(await accessOf(store, ACME.tenantId, "user_o")).toEqual({
      role: "owner",
      permissions: [...PERMISSIONS],
      grantable: ["owner", "admin", "member"],
      invitable: ["member", "admin"],
    })
    expect(await accessOf(store, ACME.tenantId, "user_x")).toMatchObject({
      role: "member",
      permissions: [],
      grantable: [],
    })
  })
})

describe("the creator becomes owner", () => {
  test("once, on organization.created", async () => {
    const t = rolesDeps()
    expect(await onClerkEvent(t.d, ...orgCreated())).toBe("owner:seeded")
    expect(t.rows()).toEqual([
      {
        userId: "user_creator",
        role: "owner",
        membershipId: null,
        source: "creator",
        grantedBy: null,
      },
    ])
  })
  test("a redelivery after they handed ownership on changes nothing", async () => {
    const t = rolesDeps({
      rows: [row("user_creator", "member"), row("user_next", "owner")],
    })
    expect(await onClerkEvent(t.d, ...orgCreated())).toBe("owner:kept")
    expect(roleOf(t.rows(), "user_creator")).toBe("member")
  })
  test("their membership webhook first, as a member: upgraded in place", async () => {
    const t = rolesDeps()
    // Provisioning already ran (the tenant exists) but the seed had not yet.
    await onClerkEvent(t.d, ...created("user_creator", "mem_c"))
    expect(roleOf(t.rows(), "user_creator")).toBe("member")
    await onClerkEvent(t.d, ...orgCreated())
    expect(t.rows()).toMatchObject([
      { userId: "user_creator", role: "owner", membershipId: "mem_c" },
    ])
  })
  test("nothing without a creator or a tenant", async () => {
    const t = rolesDeps({ tenants: {} })
    expect(await onClerkEvent(t.d, ...orgCreated())).toBeNull()
    expect(
      await onClerkEvent(rolesDeps().d, "organization.created", { id: ACME.orgId }),
    ).toBeNull()
  })
  test("seedOwner never adds a second owner", () => {
    expect(seedOwner([row("a", "owner")], "b")).toEqual({ writes: [], result: "kept" })
  })
})

describe("organizationMembership.created", () => {
  test("the creator's membership attaches to their row and keeps owner", async () => {
    const t = rolesDeps()
    await onClerkEvent(t.d, ...orgCreated())
    expect(await onClerkEvent(t.d, ...created("user_creator", "mem_c"))).toBe(
      "role:attached",
    )
    expect(t.rows()).toMatchObject([
      {
        userId: "user_creator",
        role: "owner",
        membershipId: "mem_c",
        source: "creator",
      },
    ])
  })

  test("before the tenant exists it writes nothing; organization.created covers it", async () => {
    const tenants: Record<string, string> = {}
    const t = rolesDeps({ tenants })
    expect(await onClerkEvent(t.d, ...created("user_creator", "mem_c"))).toBe(
      "role:no_tenant",
    )
    tenants[ACME.orgId] = ACME.tenantId
    await onClerkEvent(t.d, ...orgCreated())
    expect(roleOf(t.rows(), "user_creator")).toBe("owner")
  })

  test("through our invitation: the invitation's role, legacy keys read as ours", async () => {
    const t = rolesDeps({
      invitations: [{ email: "new@acme.test", role: "org:admin" }],
      emails: ["New@Acme.test"],
    })
    expect(await onClerkEvent(t.d, ...created("user_new", "mem_n"))).toBe(
      "role:inserted",
    )
    expect(t.rows()).toMatchObject([
      {
        userId: "user_new",
        role: "admin",
        membershipId: "mem_n",
        source: "invitation",
      },
    ])
  })

  test("nothing to go on: member, and Clerk is not asked for addresses", async () => {
    const t = rolesDeps({ emails: ["new@acme.test"] })
    await onClerkEvent(t.d, ...created("user_new", "mem_n"))
    expect(t.rows()).toMatchObject([
      { userId: "user_new", role: "member", source: "membership" },
    ])
    expect(t.calls.emailsAsked).toBe(0)
  })

  test("an invitation to somebody else does not apply", async () => {
    const t = rolesDeps({
      invitations: [{ email: "other@acme.test", role: "admin" }],
      emails: ["new@acme.test"],
    })
    await onClerkEvent(t.d, ...created("user_new", "mem_n"))
    expect(roleOf(t.rows(), "user_new")).toBe("member")
  })

  test("a redelivery keeps what has happened since", async () => {
    const t = rolesDeps({ rows: [row("user_owner", "owner")] })
    await onClerkEvent(t.d, ...created("user_new", "mem_n"))
    await setRole(t.d, {
      tenantId: ACME.tenantId,
      orgId: ACME.orgId,
      actorUserId: "user_owner",
      userId: "user_new",
      role: "admin",
    })
    expect(await onClerkEvent(t.d, ...created("user_new", "mem_n"))).toBe("role:kept")
    expect(roleOf(t.rows(), "user_new")).toBe("admin")
  })

  test("a new membership after leaving is a new decision", async () => {
    const t = rolesDeps({ rows: [row("user_back", "admin", "mem_old")] })
    expect(await onClerkEvent(t.d, ...created("user_back", "mem_new"))).toBe(
      "role:replaced",
    )
    expect(t.rows()).toMatchObject([
      { userId: "user_back", role: "member", membershipId: "mem_new" },
    ])
  })
})

describe("organizationMembership.deleted", () => {
  test("removes the row; a redelivery finds nothing", async () => {
    const t = rolesDeps({ rows: [row("user_owner", "owner"), row("user_a", "admin")] })
    expect(await onClerkEvent(t.d, ...deleted("user_a", "mem_user_a"))).toBe(
      "role:removed",
    )
    expect(await onClerkEvent(t.d, ...deleted("user_a", "mem_user_a"))).toBe(
      "role:kept",
    )
    expect(t.rows().map((r) => r.userId)).toEqual(["user_owner"])
  })

  test("a late delete for an old membership leaves the new one alone", async () => {
    const t = rolesDeps({ rows: [row("user_back", "admin", "mem_new")] })
    expect(await onClerkEvent(t.d, ...deleted("user_back", "mem_old"))).toBe(
      "role:kept",
    )
    expect(roleOf(t.rows(), "user_back")).toBe("admin")
  })

  test("the creator's row, still without a membership id, goes with any delete", async () => {
    const t = rolesDeps({ rows: [row("user_creator", "owner", null)] })
    expect(await onClerkEvent(t.d, ...deleted("user_creator", "mem_c"))).toBe(
      "role:removed",
    )
  })

  test("a deleted workspace's last owner is no alarm", async () => {
    const t = rolesDeps({
      rows: [row("user_owner", "owner")],
      clerk: { organizationExists: async () => false },
    })
    await onClerkEvent(t.d, ...deleted("user_owner", "mem_user_owner"))
    expect(t.logged.filter((l) => l.level === "error")).toEqual([])
    expect(t.logged).toMatchObject([{ level: "info" }])
  })

  test("the last owner leaving through Clerk is logged loudly", async () => {
    const t = rolesDeps({ rows: [row("user_owner", "owner"), row("user_m", "member")] })
    await onClerkEvent(t.d, ...deleted("user_owner", "mem_user_owner"))
    expect(t.logged).toMatchObject([
      { level: "error", m: expect.stringContaining("no owner") },
    ])
  })

  test("delete before create: the late create writes a member, replaced on rejoin", async () => {
    const t = rolesDeps()
    await onClerkEvent(t.d, ...deleted("user_x", "mem_1"))
    await onClerkEvent(t.d, ...created("user_x", "mem_1"))
    expect(t.rows()).toMatchObject([{ userId: "user_x", role: "member" }])
    await onClerkEvent(t.d, ...created("user_x", "mem_2"))
    expect(t.rows()).toMatchObject([{ userId: "user_x", membershipId: "mem_2" }])
  })
})

describe("addMember, racing the webhook", () => {
  test("Clerk is told nothing about the role; ours holds the rule's", async () => {
    const t = rolesDeps()
    expect(
      await addMember(t.d, { orgId: ACME.orgId, userId: "user_new", role: "admin" }),
    ).toBe("added")
    expect(t.calls.created).toEqual(["user_new"])
    expect(t.rows()).toMatchObject([
      {
        userId: "user_new",
        role: "admin",
        membershipId: "mem_new_1",
        source: "access_rule",
      },
    ])
  })

  test("ours first: the webhook for the same membership keeps the rule's role", async () => {
    const t = rolesDeps()
    await addMember(t.d, { orgId: ACME.orgId, userId: "user_new", role: "admin" })
    expect(await onClerkEvent(t.d, ...created("user_new", "mem_new_1"))).toBe(
      "role:kept",
    )
    expect(roleOf(t.rows(), "user_new")).toBe("admin")
  })

  test("the webhook first, guessing member: ours replaces it", async () => {
    const t = rolesDeps()
    await onClerkEvent(t.d, ...created("user_new", "mem_new_1"))
    expect(roleOf(t.rows(), "user_new")).toBe("member")
    await addMember(t.d, { orgId: ACME.orgId, userId: "user_new", role: "admin" })
    expect(roleOf(t.rows(), "user_new")).toBe("admin")
  })

  test("full or already a member writes nothing", async () => {
    const full = rolesDeps({ clerk: { create: async () => ({ outcome: "full" }) } })
    expect(
      await addMember(full.d, { orgId: ACME.orgId, userId: "u", role: "admin" }),
    ).toBe("full")
    const already = rolesDeps({
      rows: [row("u", "member")],
      clerk: { create: async () => ({ outcome: "already_member" }) },
    })
    expect(
      await addMember(already.d, { orgId: ACME.orgId, userId: "u", role: "admin" }),
    ).toBe("added")
    expect(full.rows()).toEqual([])
    expect(roleOf(already.rows(), "u")).toBe("member")
  })
})

describe("changing a role", () => {
  const team = () =>
    rolesDeps({
      rows: [
        row("user_owner", "owner"),
        row("user_admin", "admin"),
        row("user_m", "member"),
      ],
    })
  const change = (
    t: ReturnType<typeof rolesDeps>,
    actorUserId: string,
    userId: string,
    role: unknown,
  ) =>
    setRole(t.d, {
      tenantId: ACME.tenantId,
      orgId: ACME.orgId,
      actorUserId,
      userId,
      role,
    })

  test("a member may change nobody's", async () => {
    expect(await change(team(), "user_m", "user_admin", "member")).toEqual({
      outcome: "forbidden",
    })
  })
  test("an admin makes admins and members, and is audited", async () => {
    const t = team()
    expect(await change(t, "user_admin", "user_m", "admin")).toEqual({
      outcome: "ok",
      from: "member",
      to: "admin",
    })
    expect(t.rows().find((r) => r.userId === "user_m")).toMatchObject({
      role: "admin",
      source: "changed",
      grantedBy: "user_admin",
    })
    expect(t.logged).toMatchObject([
      {
        level: "info",
        o: {
          audit: "workspace.role_changed",
          actorUserId: "user_admin",
          userId: "user_m",
          from: "member",
          to: "admin",
        },
      },
    ])
  })
  test("only an owner makes, demotes or touches an owner", async () => {
    const t = team()
    expect(await change(t, "user_admin", "user_m", "owner")).toEqual({
      outcome: "owner_only",
    })
    expect(await change(t, "user_admin", "user_owner", "member")).toEqual({
      outcome: "owner_only",
    })
    expect(await change(t, "user_owner", "user_m", "owner")).toMatchObject({
      outcome: "ok",
      to: "owner",
    })
    // Two owners now: the first may step down.
    expect(await change(t, "user_owner", "user_owner", "admin")).toMatchObject({
      outcome: "ok",
    })
  })
  test("the last owner cannot step down", async () => {
    expect(await change(team(), "user_owner", "user_owner", "admin")).toEqual({
      outcome: "last_owner",
    })
  })
  test("two owners demoting each other at once leave one owner", async () => {
    const t = rolesDeps({ rows: [row("a", "owner"), row("b", "owner")] })
    const [first, second] = await Promise.all([
      change(t, "a", "b", "member"),
      change(t, "b", "a", "member"),
    ])
    expect([first.outcome, second.outcome].sort()).toEqual(["forbidden", "ok"])
    expect(t.rows().filter((r) => r.role === "owner")).toHaveLength(1)
  })
  test("an unknown role, and somebody who is not a member", async () => {
    const t = rolesDeps({
      rows: [row("user_owner", "owner")],
      clerk: { isMember: async () => false },
    })
    expect(await change(t, "user_owner", "user_m", "superadmin")).toEqual({
      outcome: "invalid",
    })
    expect(await change(t, "user_owner", "user_stranger", "admin")).toEqual({
      outcome: "missing",
    })
    expect(t.rows()).toHaveLength(1)
  })
  test("a member we hold no row for is checked with Clerk, then changed", async () => {
    const t = rolesDeps({ rows: [row("user_owner", "owner")] })
    expect(await change(t, "user_owner", "user_old", "admin")).toMatchObject({
      outcome: "ok",
      from: "member",
    })
    expect(roleOf(t.rows(), "user_old")).toBe("admin")
  })
  test("the pure decision refuses a member outright", () => {
    expect(
      changeRole([row("a", "member")], {
        actorUserId: "a",
        userId: "a",
        role: "admin",
      }),
    ).toEqual({ writes: [], result: { outcome: "forbidden" } })
  })
})

describe("leaving and removing", () => {
  test("the last owner cannot leave", async () => {
    const t = rolesDeps({ rows: [row("user_owner", "owner"), row("user_a", "admin")] })
    expect(
      await leaveWorkspace(t.d, {
        tenantId: ACME.tenantId,
        orgId: ACME.orgId,
        userId: "user_owner",
      }),
    ).toBe("last_owner")
    expect(t.calls.removed).toEqual([])
  })

  test("anybody else leaves: our row first, then Clerk", async () => {
    const t = rolesDeps({ rows: [row("user_owner", "owner"), row("user_a", "admin")] })
    expect(
      await leaveWorkspace(t.d, {
        tenantId: ACME.tenantId,
        orgId: ACME.orgId,
        userId: "user_a",
      }),
    ).toBe("ok")
    expect(t.calls.removed).toEqual(["user_a"])
    expect(t.rows().map((r) => r.userId)).toEqual(["user_owner"])
  })

  test("a Clerk failure puts the row back", async () => {
    const t = rolesDeps({
      rows: [row("user_owner", "owner"), row("user_a", "admin")],
      clerk: {
        remove: async () => {
          throw new Error("clerk down")
        },
      },
    })
    await expect(
      leaveWorkspace(t.d, {
        tenantId: ACME.tenantId,
        orgId: ACME.orgId,
        userId: "user_a",
      }),
    ).rejects.toThrow("clerk down")
    expect(roleOf(t.rows(), "user_a")).toBe("admin")
  })

  test("an admin cannot remove an owner; an owner can", async () => {
    const t = rolesDeps({
      rows: [row("o1", "owner"), row("o2", "owner"), row("adm", "admin")],
    })
    const remove = (actorUserId: string, userId: string) =>
      releaseMember(t.d, {
        tenantId: ACME.tenantId,
        orgId: ACME.orgId,
        actorUserId,
        userId,
      })
    expect(await remove("adm", "o2")).toEqual({ outcome: "owner_only" })
    expect(await remove("o1", "o2")).toMatchObject({ outcome: "ok" })
    expect(t.rows().map((r) => r.userId)).toEqual(["o1", "adm"])
  })

  test("two owners removing each other at once leave one", async () => {
    const t = rolesDeps({ rows: [row("a", "owner"), row("b", "owner")] })
    const results = await Promise.all([
      releaseMember(t.d, {
        tenantId: ACME.tenantId,
        orgId: ACME.orgId,
        actorUserId: "a",
        userId: "b",
      }),
      releaseMember(t.d, {
        tenantId: ACME.tenantId,
        orgId: ACME.orgId,
        actorUserId: "b",
        userId: "a",
      }),
    ])
    expect(results.map((r) => r.outcome).sort()).toEqual(["forbidden", "ok"])
    expect(t.rows().filter((r) => r.role === "owner")).toHaveLength(1)
  })
})

describe("an invitation's role is given once", () => {
  test("a second membership through another door is a member", async () => {
    const t = rolesDeps({
      invitations: [{ email: "new@acme.test", role: "admin" }],
      emails: ["new@acme.test"],
    })
    await onClerkEvent(t.d, ...created("user_new", "mem_1"))
    expect(roleOf(t.rows(), "user_new")).toBe("admin")
    expect(t.invitations[0]!.applied).toBe("mem_1")
    // Removed, then back within days without a new invitation.
    await onClerkEvent(t.d, ...deleted("user_new", "mem_1"))
    await onClerkEvent(t.d, ...created("user_new", "mem_2"))
    expect(t.rows()).toMatchObject([
      { userId: "user_new", role: "member", source: "membership" },
    ])
  })

  test("the same membership again still gets it, after a failed row write", async () => {
    // Used by mem_1, but the row was never written (the write failed).
    const t = rolesDeps({
      invitations: [{ email: "new@acme.test", role: "admin", applied: "mem_1" }],
      emails: ["new@acme.test"],
    })
    await onClerkEvent(t.d, ...created("user_new", "mem_1"))
    expect(roleOf(t.rows(), "user_new")).toBe("admin")
  })
})

describe("creating a workspace", () => {
  test("through the backend, then the creator is demoted in Clerk", async () => {
    const t = rolesDeps()
    expect(await createWorkspace(t.d, { name: "Acme", userId: "user_c" })).toEqual({
      id: "org_new_1",
    })
    expect(t.calls.orgs).toEqual([{ name: "Acme", createdBy: "user_c" }])
    expect(t.calls.demoted).toEqual(["org_new_1:user_c"])
    // The owner row waits for organization.created: there is no tenant yet.
    expect(t.rows()).toEqual([])
  })

  test("a failed demotion is loud, and the workspace is still theirs", async () => {
    const t = rolesDeps({
      clerk: {
        demote: async () => {
          throw new Error("clerk down")
        },
      },
    })
    expect(await createWorkspace(t.d, { name: "Acme", userId: "user_c" })).toEqual({
      id: "org_new_1",
    })
    expect(t.logged).toMatchObject([{ level: "error", o: { clerkOrgId: "org_new_1" } }])
  })

  test("Clerk's own creation settings, which the backend skips", () => {
    const on = { createOrganizationEnabled: true, createOrganizationsLimit: null }
    expect(mayCreateWorkspace(on, 40)).toBe(true)
    expect(mayCreateWorkspace({ ...on, createOrganizationEnabled: false }, 0)).toBe(
      false,
    )
    expect(mayCreateWorkspace({ ...on, createOrganizationsLimit: 2 }, 1)).toBe(true)
    expect(mayCreateWorkspace({ ...on, createOrganizationsLimit: 2 }, 2)).toBe(false)
    // Clerk's 0 is "no limit".
    expect(mayCreateWorkspace({ ...on, createOrganizationsLimit: 0 }, 9)).toBe(true)
  })
})

describe("the safety net: a powerful Clerk role is set back", () => {
  const withRole = (
    userId: string,
    membershipId: string,
    role: string,
    orgId = ACME.orgId,
  ) => ({
    ...membership(userId, membershipId, orgId),
    role,
  })

  test("a created membership with org:admin is demoted, our row decided as usual", async () => {
    const t = rolesDeps()
    expect(
      await onClerkEvent(
        t.d,
        "organizationMembership.created",
        withRole("user_x", "mem_x", "org:admin"),
      ),
    ).toBe("role:inserted,clerk:demoted")
    expect(t.calls.demoted).toEqual([`${ACME.orgId}:user_x`])
    // ⚠ Clerk's role never decides ours.
    expect(roleOf(t.rows(), "user_x")).toBe("member")
    expect(t.logged).toMatchObject([{ level: "warn", o: { clerkRole: "org:admin" } }])
  })

  test("updated to a powerful role: demoted, and our row untouched", async () => {
    const t = rolesDeps({ rows: [row("user_o", "owner")] })
    expect(
      await onClerkEvent(
        t.d,
        "organizationMembership.updated",
        withRole("user_o", "mem_user_o", "org:admin"),
      ),
    ).toBe("clerk:demoted")
    expect(t.rows()).toEqual([row("user_o", "owner")])
  })

  test("org:member is left alone, so our own demotion's echo stops here", async () => {
    const t = rolesDeps()
    expect(
      await onClerkEvent(
        t.d,
        "organizationMembership.updated",
        withRole("user_o", "mem_o", "org:member"),
      ),
    ).toBeNull()
    expect(t.calls.demoted).toEqual([])
  })

  test("even in an organization that is not one of our workspaces", async () => {
    const t = rolesDeps({ tenants: {} })
    expect(
      await onClerkEvent(
        t.d,
        "organizationMembership.created",
        withRole("user_x", "mem_x", "org:admin", "org_elsewhere"),
      ),
    ).toBe("role:no_tenant,clerk:demoted")
  })

  test("a failed demotion throws, so Svix retries", async () => {
    const t = rolesDeps({
      clerk: {
        demote: async () => {
          throw new Error("clerk down")
        },
      },
    })
    await expect(
      onClerkEvent(
        t.d,
        "organizationMembership.updated",
        withRole("user_o", "mem_o", "org:admin"),
      ),
    ).rejects.toThrow("clerk down")
  })
})

describe("owners whose accounts are gone (ghosts)", () => {
  const leave = (t: ReturnType<typeof rolesDeps>, userId: string) =>
    leaveWorkspace(t.d, { tenantId: ACME.tenantId, orgId: ACME.orgId, userId })
  const demote = (t: ReturnType<typeof rolesDeps>, userId: string) =>
    setRole(t.d, {
      tenantId: ACME.tenantId,
      orgId: ACME.orgId,
      actorUserId: userId,
      userId,
      role: "admin",
    })
  const gone = (ghost: string) => ({
    clerk: { stillMember: async (_o: string, u: string) => u !== ghost },
  })

  test("a ghost owner does not count: the real last owner may not leave or step down", async () => {
    const t = rolesDeps({
      rows: [row("user_real", "owner"), row("user_ghost", "owner")],
      ...gone("user_ghost"),
    })
    expect(await leave(t, "user_real")).toBe("last_owner")
    expect(t.rows().map((r) => r.userId)).toEqual(["user_real"])
    expect(t.logged).toMatchObject([
      { level: "warn", o: { tenantId: ACME.tenantId, userId: "user_ghost" } },
    ])
    expect(await demote(t, "user_real")).toEqual({ outcome: "last_owner" })
  })

  test("a real other owner lets them go, and the first one confirmed ends the check", async () => {
    const t = rolesDeps({
      rows: [row("user_a", "owner"), row("user_b", "owner"), row("user_c", "owner")],
    })
    expect(await demote(t, "user_a")).toMatchObject({ outcome: "ok", to: "admin" })
    expect(t.calls.confirmed).toEqual(["user_b"])
  })

  test("a ghost is removed only if its row is unchanged under the lock", async () => {
    const t = rolesDeps({
      rows: [row("user_real", "owner"), row("user_ghost", "owner")],
      clerk: {
        stillMember: async (_o, userId) => {
          if (userId !== "user_ghost") return true
          // Somebody re-roles the "ghost" between Clerk's answer and the lock.
          await t.d.store.transact(ACME.tenantId, () => ({
            writes: [
              { put: { ...row("user_ghost", "owner"), membershipId: "mem_newer" } },
            ],
            result: null,
          }))
          return false
        },
      },
    })
    expect(await leave(t, "user_real")).toBe("ok")
    // The changed row survived, and so counted: the real owner could leave.
    expect(t.rows()).toMatchObject([
      { userId: "user_ghost", membershipId: "mem_newer" },
    ])
  })

  test("a Clerk failure removes nothing and refuses", async () => {
    const t = rolesDeps({
      rows: [row("user_real", "owner"), row("user_maybe", "owner")],
      clerk: {
        stillMember: async () => {
          throw new Error("clerk 503")
        },
      },
    })
    expect(await leave(t, "user_real")).toBe("unconfirmed")
    expect(await demote(t, "user_real")).toEqual({ outcome: "unconfirmed" })
    expect(t.rows()).toHaveLength(2)
    expect(t.calls.removed).toEqual([])
    expect(t.logged.every((l) => l.level === "warn")).toBe(true)
  })

  test("ordinary paths ask Clerk nothing extra", async () => {
    const t = rolesDeps({
      rows: [row("user_o", "owner"), row("user_a", "admin"), row("user_m", "member")],
    })
    await leave(t, "user_m")
    await setRole(t.d, {
      tenantId: ACME.tenantId,
      orgId: ACME.orgId,
      actorUserId: "user_o",
      userId: "user_a",
      role: "member",
    })
    // An owner acting on another owner is plainly real: no check either.
    await t.d.store.transact(ACME.tenantId, () => ({
      writes: [{ put: row("user_o2", "owner") }],
      result: null,
    }))
    await releaseMember(t.d, {
      tenantId: ACME.tenantId,
      orgId: ACME.orgId,
      actorUserId: "user_o",
      userId: "user_o2",
    })
    expect(t.calls.confirmed).toEqual([])
  })
})
