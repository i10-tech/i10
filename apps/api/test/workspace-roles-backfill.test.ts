import { describe, expect, test } from "bun:test"
import {
  backfillRows,
  instanceOfKey,
  planOrg,
  roleFromClerk,
  type OrgSnapshot,
} from "../src/console/roles-backfill.js"
import { row } from "./role-fixtures.js"

/**
 * The plan behind scripts/workspace-roles.ts (#335), pure: what our table
 * gains from Clerk's roles, which Clerk memberships lose theirs, and what
 * needs a person. No Clerk and no database.
 */

const acme = (over: Partial<OrgSnapshot> = {}): OrgSnapshot => ({
  orgId: "org_acme",
  name: "Acme",
  createdBy: "user_founder",
  tenantId: "t_acme",
  memberships: [
    {
      membershipId: "m1",
      userId: "user_founder",
      role: "org:admin",
      identifier: "f@acme.test",
    },
    {
      membershipId: "m2",
      userId: "user_ops",
      role: "org:admin",
      identifier: "o@acme.test",
    },
    {
      membershipId: "m3",
      userId: "user_dev",
      role: "org:member",
      identifier: "d@acme.test",
    },
  ],
  rows: [],
  pendingInvitations: [],
  ...over,
})

describe("roleFromClerk", () => {
  test("the creator owns, org:admin is admin, anything else member", () => {
    expect(roleFromClerk({ userId: "u", role: "org:member" }, "u")).toBe("owner")
    expect(roleFromClerk({ userId: "u", role: "org:admin" }, "x")).toBe("admin")
    expect(roleFromClerk({ userId: "u", role: "org:billing" }, null)).toBe("member")
  })
})

describe("planOrg", () => {
  test("backfills every member, then demotes every powerful Clerk membership", () => {
    const plan = planOrg(acme())
    expect(plan.backfill).toEqual([
      {
        userId: "user_founder",
        role: "owner",
        membershipId: "m1",
        identifier: "f@acme.test",
      },
      {
        userId: "user_ops",
        role: "admin",
        membershipId: "m2",
        identifier: "o@acme.test",
      },
      {
        userId: "user_dev",
        role: "member",
        membershipId: "m3",
        identifier: "d@acme.test",
      },
    ])
    expect(plan.demote.map((d) => d.userId)).toEqual(["user_founder", "user_ops"])
    expect(plan.warnings).toEqual([])
  })

  test("never overwrites a row we already hold", () => {
    const plan = planOrg(acme({ rows: [row("user_ops", "member")] }))
    expect(plan.kept).toEqual([
      { userId: "user_ops", role: "member", identifier: "o@acme.test" },
    ])
    expect(plan.backfill.map((b) => b.userId)).toEqual(["user_founder", "user_dev"])
    // Clerk's admin still loses the power: the row we hold is what counts.
    expect(plan.demote.map((d) => d.userId)).toContain("user_ops")
  })

  test("says when nobody would own it", () => {
    const plan = planOrg(acme({ createdBy: "user_gone" }))
    expect(plan.backfill.some((b) => b.role === "owner")).toBe(false)
    expect(plan.warnings).toEqual([expect.stringContaining("no owner")])
  })

  test("an organization with no tenant: nothing to write, still demoted", () => {
    const plan = planOrg(acme({ tenantId: null }))
    expect(plan.backfill).toEqual([])
    expect(plan.demote).toHaveLength(2)
    expect(plan.warnings).toEqual([expect.stringContaining("no tenant")])
  })

  test("warns about a pending invitation that would make a powerful membership", () => {
    const plan = planOrg(
      acme({
        pendingInvitations: [
          { id: "inv_1", email: "a@acme.test", role: "org:admin" },
          { id: "inv_2", email: "b@acme.test", role: "org:member" },
        ],
      }),
    )
    expect(plan.warnings).toEqual([expect.stringContaining("inv_1")])
  })
})

describe("backfillRows", () => {
  test("writes only for members who still have no row, as backfill", () => {
    const plan = planOrg(acme())
    const decision = backfillRows([row("user_dev", "admin")], plan.backfill)
    expect(decision.result).toBe(2)
    expect(decision.writes).toEqual([
      {
        put: {
          userId: "user_founder",
          role: "owner",
          membershipId: "m1",
          source: "backfill",
          grantedBy: null,
        },
      },
      {
        put: {
          userId: "user_ops",
          role: "admin",
          membershipId: "m2",
          source: "backfill",
          grantedBy: null,
        },
      },
    ])
  })
})

describe("instanceOfKey", () => {
  test("from the key's prefix, or nothing", () => {
    expect(instanceOfKey("sk_test_abc")).toBe("dev")
    expect(instanceOfKey("sk_live_abc")).toBe("prod")
    expect(instanceOfKey("pk_live_abc")).toBeNull()
    expect(instanceOfKey("")).toBeNull()
  })
})
