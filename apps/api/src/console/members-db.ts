import { and, asc, desc, eq, gt, isNull, lte, or, sql } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import {
  memberAlerts,
  memberInvitations,
  planAssignments,
  plans,
  tenants,
} from "../db/core.js"
import { NO_TENANT } from "../middleware/tenant.js"
import type { AlertLevel } from "./capacity.js"

/**
 * The database half of member limits, invitations and capacity alerts (#327).
 * See `member_invitations` and `member_alerts` in db/core.ts for the policies.
 */

export type InvitationStatus = "pending" | "accepted" | "withdrawn" | "expired"

export interface InvitationRow {
  id: string
  tenantId: string
  clerkOrgId: string
  clerkInvitationId: string | null
  email: string
  role: string
  inviterUserId: string
  expiresAt: Date
  zone: string
  country: string | null
  actionUrl: string | null
  status: InvitationStatus
  createdAt: Date
}

export interface PlanLimit {
  planId: string | null
  /** The plan's member limit; 20 when the workspace holds no plan. */
  limit: number
  /** A plan ranked above this one exists that the workspace could move to. */
  canUpgrade: boolean
}

export interface MemberStore {
  createInvitation(
    tenantId: string,
    input: {
      clerkOrgId: string
      email: string
      role: string
      inviterUserId: string
      expiresAt: Date
      zone: string
      country: string | null
    },
  ): Promise<string>
  /** Records Clerk's id once Clerk made it. */
  attachClerk(tenantId: string, id: string, clerkInvitationId: string): Promise<void>
  /** Drops a row Clerk refused to make. */
  discard(tenantId: string, id: string): Promise<void>
  pendingInvitations(tenantId: string): Promise<InvitationRow[]>
  invitation(tenantId: string, id: string): Promise<InvitationRow | null>
  byClerkId(tenantId: string, clerkInvitationId: string): Promise<InvitationRow | null>
  /** Pending rows whose expiry is at or before `now`. */
  due(tenantId: string, now: Date): Promise<InvitationRow[]>
  /** Ends a PENDING row; false when it had already ended. */
  end(
    tenantId: string,
    id: string,
    status: Exclude<InvitationStatus, "pending">,
  ): Promise<boolean>
  /** The newest pending row for an address, for the invitation email. */
  forInvitee(email: string, since: Date): Promise<InvitationRow | null>
  /** Keeps Clerk's accept link on the row the email points at. */
  keepLink(email: string, id: string, actionUrl: string): Promise<void>
  /** The one row an invitation link names. */
  byLink(id: string): Promise<InvitationRow | null>

  planLimit(tenantId: string): Promise<PlanLimit>
  workspace(
    tenantId: string,
  ): Promise<{ name: string; clerkOrgId: string | null } | null>
  /** Our tenant for a Clerk organization, for a verified webhook. */
  tenantOf(clerkOrgId: string): Promise<string | null>

  alert(tenantId: string): Promise<{ level: AlertLevel; alertedAt: Date | null }>
  setAlert(tenantId: string, level: AlertLevel, alertedAt: Date | null): Promise<void>
}

const DEFAULT_LIMIT = 20

const toRow = (r: typeof memberInvitations.$inferSelect): InvitationRow => ({
  id: r.id,
  tenantId: r.tenantId,
  clerkOrgId: r.clerkOrgId,
  clerkInvitationId: r.clerkInvitationId,
  email: r.email,
  role: r.role,
  inviterUserId: r.inviterUserId,
  expiresAt: r.expiresAt,
  zone: r.zone,
  country: r.country,
  actionUrl: r.actionUrl,
  status: r.status as InvitationStatus,
  createdAt: r.createdAt,
})

const asLevel = (n: number): AlertLevel => (n >= 100 ? 100 : n >= 80 ? 80 : 0)

/** `app.invitee_email` or `app.invitation_id`, with no workspace in scope. */
async function asOutsider<T>(
  db: Database,
  setting: "app.invitee_email" | "app.invitation_id",
  value: string,
  fn: (tx: Parameters<Parameters<Database["transaction"]>[0]>[0]) => Promise<T>,
): Promise<T> {
  return withTenant(db, NO_TENANT, async (tx) => {
    await tx.execute(sql`select set_config(${setting}, ${value}, true)`)
    return fn(tx)
  })
}

export function memberStore(db: Database): MemberStore {
  return {
    async createInvitation(tenantId, input) {
      const [made] = await withTenant(db, tenantId, (tx) =>
        tx
          .insert(memberInvitations)
          .values({ tenantId, ...input, email: input.email.toLowerCase() })
          .returning({ id: memberInvitations.id }),
      )
      return made!.id
    },

    async attachClerk(tenantId, id, clerkInvitationId) {
      await withTenant(db, tenantId, (tx) =>
        tx
          .update(memberInvitations)
          .set({ clerkInvitationId })
          .where(
            and(eq(memberInvitations.tenantId, tenantId), eq(memberInvitations.id, id)),
          ),
      )
    },

    async discard(tenantId, id) {
      await withTenant(db, tenantId, (tx) =>
        tx
          .delete(memberInvitations)
          .where(
            and(eq(memberInvitations.tenantId, tenantId), eq(memberInvitations.id, id)),
          ),
      )
    },

    async pendingInvitations(tenantId) {
      const rows = await withTenant(db, tenantId, (tx) =>
        tx
          .select()
          .from(memberInvitations)
          .where(
            and(
              eq(memberInvitations.tenantId, tenantId),
              eq(memberInvitations.status, "pending"),
            ),
          )
          .orderBy(asc(memberInvitations.expiresAt)),
      )
      return rows.map(toRow)
    },

    async invitation(tenantId, id) {
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .select()
          .from(memberInvitations)
          .where(
            and(eq(memberInvitations.tenantId, tenantId), eq(memberInvitations.id, id)),
          )
          .limit(1),
      )
      return row ? toRow(row) : null
    },

    async byClerkId(tenantId, clerkInvitationId) {
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .select()
          .from(memberInvitations)
          .where(
            and(
              eq(memberInvitations.tenantId, tenantId),
              eq(memberInvitations.clerkInvitationId, clerkInvitationId),
            ),
          )
          .limit(1),
      )
      return row ? toRow(row) : null
    },

    async due(tenantId, now) {
      const rows = await withTenant(db, tenantId, (tx) =>
        tx
          .select()
          .from(memberInvitations)
          .where(
            and(
              eq(memberInvitations.tenantId, tenantId),
              eq(memberInvitations.status, "pending"),
              lte(memberInvitations.expiresAt, now),
            ),
          ),
      )
      return rows.map(toRow)
    },

    async end(tenantId, id, status) {
      const ended = await withTenant(db, tenantId, (tx) =>
        tx
          .update(memberInvitations)
          .set({ status, endedAt: new Date() })
          .where(
            and(
              eq(memberInvitations.tenantId, tenantId),
              eq(memberInvitations.id, id),
              eq(memberInvitations.status, "pending"),
            ),
          )
          .returning({ id: memberInvitations.id }),
      )
      return ended.length > 0
    },

    async forInvitee(email, since) {
      const address = email.trim().toLowerCase()
      const [row] = await asOutsider(db, "app.invitee_email", address, (tx) =>
        tx
          .select()
          .from(memberInvitations)
          .where(
            and(
              eq(memberInvitations.email, address),
              eq(memberInvitations.status, "pending"),
              gt(memberInvitations.createdAt, since),
            ),
          )
          .orderBy(desc(memberInvitations.createdAt))
          .limit(1),
      )
      return row ? toRow(row) : null
    },

    async keepLink(email, id, actionUrl) {
      const address = email.trim().toLowerCase()
      await asOutsider(db, "app.invitee_email", address, (tx) =>
        tx
          .update(memberInvitations)
          .set({ actionUrl })
          .where(
            and(eq(memberInvitations.id, id), eq(memberInvitations.email, address)),
          ),
      )
    },

    async byLink(id) {
      const [row] = await asOutsider(db, "app.invitation_id", id, (tx) =>
        tx
          .select()
          .from(memberInvitations)
          .where(eq(memberInvitations.id, id))
          .limit(1),
      )
      return row ? toRow(row) : null
    },

    async planLimit(tenantId) {
      return withTenant(db, tenantId, async (tx) => {
        const [current] = await tx
          .select({ planId: plans.id, limit: plans.memberLimit, rank: plans.rank })
          .from(planAssignments)
          .innerJoin(plans, eq(plans.id, planAssignments.planId))
          .where(eq(planAssignments.tenantId, tenantId))
          .limit(1)
        const rank = current?.rank ?? 0
        // ⚠ CATALOGUE PLANS AND THIS WORKSPACE'S OWN CUSTOM ONES ONLY - the
        // plans policy already hides everybody else's.
        const [higher] = await tx
          .select({ id: plans.id })
          .from(plans)
          .where(
            and(
              gt(plans.rank, rank),
              or(isNull(plans.tenantId), eq(plans.tenantId, tenantId)),
            ),
          )
          .limit(1)
        return {
          planId: current?.planId ?? null,
          limit: current?.limit ?? DEFAULT_LIMIT,
          canUpgrade: Boolean(higher),
        }
      })
    },

    async workspace(tenantId) {
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .select({ name: tenants.name, clerkOrgId: tenants.clerkOrgId })
          .from(tenants)
          .where(eq(tenants.id, tenantId))
          .limit(1),
      )
      return row ?? null
    },

    async tenantOf(clerkOrgId) {
      /*
       * ⚠ TRANSLATES A CLERK ORGANIZATION FROM A SIGNATURE-VERIFIED WEBHOOK,
       * the same narrow question `requireTenant` asks of a verified session -
       * never an id from a request body.
       */
      const rows = (await db.execute(sql`
        select core.tenant_for_principal('', ${clerkOrgId}) as id
      `)) as unknown as { id: string | null }[]
      return rows[0]?.id ?? null
    },

    async alert(tenantId) {
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .select({ level: memberAlerts.level, alertedAt: memberAlerts.alertedAt })
          .from(memberAlerts)
          .where(eq(memberAlerts.tenantId, tenantId))
          .limit(1),
      )
      return { level: asLevel(row?.level ?? 0), alertedAt: row?.alertedAt ?? null }
    },

    async setAlert(tenantId, level, alertedAt) {
      await withTenant(db, tenantId, (tx) =>
        tx
          .insert(memberAlerts)
          .values({ tenantId, level, alertedAt, updatedAt: new Date() })
          .onConflictDoUpdate({
            target: memberAlerts.tenantId,
            set: { level, alertedAt, updatedAt: new Date() },
          }),
      )
    },
  }
}
