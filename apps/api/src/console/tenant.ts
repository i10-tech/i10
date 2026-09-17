import { eq } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import { tenants } from "../db/core.js"

/**
 * The workspace itself, as the console shows it.
 *
 * ⚠ THE NAME IS OURS AND THE MEMBERSHIP IS CLERK'S, AND THIS FILE DELIBERATELY
 * ONLY OWNS THE FIRST. `core.tenants.name` is what appears on an invoice and in
 * the console header; who belongs to the organization, what role they hold and
 * who may invite is Clerk's, answered by Clerk's own components in the browser.
 * Projecting membership into our database would give us a second copy that goes
 * stale — and the one place a stale copy of "who is an admin" matters is
 * authorization.
 *
 * ⚠ AND RENAMING HERE DOES NOT RENAME THE CLERK ORGANIZATION. They are two
 * different names for two different things: Clerk's is the identity surface a
 * member sees in the switcher, ours is the billing entity. Keeping them in sync
 * would mean a write to Clerk inside a database transaction, and a Clerk outage
 * would then make renaming a workspace impossible. The console renames both,
 * separately, and says so.
 */

export interface TenantProfile {
  id: string
  slug: string
  name: string
  status: string
  clerk_org_id: string | null
  created_at: string
}

export interface TenantProfileStore {
  get(tenantId: string): Promise<TenantProfile | null>
  rename(tenantId: string, name: string): Promise<boolean>
}

export function tenantProfileStore(db: Database): TenantProfileStore {
  return {
    async get(tenantId) {
      return withTenant(db, tenantId, async (tx) => {
        /*
         * ⚠ NO `WHERE id = …` IS NEEDED AND ONE IS WRITTEN ANYWAY. The policy
         * on `core.tenants` is `id = current_setting('app.tenant_id')`, so this
         * can only ever see one row. The predicate makes that legible to
         * somebody reading the query without the migration open, and it means
         * the query is still correct if the policy is ever widened.
         */
        const rows = await tx
          .select()
          .from(tenants)
          .where(eq(tenants.id, tenantId))
          .limit(1)

        const row = rows[0]
        if (!row) return null

        return {
          id: row.id,
          slug: row.slug,
          name: row.name,
          status: row.status,
          clerk_org_id: row.clerkOrgId,
          created_at: row.createdAt.toISOString(),
        }
      })
    },

    async rename(tenantId, name) {
      return withTenant(db, tenantId, async (tx) => {
        const updated = await tx
          .update(tenants)
          .set({ name, updatedAt: new Date() })
          .where(eq(tenants.id, tenantId))
          .returning({ id: tenants.id })
        return updated.length > 0
      })
    },
  }
}
