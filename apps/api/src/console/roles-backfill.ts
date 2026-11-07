import { CLERK_ROLE, type Decision, type Role, type RoleRow } from "./roles.js"

/**
 * The planning half of scripts/workspace-roles.ts (#335), pure so it is
 * tested without Clerk or a database: what our table should gain from Clerk's
 * roles as they stand, and which Clerk memberships then lose their power.
 *
 * ⚠ BACKFILL FIRST, DEMOTE SECOND, PER WORKSPACE. The other order leaves a
 * window where an admin is `org:member` in Clerk with no row here - a member
 * by our rules - and if the script stopped there, a workspace with no admin.
 *
 * ⚠ A ROW WE ALREADY HOLD IS NEVER OVERWRITTEN. After the deploy the webhooks
 * write rows for every new membership and role change; those are newer than
 * anything Clerk's roles can say.
 */

export interface OrgSnapshot {
  orgId: string
  name: string
  /** Who created the organization, by Clerk; null when Clerk does not say. */
  createdBy: string | null
  /** Our tenant for it; null when it was never provisioned. */
  tenantId: string | null
  memberships: {
    membershipId: string
    userId: string
    /** Clerk's role key, `org:admin` or `org:member` today. */
    role: string
    /** Their sign-in address, for the printout. */
    identifier: string
  }[]
  /** Our rows for the workspace, as they stand. */
  rows: RoleRow[]
  /** Clerk's pending invitations, with Clerk's role key. */
  pendingInvitations: { id: string; email: string; role: string }[]
}

export interface OrgPlan {
  orgId: string
  name: string
  tenantId: string | null
  /** Rows to write: one per member we hold nothing for. */
  backfill: { userId: string; role: Role; membershipId: string; identifier: string }[]
  /** Members whose row we keep as it is. */
  kept: { userId: string; role: Role; identifier: string }[]
  /** Clerk memberships to set to `CLERK_ROLE`. */
  demote: { userId: string; from: string; identifier: string }[]
  warnings: string[]
}

/** What Clerk's role said, in ours: the creator owns, `org:admin` is admin. */
export function roleFromClerk(
  membership: { userId: string; role: string },
  createdBy: string | null,
): Role {
  if (createdBy && membership.userId === createdBy) return "owner"
  return membership.role === "org:admin" ? "admin" : "member"
}

export function planOrg(org: OrgSnapshot): OrgPlan {
  const plan: OrgPlan = {
    orgId: org.orgId,
    name: org.name,
    tenantId: org.tenantId,
    backfill: [],
    kept: [],
    demote: [],
    warnings: [],
  }
  for (const m of org.memberships) {
    if (m.role !== CLERK_ROLE)
      plan.demote.push({ userId: m.userId, from: m.role, identifier: m.identifier })
    if (!org.tenantId) continue
    const held = org.rows.find((r) => r.userId === m.userId)
    if (held) {
      plan.kept.push({ userId: m.userId, role: held.role, identifier: m.identifier })
      continue
    }
    plan.backfill.push({
      userId: m.userId,
      role: roleFromClerk(m, org.createdBy),
      membershipId: m.membershipId,
      identifier: m.identifier,
    })
  }
  if (!org.tenantId) {
    plan.warnings.push("no tenant for this organization: nothing to backfill")
  } else {
    const owners =
      plan.kept.filter((k) => k.role === "owner").length +
      plan.backfill.filter((b) => b.role === "owner").length
    if (owners === 0 && org.memberships.length > 0)
      plan.warnings.push(
        "no owner: the creator is not a member any more. Make one with the Team " +
          "page's role picker (an owner) or PUT /console/team/members/:userId/role.",
      )
  }
  for (const i of org.pendingInvitations) {
    if (i.role !== CLERK_ROLE)
      plan.warnings.push(
        `pending invitation ${i.id} for ${i.email} is ${i.role} in Clerk: accepting it ` +
          "makes a powerful Clerk membership. Revoke it and invite again, or re-run " +
          "this script after it is accepted or expires.",
      )
  }
  return plan
}

/**
 * Applies a plan's rows under the workspace's lock: only for members who
 * still have none, so a webhook that wrote one since the plan was made wins.
 */
export function backfillRows(
  rows: RoleRow[],
  planned: OrgPlan["backfill"],
): Decision<number> {
  const writes = planned
    .filter((p) => !rows.some((r) => r.userId === p.userId))
    .map((p) => ({
      put: {
        userId: p.userId,
        role: p.role,
        membershipId: p.membershipId,
        source: "backfill" as const,
        grantedBy: null,
      },
    }))
  return { writes, result: writes.length }
}

/**
 * Which Clerk instance a secret key belongs to, from its prefix - or null for
 * a key that is neither.
 */
export function instanceOfKey(key: string): "dev" | "prod" | null {
  if (key.startsWith("sk_test_")) return "dev"
  if (key.startsWith("sk_live_")) return "prod"
  return null
}
