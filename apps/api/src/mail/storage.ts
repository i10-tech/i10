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
 * ⚠ AND WE SUM ACCOUNTS RATHER THAN ASKING FOR A TENANT, BECAUSE THE TENANT
 * CALL IS ENTERPRISE. Stalwart's registry exposes `usedDiskQuota` on both an
 * account and a tenant, but `validate_tenant_quota` in
 * `crates/jmap/src/registry/mapping/principal.rs` is `#[cfg(feature =
 * "enterprise")]` under their SEL licence — so on the community build we run,
 * the tenant object is not ours to read. `authd.accounts.tenant_id` is what
 * makes the grouping possible at all.
 */

/**
 * ⚠ ONE SNAPSHOT OF EVERY ACCOUNT, NOT A LOOKUP PER MAILBOX, AND THE SERVER
 * CHOSE THAT FOR US. Stalwart's account ids are opaque (`"b"`), not email
 * addresses, so there is no call that takes an address and returns usage: the
 * verified path is `x:Account/query` for ids and `x:Account/get` for their
 * objects, both of which are naturally whole-directory calls. Two round trips
 * for the entire run rather than two per mailbox.
 *
 * The map is keyed by lowercased email. A mailbox absent from it is a mailbox
 * the server did not answer for, which is the failure case below.
 */
export interface MailboxStorage {
  /** Every account the server knows: lowercased email → bytes. Throws if unreachable. */
  snapshot(): Promise<ReadonlyMap<string, number>>
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

  // ⚠ AND IF THIS THROWS, THE WHOLE RUN STOPS AND NOTHING IS WRITTEN. The
  // snapshot is all-or-nothing by construction: there is no partial answer to
  // salvage, and every tenant's previous figure standing is the honest outcome
  // of a mail server we could not reach.
  const usage = await mail.snapshot()

  let mailboxes = 0
  let failed = 0

  for (const [tenantId, emails] of byTenant) {
    let bytes = 0
    let complete = true

    for (const email of emails) {
      const used = usage.get(email.toLowerCase())

      if (used === undefined) {
        // ⚠ ONE UNREADABLE MAILBOX POISONS THE TENANT'S TOTAL, so the total is
        // not written. A partial sum is a number that looks right and is
        // silently low — which on a cap means letting a tenant past their limit
        // and on billing means under-charging, both invisibly. Keeping the
        // previous sample is stale and honest; writing a partial one is neither.
        //
        // A mailbox we know about that the mail server does not is exactly this
        // case: the two directories disagree, and the disagreement is the bug.
        complete = false
        failed += 1
        log?.warn({ tenantId, email }, "mail server did not report this mailbox")
        continue
      }

      bytes += used
      mailboxes += 1
    }

    if (!complete) continue

    await withTenant(db, tenantId, async (tx) =>
      tx.execute(recordStorageStatement(tenantId, bytes)),
    )
  }

  log?.info({ tenants: byTenant.size, mailboxes, failed }, "storage sampled")
  return { tenants: byTenant.size, mailboxes, failed }
}
