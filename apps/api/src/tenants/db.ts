import { sql } from "drizzle-orm"
import type { Database } from "../db/client.js"
import type { TenantStore } from "./provision.js"
import type { TenantLifecycleStore } from "./lifecycle.js"

/**
 * Creating the tenant row.
 *
 * ⚠ THROUGH A SECURITY DEFINER FUNCTION, BECAUSE OF A CHICKEN AND EGG IN THE
 * POLICY ITSELF. `core.tenants` is protected by
 * `id = current_setting('app.tenant_id')`, so inserting a tenant requires
 * already knowing the id of the tenant being created — and reading back one
 * that already exists requires being scoped to it, which is exactly the thing
 * we are trying to find out.
 *
 * It could be worked around by minting the uuid in the application, setting
 * `app.tenant_id` to it and inserting that id. That works for the insert and
 * fails for the far more common case: the retry, where the row already exists
 * under a different id that the policy then hides. The function answers both in
 * one round trip, and answers exactly one question — see the migration.
 */
export function tenantStore(db: Database): TenantStore {
  return {
    async provision(input) {
      const rows = (await db.execute(sql`
        select id, created
          from core.provision_tenant(
            ${input.clerkOrgId},
            ${input.slug},
            ${input.name},
            ${input.ownerClerkUserId}
          )
      `)) as unknown as { id: string; created: boolean }[]

      const row = rows[0]
      if (!row)
        throw new Error(`provision_tenant returned nothing for ${input.clerkOrgId}`)

      return { id: row.id, created: row.created }
    },
  }
}

/**
 * Ending a tenant, and asking whether a tenant id still names anybody.
 *
 * ⚠ ALL THREE GO THROUGH SECURITY DEFINER FUNCTIONS FOR THE SAME REASON
 * `provision_tenant` DOES: the caller is not scoped to the tenant it is asking
 * about, and in two of the three cases it never can be. A Clerk
 * `organization.deleted` webhook carries an organization id; a Polar customer
 * carries a tenant id that may belong to somebody who deleted their account
 * last week. Under `core.tenants`'s policy both questions return nothing at
 * all, which reads identically to "no such thing" — and acting on that reading
 * is how a paid subscription goes on billing a deleted workspace.
 *
 * See migration 0046 for what each one may answer and why it is the minimum.
 */
export function tenantLifecycleStore(db: Database): TenantLifecycleStore {
  return {
    async isLive(tenantId) {
      const rows = (await db.execute(sql`
        select core.tenant_is_live(${tenantId}) as live
      `)) as unknown as { live: boolean }[]

      // ⚠ ABSENT READS AS LIVE, WHICH IS THE CONSERVATIVE DIRECTION HERE. The
      // only caller uses this to decide whether it may overwrite somebody's
      // Polar `external_id`; a malformed answer must not become permission to
      // move another workspace's billing.
      return rows[0]?.live !== false
    },

    async terminate(clerkOrgId, freePlanId) {
      const rows = (await db.execute(sql`
        select tenant_id, polar_subscription_id, already_dead
          from core.terminate_tenant(${clerkOrgId}, ${freePlanId})
      `)) as unknown as {
        tenant_id: string
        polar_subscription_id: string | null
        already_dead: boolean
      }[]

      const row = rows[0]
      // No row means Clerk deleted an organization we never provisioned a
      // tenant for — an organization created and removed before its webhook
      // landed, or one from another instance. Not an error, and nothing to do.
      if (!row) return null

      return {
        tenantId: row.tenant_id,
        polarSubscriptionId: row.polar_subscription_id,
        alreadyDead: row.already_dead,
      }
    },

    async ownedBy(clerkUserId) {
      const rows = (await db.execute(sql`
        select tenant_id, clerk_org_id from core.tenants_owned_by(${clerkUserId})
      `)) as unknown as { tenant_id: string; clerk_org_id: string }[]

      return rows.map((r) => ({ tenantId: r.tenant_id, clerkOrgId: r.clerk_org_id }))
    },
  }
}
