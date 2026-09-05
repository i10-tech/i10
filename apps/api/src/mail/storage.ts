import { sql, type SQL } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"

/**
 * How much disk each tenant's mailboxes occupy.
 *
 * ⚠ SAMPLED, NOT COUNTED, BECAUSE STORAGE GOES DOWN. A deleted folder frees
 * space, and no sum of append-only events can represent that — which is the
 * same reason `domains.sending` and `mailboxes` are levels rather than ledgers.
 * The difference here is that the number lives in another server, so we ask for
 * it on a schedule and keep the answer.
 *
 * ⚠ AND WE ASK PER MAILBOX, NOT PER TENANT, BECAUSE THE TENANT CALL IS
 * ENTERPRISE. Stalwart's registry exposes `UsedDiskQuota` on both an account and
 * a tenant, but `validate_tenant_quota` in
 * `crates/jmap/src/registry/mapping/principal.rs` is `#[cfg(feature =
 * "enterprise")]` under their SEL licence — so on the community build we run,
 * the tenant object is not ours to read. Summing accounts gives the same figure
 * for one more round trip each, and `authd.accounts.tenant_id` is what makes
 * the grouping possible at all.
 */

/**
 * ⚠ A PORT, AND ITS ADAPTER IS THE ONE THING HERE THAT NEEDS A RUNNING SERVER
 * TO VERIFY. Everything else — the grouping, the write, the level source — is
 * exercised without one.
 */
export interface MailboxStorage {
  /** Bytes this mailbox occupies. Throws if the server cannot be asked. */
  usedBytes(email: string): Promise<number>
}

export interface Logger {
  info: (o: object, m: string) => void
  warn: (o: object, m: string) => void
  error: (o: object, m: string) => void
}

/** Every mailbox the sampler asks about, grouped by owner. Cross-tenant. */
export const mailboxesStatement = (): SQL => sql`
  select tenant_id::text as tenant_id, email from core.tenant_mailboxes()
`

/**
 * ⚠ ONE ROW PER TENANT, OVERWRITTEN. A level has no history worth keeping in
 * the table the gate reads — and an append-only version would need the gate to
 * find the latest row on every check, which is a sort where an index lookup
 * would do.
 */
export const recordStorageStatement = (tenantId: string, bytes: number): SQL => sql`
  insert into core.tenant_storage (tenant_id, bytes, sampled_at)
  values (${tenantId}::uuid, ${bytes}, now())
  on conflict (tenant_id) do update
     set bytes = excluded.bytes,
         sampled_at = now()
`

export interface SampleDeps {
  db: Database
  mail: MailboxStorage
  log?: Logger
}

export interface SampleReport {
  tenants: number
  mailboxes: number
  /** Mailboxes the mail server could not answer for. */
  failed: number
}

export async function sampleStorage({
  db,
  mail,
  log,
}: SampleDeps): Promise<SampleReport> {
  const rows = (await db.execute(mailboxesStatement())) as unknown as {
    tenant_id: string
    email: string
  }[]

  const byTenant = new Map<string, string[]>()
  for (const row of rows) {
    const list = byTenant.get(row.tenant_id)
    if (list) list.push(row.email)
    else byTenant.set(row.tenant_id, [row.email])
  }

  let mailboxes = 0
  let failed = 0

  for (const [tenantId, emails] of byTenant) {
    let bytes = 0
    let complete = true

    for (const email of emails) {
      try {
        bytes += await mail.usedBytes(email)
        mailboxes += 1
      } catch (error) {
        // ⚠ ONE UNREADABLE MAILBOX POISONS THE TENANT'S TOTAL, so the total is
        // not written. A partial sum is a number that looks right and is
        // silently low — which on a cap means letting a tenant past their limit
        // and on billing means under-charging, both invisibly. Keeping the
        // previous sample is stale and honest; writing a partial one is neither.
        complete = false
        failed += 1
        log?.warn({ err: error, tenantId, email }, "could not read mailbox storage")
      }
    }

    if (!complete) continue

    await withTenant(db, tenantId, async (tx) =>
      tx.execute(recordStorageStatement(tenantId, bytes)),
    )
  }

  log?.info({ tenants: byTenant.size, mailboxes, failed }, "storage sampled")
  return { tenants: byTenant.size, mailboxes, failed }
}
