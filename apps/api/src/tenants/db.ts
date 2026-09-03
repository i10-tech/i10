import { sql } from "drizzle-orm"
import type { Database } from "../db/client.js"
import type { TenantStore } from "./provision.js"

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
