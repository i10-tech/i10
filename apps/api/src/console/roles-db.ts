import { and, eq, sql } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import { workspaceRoles } from "../db/core.js"
import {
  readRole,
  type Decision,
  type Role,
  type RoleRow,
  type RoleSource,
  type RoleStore,
} from "./roles.js"

/**
 * The database half of workspace roles (#335). See `workspace_roles` in
 * db/core.ts for the policy, and console/roles.ts for every decision.
 */

const SOURCES: readonly RoleSource[] = [
  "creator",
  "invitation",
  "access_rule",
  "membership",
  "changed",
  "backfill",
  "sso",
  "scim",
]

const toRow = (r: typeof workspaceRoles.$inferSelect): RoleRow => ({
  userId: r.clerkUserId,
  role: readRole(r.role),
  membershipId: r.clerkMembershipId,
  source: (SOURCES as readonly string[]).includes(r.source)
    ? (r.source as RoleSource)
    : "membership",
  grantedBy: r.grantedBy,
})

export function roleStore(db: Database): RoleStore {
  return {
    async roleOf(tenantId, userId): Promise<Role | null> {
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .select({ role: workspaceRoles.role })
          .from(workspaceRoles)
          .where(
            and(
              eq(workspaceRoles.tenantId, tenantId),
              eq(workspaceRoles.clerkUserId, userId),
            ),
          )
          .limit(1),
      )
      return row ? readRole(row.role) : null
    },

    async list(tenantId) {
      const rows = await withTenant(db, tenantId, (tx) =>
        tx
          .select()
          .from(workspaceRoles)
          .where(eq(workspaceRoles.tenantId, tenantId))
          .orderBy(workspaceRoles.createdAt),
      )
      return rows.map(toRow)
    },

    async transact<T>(
      tenantId: string,
      decide: (rows: RoleRow[]) => Decision<T>,
    ): Promise<T> {
      return withTenant(db, tenantId, async (tx) => {
        /*
         * ⚠ ONE LOCK PER WORKSPACE, AND IT HAS TO BE AN ADVISORY ONE. Row
         * locks cannot serialise a decision about a row that does not exist
         * yet - the webhook and our own `addMember` both finding nobody, both
         * inserting - nor one about rows somebody else is changing, like the
         * other owner. `_xact_` because PgBouncer pools by transaction; the
         * lock goes with the commit.
         */
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`workspace_roles:${tenantId}`}, 0))`,
        )
        const rows = (
          await tx
            .select()
            .from(workspaceRoles)
            .where(eq(workspaceRoles.tenantId, tenantId))
        ).map(toRow)
        const decision = decide(rows)
        const now = new Date()
        for (const write of decision.writes) {
          if ("remove" in write) {
            await tx
              .delete(workspaceRoles)
              .where(
                and(
                  eq(workspaceRoles.tenantId, tenantId),
                  eq(workspaceRoles.clerkUserId, write.remove),
                ),
              )
            continue
          }
          const row = write.put
          const values = {
            role: row.role,
            clerkMembershipId: row.membershipId,
            source: row.source,
            grantedBy: row.grantedBy,
            updatedAt: now,
          }
          await tx
            .insert(workspaceRoles)
            .values({ tenantId, clerkUserId: row.userId, ...values })
            .onConflictDoUpdate({
              target: [workspaceRoles.tenantId, workspaceRoles.clerkUserId],
              set: values,
            })
        }
        return decision.result
      })
    },
  }
}
