import { and, eq } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import { domains } from "../db/core.js"
import { sesTenantName, TENANT_LAYOUT, type DomainIdentity } from "./identity.js"

/**
 * Keeps a domain's SES identity in its workspace's SES tenant (#156).
 *
 * ⚠ TWO CALLERS, ONE RULE. The store calls this right after registering an
 * identity, which covers every new domain and every transfer; the daily
 * re-check calls it for each verified domain it visits, which covers an attach
 * that failed and every domain that predates tenants. Two copies of "attach,
 * then record" would drift on the one detail that matters — the column is
 * written only after SES said yes.
 *
 * ⚠ THE COLUMN IS WHAT THE WORKER TRUSTS. A send that names a tenant is refused
 * unless the identity and the configuration set are both associated with it,
 * so the worker names one only when `ses_tenant_name` says the attach
 * succeeded. Writing it first, or on failure, would turn a missed attach into
 * refused mail instead of mail sent without tenant isolation.
 *
 * ⚠ AND A FAILURE HERE NEVER FAILS THE CALLER. Mail still goes without a tenant
 * — at the account level, exactly as it did before tenants existed — and the
 * next re-check tries again. Failing a customer's Verify because an SES
 * bookkeeping call throttled would be a worse outage than the one it prevents.
 */
export type TenancyOutcome = "attached" | "current" | "missing" | "failed"

export interface TenancyDeps {
  db: Database
  identity: Pick<DomainIdentity, "attach">
  log?: { error?: (o: object, m: string) => void }
}

export async function ensureSesTenant(
  { db, identity, log }: TenancyDeps,
  tenantId: string,
  domainId: string,
  opts: {
    /**
     * Attach even when the row already records this tenant. The store forces
     * it after a (re-)registration, because SES may hold a stale association
     * from a previous owner that the row cannot know about.
     */
    force?: boolean
  } = {},
): Promise<TenancyOutcome> {
  const wanted = sesTenantName(tenantId)

  const row = await withTenant(db, tenantId, async (tx) => {
    const [found] = await tx
      .select({
        name: domains.name,
        current: domains.sesTenantName,
        layout: domains.sesTenantLayout,
      })
      .from(domains)
      .where(and(eq(domains.tenantId, tenantId), eq(domains.id, domainId)))
      .limit(1)
    return found ?? null
  })
  if (row === null) return "missing"
  // ⚠ THE LAYOUT TOO. A domain attached before a configuration set existed is
  // in the right tenant and still missing an association SES will demand.
  if (row.current === wanted && row.layout === TENANT_LAYOUT && !opts.force) {
    return "current"
  }

  try {
    await identity.attach(row.name, wanted)
  } catch (error) {
    log?.error?.(
      { err: error, tenantId, domainId, domain: row.name, sesTenant: wanted },
      "could not attach the SES identity to its tenant — mail sends untenanted until the re-check retries",
    )
    return "failed"
  }

  await withTenant(db, tenantId, (tx) =>
    tx
      .update(domains)
      .set({ sesTenantName: wanted, sesTenantLayout: TENANT_LAYOUT })
      .where(and(eq(domains.tenantId, tenantId), eq(domains.id, domainId))),
  )
  return "attached"
}
