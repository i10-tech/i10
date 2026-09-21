import { sql } from "drizzle-orm"
import type { Database } from "../db/client.js"
import type { NameHolder } from "../dns/publish.js"

/**
 * Who has proven a domain name, across every workspace.
 *
 * ⚠ ITS OWN MODULE RATHER THAN A METHOD ON `DomainStore`, BECAUSE IT IS THE
 * ONE QUESTION HERE THAT IS NOT SCOPED TO A TENANT. Everything in that store
 * runs inside `withTenant` and answers "what does this workspace have";
 * `core.verified_holder` is `SECURITY DEFINER` precisely so it can answer
 * "does anybody else". Hanging it off the tenant-scoped store is how somebody
 * later assumes the wrong one of those.
 *
 * ⚠ AND THE PUBLISHER TAKES THE PORT, NOT THIS. See `NameHolder`: the only
 * thing the answer gates is whether a record that looks like ours may be
 * deleted, and a test needs to be able to say "somebody else holds it"
 * without a database.
 */
export function nameClaims(db: Database): NameHolder {
  return {
    async verifiedHolder(name) {
      const rows = (await db.execute(
        sql`select domain_id from core.verified_holder(${name.trim().toLowerCase()})`,
      )) as unknown as { domain_id: string }[]
      return rows[0]?.domain_id ?? null
    },
  }
}
