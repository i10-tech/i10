import { describe, expect, it } from "bun:test"
import {
  bind,
  completeLogin,
  redeemHandoff,
  startLogin,
  type BridgeDeps,
} from "../src/identity/bridge.js"
import { testEngine } from "../src/identity/test-engine.js"
import type { Assertion } from "../src/identity/model.js"
import type { GroupRoleRule } from "../src/identity/ports.js"
import {
  jitAllowed,
  profileChanges,
  readGroupValue,
  readName,
  readPrecedence,
  roleFromGroups,
} from "../src/identity/jit.js"
import {
  addMember,
  syncRole,
  syncedRole,
  type JoinRole,
  type Role,
} from "../src/console/roles.js"
import { ACME, row, rolesDeps } from "./role-fixtures.js"
import {
  CONNECTION,
  ORG,
  TENANT,
  connection,
  log,
  memoryClerk,
  memoryStore,
  user,
} from "./identity-fakes.js"

/**
 * JIT provisioning, group-to-role rules and profile sync (#341, sso.md 2.6),
 * through the real bridge with in-memory ports and the real roles decisions.
 */

const BINDING = "b".repeat(43)

const rule = (
  over: Partial<GroupRoleRule> & Pick<GroupRoleRule, "groupValue" | "role">,
): GroupRoleRule => ({
  id: `00000000-0000-4000-9000-${String(over.precedence ?? 0).padStart(12, "0")}`,
  connectionId: CONNECTION,
  precedence: 0,
  ...over,
})

function world(
  options: {
    jit?: boolean
    users?: ReturnType<typeof user>[]
    rules?: GroupRoleRule[]
    roles?: ReturnType<typeof row>[]
    full?: boolean
    blocked?: string[]
    status?: "active" | "testing"
    owners?: string[]
  } = {},
) {
  let clock = new Date("2026-10-21T10:00:00Z").getTime()
  const store = memoryStore({
    connections: [
      connection({
        jitEnabled: options.jit ?? true,
        status: options.status ?? "active",
      }),
    ],
    blocked: options.blocked ?? [],
    rules: options.rules ?? [],
  })
  const clerk = memoryClerk({ users: options.users ?? [] })
  // Our roles table, for real: the same decisions as Postgres, one at a time.
  // Clerk answers `already_member` for somebody who is, and addMember relies
  // on that to leave an existing member's role alone.
  const members = new Set((options.roles ?? []).map((r) => r.userId))
  const roles = rolesDeps({
    rows: options.roles ?? [],
    tenants: { [ORG]: ACME.tenantId },
    clerk: {
      create: async (_o, userId) => {
        if (members.has(userId)) return { outcome: "already_member" }
        members.add(userId)
        return { outcome: "created", membershipId: `mem_${userId}` }
      },
    },
  })
  const joined: { userId: string; role: JoinRole }[] = []
  const waitlisted: { tenantId: string; userId: string; email: string; via: string }[] =
    []
  const deps: BridgeDeps = {
    store: store.store,
    clerk: clerk.clerk,
    engines: new Map([["test", testEngine("https://auth.i10.localhost")]]),
    join: async ({ orgId, userId, role }) => {
      if (options.full) return "full"
      joined.push({ userId, role })
      return addMember(roles.d, { orgId, userId, role, source: "sso" })
    },
    isExempt: async (_t, userId) => {
      if ((options.owners ?? []).includes(userId)) return true
      const r = await roles.d.store.roleOf(ACME.tenantId, userId)
      return r === "owner" || r === "admin"
    },
    jit: true,
    syncRole: (input) => syncRole(roles.d, { ...input, tenantId: ACME.tenantId }),
    waitlist: async (tenantId, input) => {
      const exists = waitlisted.some((w) => w.userId === input.userId)
      waitlisted.push({ tenantId, ...input })
      return exists ? "exists" : "created"
    },
    log,
    now: () => new Date(clock),
  }
  const now = () => new Date(clock)
  const advance = (ms: number) => {
    clock += ms
  }

  const assertion = (over: Partial<Assertion> = {}): Assertion => ({
    subject: "okta|grace",
    email: "grace@acme.test",
    emailVerified: true,
    givenName: "Grace",
    familyName: "Hopper",
    groups: [],
    authTime: now(),
    amr: ["pwd"],
    ...over,
  })

  async function attempt(purpose: "sign_in" | "test_run" = "sign_in") {
    const started = await startLogin(deps, {
      connectionId: CONNECTION,
      purpose,
      binding: BINDING,
      returnTo: null,
    })
    if (started.outcome !== "redirect") throw new Error(started.reason)
    return new URL(started.redirectUrl).searchParams.get("state")!
  }

  async function complete(over: Partial<Assertion> = {}, purpose?: "test_run") {
    const state = await attempt(purpose)
    return completeLogin(deps, {
      protocol: "test",
      state,
      binding: BINDING,
      assertion: assertion(over),
    })
  }

  /** The whole bridge, to a bound session. */
  async function signIn(over: Partial<Assertion> = {}) {
    const done = await complete(over)
    if (done.outcome !== "signed_in") throw new Error(JSON.stringify(done))
    const redeemed = await redeemHandoff(deps, { code: done.code, binding: BINDING })
    if (redeemed.outcome !== "ticket") throw new Error(JSON.stringify(redeemed))
    advance(1_000)
    const sessionId = clerk.redeem(redeemed.ticket, now())
    const userId = clerk.minted.at(-1)!.userId
    const bound = await bind(deps, { userId, sessionId, handoff: redeemed.handoff })
    advance(60_000)
    return { userId, bound }
  }

  const roleOf = (userId: string): Role | undefined =>
    roles.rows().find((r) => r.userId === userId)?.role
  const events = (type: string) => store.events.filter((e) => e.type === type)

  return {
    deps,
    store,
    clerk,
    roles,
    joined,
    waitlisted,
    complete,
    signIn,
    roleOf,
    events,
  }
}

describe("JIT creates the person on a first sign-in", () => {
  it("makes the Clerk user, the link, the managed row and the membership", async () => {
    const w = world()
    const { userId, bound } = await w.signIn()
    expect(bound.outcome).toBe("bound")
    expect(w.clerk.created).toEqual([userId])
    const made = w.clerk.users.get(userId)!
    // Verified address, the IdP's names, no password.
    expect(made.emails).toEqual([
      { id: `idn_${userId}`, address: "grace@acme.test", verified: true },
    ])
    expect(made.firstName).toBe("Grace")
    expect(made.passwordEnabled).toBe(false)
    // Linked, managed for JIT, and the managed rules applied.
    expect(w.store.identities).toMatchObject([
      { subject: "okta|grace", clerkUserId: userId, email: "grace@acme.test" },
    ])
    expect(w.store.managed.get(userId)).toMatchObject({
      tenantId: TENANT,
      connectionId: CONNECTION,
      reason: "jit",
      emails: ["grace@acme.test"],
    })
    expect(made.deleteSelfEnabled).toBe(false)
    // A member, through our roles code, sourced from SSO.
    expect(w.joined).toEqual([{ userId, role: "member" }])
    expect(w.roles.rows()).toMatchObject([{ userId, role: "member", source: "sso" }])
    expect(w.events("jit.provisioned")).toMatchObject([
      { subjectUserId: userId, data: { role: "member", rule: null } },
    ])
    expect(w.events("managed.claimed")).toMatchObject([{ reason: "jit" }])
  })

  it("is the existing person, linked, the second time: nobody new", async () => {
    const w = world()
    const first = await w.signIn()
    const second = await w.signIn()
    expect(second.userId).toBe(first.userId)
    expect(w.clerk.created).toHaveLength(1)
    expect(w.store.identities).toHaveLength(1)
  })

  it("makes one Clerk user when two first sign-ins race", async () => {
    const w = world()
    const [a, b] = await Promise.all([w.complete(), w.complete()])
    expect(a.outcome).toBe("signed_in")
    expect(b.outcome).toBe("signed_in")
    expect(w.clerk.created).toHaveLength(1)
    expect(w.store.identities).toHaveLength(1)
    // The second waited for the first one's lock, then found its link.
    expect(w.store.lockLog).toEqual([
      `lock:${CONNECTION}:grace@acme.test`,
      `unlock:${CONNECTION}:grace@acme.test`,
      `lock:${CONNECTION}:grace@acme.test`,
      `unlock:${CONNECTION}:grace@acme.test`,
    ])
    expect(w.store.managed.size).toBe(1)
  })

  it("re-resolves when Clerk says the address was taken meanwhile, and claims that account", async () => {
    const w = world()
    // Somebody signs up by hand with the address between our look and our create.
    w.clerk.hooks.beforeCreate = (email) => {
      w.clerk.users.set(
        "user_by_hand",
        user({
          id: "user_by_hand",
          emails: [{ id: "idn_h", address: email, verified: true }],
        }),
      )
    }
    const done = await w.complete()
    expect(done.outcome).toBe("signed_in")
    expect(w.clerk.created).toEqual([])
    expect(w.store.managed.get("user_by_hand")).toMatchObject({ reason: "claimed" })
    expect(w.store.identities).toMatchObject([{ clerkUserId: "user_by_hand" }])
  })

  it("never creates for an address a Clerk account holds: the claim path instead", async () => {
    const w = world({
      users: [
        user({
          id: "user_grace",
          emails: [{ id: "idn_g", address: "grace@acme.test", verified: true }],
        }),
      ],
    })
    expect((await w.complete()).outcome).toBe("signed_in")
    expect(w.clerk.created).toEqual([])
    expect(w.store.managed.get("user_grace")).toMatchObject({ reason: "claimed" })
  })

  it("never creates for an address held unverified, and says why in the log", async () => {
    const w = world({
      users: [
        user({
          id: "user_grace",
          emails: [{ id: "idn_g", address: "grace@acme.test", verified: false }],
        }),
      ],
    })
    expect(await w.complete()).toEqual({ outcome: "refused", reason: "no_account" })
    expect(w.clerk.created).toEqual([])
    expect(w.events("sign_in.failed").at(-1)).toMatchObject({
      reason: "no_account",
      data: { jit: "address_held" },
    })
  })

  const refusals: [string, Parameters<typeof world>[0], Partial<Assertion>, string][] =
    [
      ["an address on the block list", { blocked: ["grace@acme.test"] }, {}, "blocked"],
      [
        "an address the IdP does not vouch for",
        {},
        { emailVerified: false },
        "email_unverified",
      ],
      [
        "an address off the connection's domains",
        {},
        { email: "grace@elsewhere.test" },
        "domain_not_verified",
      ],
      ["a connection with JIT off", { jit: false }, {}, "no_account"],
      [
        "an IdP that sends no name, which Clerk requires",
        {},
        { familyName: undefined },
        "profile_incomplete",
      ],
    ]
  for (const [what, options, over, reason] of refusals)
    it(`creates nobody for ${what}`, async () => {
      const w = world(options)
      expect(await w.complete(over)).toEqual({
        outcome: "refused",
        reason: reason as never,
      })
      expect(w.clerk.created).toEqual([])
      expect(w.store.identities).toHaveLength(0)
      expect(w.store.managed.size).toBe(0)
      expect(w.joined).toEqual([])
    })

  it("says what JIT would do on a test run, and creates nobody", async () => {
    const w = world({
      status: "testing",
      rules: [rule({ groupValue: "eng-admins", role: "admin" })],
    })
    const done = await w.complete({ groups: ["eng-admins"] }, "test_run")
    expect(done).toMatchObject({ outcome: "tested", passed: true })
    expect(w.store.testRuns[0]).toMatchObject({
      resolution: {
        path: "jit",
        wouldCreate: true,
        email: "grace@acme.test",
        role: "admin",
      },
    })
    expect(w.clerk.created).toEqual([])
    expect(w.store.identities).toHaveLength(0)
  })
})

describe("a full workspace (#327)", () => {
  it("turns JIT into a waiting-list request, not an error", async () => {
    const w = world({ full: true })
    const done = await w.complete()
    expect(done).toEqual({
      outcome: "refused",
      reason: "waiting_list",
      message: "Acme is full right now. We've asked its admins to add you.",
    })
    const [userId] = w.clerk.created
    // They exist and are managed - so no other way in - but are not a member.
    expect(w.store.managed.get(userId!)).toMatchObject({ reason: "jit" })
    expect(w.waitlisted).toEqual([
      { tenantId: TENANT, userId: userId!, email: "grace@acme.test", via: "acme.test" },
    ])
    expect(w.roles.rows()).toEqual([])
    expect(w.clerk.minted).toEqual([])
    expect(w.events("jit.waitlisted")).toMatchObject([
      { subjectUserId: userId, reason: "workspace_full", data: { request: "created" } },
    ])
    // Still full next time: the same answer, the same request, nobody new.
    expect(await w.complete()).toMatchObject({ reason: "waiting_list" })
    expect(w.clerk.created).toHaveLength(1)
    expect(w.events("jit.waitlisted").at(-1)).toMatchObject({
      data: { request: "exists" },
    })
  })
})

describe("group-to-role rules", () => {
  it("picks the first matching rule by precedence, then the older rule, else member", () => {
    const rules = [
      rule({ groupValue: "admins", role: "admin", precedence: 10 }),
      rule({ groupValue: "staff", role: "member", precedence: 5 }),
      { ...rule({ groupValue: "ops", role: "admin", precedence: 5 }), id: "ffff" },
    ]
    expect(roleFromGroups(rules, ["admins", "staff"])).toMatchObject({
      role: "member",
      rule: { groupValue: "staff" },
    })
    expect(roleFromGroups(rules, ["admins"]).role).toBe("admin")
    // Equal precedence: the older (smaller uuidv7) id wins.
    expect(roleFromGroups(rules, ["ops", "staff"]).rule?.groupValue).toBe("staff")
    expect(roleFromGroups(rules, ["nobody"])).toEqual({ role: "member", rule: null })
    expect(roleFromGroups(rules, undefined)).toEqual({ role: "member", rule: null })
    // Exact values only.
    expect(roleFromGroups(rules, ["Admins", " admins"]).rule).toBeNull()
  })

  it("joins a new person with the mapped role and audits the rule", async () => {
    const w = world({ rules: [rule({ groupValue: "eng-admins", role: "admin" })] })
    const { userId } = await w.signIn({ groups: ["eng-admins"] })
    expect(w.roleOf(userId)).toBe("admin")
    expect(w.events("jit.provisioned")[0]).toMatchObject({
      data: { role: "admin", rule: { group: "eng-admins", precedence: 0 } },
    })
  })

  it("re-evaluates at every sign-in: a group change in the IdP shows at the next one", async () => {
    const admins = rule({ groupValue: "eng-admins", role: "admin" })
    const w = world({ rules: [admins] })
    const { userId } = await w.signIn({ groups: [] })
    expect(w.roleOf(userId) ?? "member").toBe("member")
    await w.signIn({ groups: ["eng-admins"] })
    expect(w.roleOf(userId)).toBe("admin")
    expect(w.events("role.synced").at(-1)).toMatchObject({
      subjectUserId: userId,
      data: {
        from: "member",
        to: "admin",
        rule: { id: admins.id, group: "eng-admins" },
      },
    })
    // Out of the group: back to the default, audited with no rule.
    await w.signIn({ groups: [] })
    expect(w.roleOf(userId)).toBe("member")
    expect(w.events("role.synced").at(-1)).toMatchObject({
      data: { from: "admin", to: "member", rule: null },
    })
  })

  it("leaves roles alone on a connection with no rules", async () => {
    const w = world({
      jit: false,
      users: [
        user({
          id: "user_m",
          emails: [{ id: "i", address: "grace@acme.test", verified: true }],
        }),
      ],
    })
    // Claimed as a member first (an unmanaged admin is refused), then made an
    // admin on the Team page.
    await w.signIn()
    await w.roles.d.store.transact(ACME.tenantId, () => ({
      writes: [{ put: { ...row("user_m", "admin"), source: "changed" } }],
      result: null,
    }))
    expect((await w.complete()).outcome).toBe("signed_in")
    expect(w.roleOf("user_m")).toBe("admin")
    expect(w.events("role.synced")).toEqual([])
  })

  it("never demotes an owner, so never the last one, and says so in the log", async () => {
    const w = world({
      jit: false,
      rules: [rule({ groupValue: "staff", role: "member" })],
      users: [
        user({
          id: "user_o",
          emails: [{ id: "i", address: "grace@acme.test", verified: true }],
        }),
      ],
    })
    // Claimed as a member, then made the workspace's only owner on the Team page.
    await w.signIn({ groups: ["staff"] })
    await w.roles.d.store.transact(ACME.tenantId, () => ({
      writes: [{ put: { ...row("user_o", "owner"), source: "changed" } }],
      result: null,
    }))
    const again = await w.complete({ groups: ["staff"] })
    expect(again.outcome).toBe("signed_in")
    expect(w.roleOf("user_o")).toBe("owner")
    expect(w.events("role.sync_skipped")).toMatchObject([
      { subjectUserId: "user_o", reason: "owner", data: { wanted: "member" } },
    ])
  })

  it("never writes owner, whatever reaches the decision", () => {
    const owner = "owner" as unknown as JoinRole
    expect(syncedRole([], { userId: "u", role: owner })).toEqual({
      writes: [],
      result: { outcome: "unchanged", role: "member" },
    })
    expect(
      syncedRole([row("u", "admin")], { userId: "u", role: owner }).writes,
    ).toEqual([{ put: { ...row("u", "member"), source: "sso" } }])
    expect(syncedRole([row("u", "owner")], { userId: "u", role: "admin" })).toEqual({
      writes: [],
      result: { outcome: "owner_kept" },
    })
  })

  it("does not reach owners and admins who are not managed: they are refused first", async () => {
    const w = world({
      jit: false,
      rules: [rule({ groupValue: "staff", role: "member" })],
      roles: [row("user_a", "admin")],
      users: [
        user({
          id: "user_a",
          emails: [{ id: "i", address: "grace@acme.test", verified: true }],
        }),
      ],
    })
    expect(await w.complete({ groups: ["staff"] })).toEqual({
      outcome: "refused",
      reason: "role_exempt",
    })
    expect(w.roleOf("user_a")).toBe("admin")
  })
})

describe("profile sync", () => {
  it("sends changed names to Clerk and logs only that the profile changed", async () => {
    const w = world()
    const { userId } = await w.signIn()
    expect(w.clerk.profiles).toEqual([])
    await w.signIn({ givenName: "Amazing Grace", familyName: "Hopper" })
    expect(w.clerk.profiles).toEqual([
      { userId, names: { firstName: "Amazing Grace" } },
    ])
    expect(w.events("profile.updated")).toEqual([
      {
        tenantId: TENANT,
        type: "profile.updated",
        subjectUserId: userId,
        connectionId: CONNECTION,
      },
    ])
    // The same names again: nothing to send.
    await w.signIn({ givenName: "Amazing Grace" })
    expect(w.clerk.profiles).toHaveLength(1)
  })

  it("never blanks a name the IdP left out, and a Clerk failure does not stop the sign-in", async () => {
    expect(
      profileChanges({ firstName: "A", lastName: "B" }, { givenName: null }),
    ).toBeNull()
    expect(
      profileChanges({ firstName: "A", lastName: "B" }, { familyName: "  " }),
    ).toBeNull()
    const w = world()
    await w.signIn()
    w.clerk.fail.updateProfile = true
    const again = await w.complete({ givenName: "Other" })
    expect(again.outcome).toBe("signed_in")
    expect(w.events("profile.updated")).toEqual([])
  })
})

describe("the small rules", () => {
  it("allows JIT only on an active connection that has it on", () => {
    expect(jitAllowed({ status: "active", jitEnabled: true })).toBe(true)
    expect(jitAllowed({ status: "active", jitEnabled: false })).toBe(false)
    expect(jitAllowed({ status: "testing", jitEnabled: true })).toBe(false)
    expect(jitAllowed({ status: "disabled", jitEnabled: true })).toBe(false)
  })

  it("reads names, groups and precedence strictly", () => {
    expect(readName(" Ada ")).toBe("Ada")
    expect(readName("a\u0000b")).toBeNull()
    expect(readName("x".repeat(257))).toBeNull()
    expect(readGroupValue("eng-admins")).toBe("eng-admins")
    expect(readGroupValue("")).toBeNull()
    expect(readGroupValue(42)).toBeNull()
    expect(readPrecedence(0)).toBe(0)
    expect(readPrecedence(10_000)).toBe(10_000)
    expect(readPrecedence(1.5)).toBeNull()
    expect(readPrecedence(-1)).toBeNull()
    expect(readPrecedence("1")).toBeNull()
  })
})
