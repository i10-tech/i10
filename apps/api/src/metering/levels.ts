import { sql, type SQL } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import type { LevelStore, MeterKey } from "@repo/metering"

/**
 * Where a continuous feature's level is actually read from.
 *
 * ⚠ METERING DOES NOT KEEP A COPY OF THESE NUMBERS, AND THAT IS THE WHOLE
 * DESIGN. A domain count lives in `core.domains` because that is where domains
 * live; a cached copy is the thing that goes stale, and a stale count either
 * refuses a domain the customer is entitled to or bills for one they deleted.
 * The read is a `count(*)` against an indexed tenant column, which is cheaper
 * than the invalidation logic a cache would need.
 *
 * ⚠ AND THE LEVEL COUNTS WHAT EXISTS, NOT WHAT IS VERIFIED. An unverified
 * domain holds its slot: it is a row somebody created, it is visible in their
 * dashboard, and counting only verified ones lets a tenant park fifty pending
 * domains against a limit of three. `verified_at` is deliberately absent from
 * both statements below.
 */

/** A domain that can send. An SES identity with DKIM and a MAIL FROM subdomain. */
export const SENDING_DOMAINS = "domains.sending"

/** A domain Stalwart accepts mail for. */
export const MAILBOX_DOMAINS = "domains.mailbox"

/** A person with a mailbox. The seat. */
export const MAILBOXES = "mailboxes"

/**
 * Disk occupied by a tenant's mailboxes, in BYTES.
 *
 * ⚠ BYTES, AND THE ALLOWANCE IS IN BYTES TOO. Rounding to gigabytes forces a
 * choice between a ceiling — where one byte past ten gigabytes reads as eleven
 * and refuses — and a floor, which hands out up to a gigabyte free. Neither is
 * defensible on a cap, and with both sides exact there is nothing to round.
 */
export const STORAGE = "storage.bytes"

/**
 * ⚠ TWO STATEMENTS RATHER THAN ONE WITH THE COLUMN SUBSTITUTED IN. The column
 * comes from a closed set and never from a request, so interpolating it would
 * be safe today — and it would put an identifier into SQL text built at
 * runtime, which is a pattern that stops being safe the first time somebody
 * adds a feature id that comes from a plan row. Two statements cost four lines
 * and remove the question.
 *
 * ⚠ AND A DOMAIN THAT DOES BOTH IS COUNTED BY BOTH. `sends` and
 * `hosts_mailboxes` are independent booleans and these are two counts over two
 * flags, not a partition of one total. Otherwise the cheapest way to hold a
 * domain is to claim both roles for it, and both limits stop meaning anything.
 */
export const sendingDomainsStatement = (tenantId: string): SQL => sql`
  select count(*)::bigint as level
    from core.domains
   where tenant_id = ${tenantId}::uuid
     and sends
`

export const mailboxDomainsStatement = (tenantId: string): SQL => sql`
  select count(*)::bigint as level
    from core.domains
   where tenant_id = ${tenantId}::uuid
     and hosts_mailboxes
`

/**
 * Seats: one row per person who has a mailbox on one of this tenant's domains.
 *
 * ⚠ `authd.accounts.tenant_id` IS SET FROM THE DOMAIN, AND NOTHING WROTE IT
 * UNTIL 0016. A mailbox on acme.com belongs to whoever proved they control
 * acme.com — not to the holder's Clerk organisation, which they may have
 * several of or none. Before that migration this count returned zero for every
 * tenant, which is why the feature was left out of this store rather than
 * shipped as a limit that never fires.
 *
 * ⚠ AND IT COUNTS EVERY ROW, INCLUDING INACTIVE ONES. `active` is the
 * subscription gate — a suspended mailbox still exists, still holds its
 * storage, and its address is still reserved. Counting only active ones would
 * let a tenant hold any number of seats by having them switched off, and would
 * make a suspended account free.
 *
 * ⚠ THE `authd` SCHEMA HAS NO ROW LEVEL SECURITY — no migration ever enabled
 * it, unlike every table in `core`. The WHERE clause below is therefore the
 * whole of the isolation rather than defence in depth, and it must never be
 * dropped in favour of trusting the transaction's tenant context.
 */
export const mailboxesStatement = (tenantId: string): SQL => sql`
  select count(*)::bigint as level
    from authd.accounts
   where tenant_id = ${tenantId}::uuid
`

/**
 * ⚠ THE LAST SAMPLE, NOT A LIVE READ. Storage lives in Stalwart and is sampled
 * on a schedule — see src/mail/storage.ts. Asking the mail server on the
 * request path would put its availability inside ours for an accuracy nobody
 * can use: the figure moves continuously and a plan limit does not need it to
 * the byte-second.
 *
 * ⚠ AND A TENANT WITH NO SAMPLE READS AS ZERO, WHICH IS CORRECT HERE AND ONLY
 * HERE. No row means no mailbox has ever been sampled for them — they hold no
 * storage. That is the one case where the absent-row answer is the true one,
 * unlike an unknown FEATURE, which throws.
 */
export const storageStatement = (tenantId: string): SQL => sql`
  select coalesce(bytes, 0)::bigint as level
    from core.tenant_storage
   where tenant_id = ${tenantId}::uuid
`

const SOURCES: Readonly<Record<string, (tenantId: string) => SQL>> = {
  [SENDING_DOMAINS]: sendingDomainsStatement,
  [MAILBOX_DOMAINS]: mailboxDomainsStatement,
  [MAILBOXES]: mailboxesStatement,
  [STORAGE]: storageStatement,
}

export function postgresLevels(db: Database): LevelStore {
  return {
    async levelOf(key: MeterKey) {
      // ⚠ THROWS FOR A FEATURE IT DOES NOT KNOW, AND RETURNING 0 WOULD BE THE
      // WORST POSSIBLE DEFAULT. Zero held means the whole allowance is
      // available, so a plan granting `mailboxes` against a store that cannot
      // count them would hand every tenant an unlimited number — silently, and
      // in the customer's favour, which is the direction nobody reports.
      const statement = SOURCES[key.featureId]
      if (statement === undefined) {
        throw new Error(`no level source for ${key.featureId}`)
      }

      // ⚠ A LEVEL IS NEVER SHARDED. Splitting a consumable allowance across
      // shards is arithmetic; splitting "how many domains exist" is not a
      // question with an answer. The key carries a shard because every key
      // does, and a non-zero one here means a caller believes something about
      // this feature that is not true.
      if (key.shard !== 0) {
        throw new RangeError(
          `${key.featureId} is a continuous feature and cannot be sharded`,
        )
      }

      // `core.domains` is under row level security, so the tenant context is
      // required there. `authd.accounts` is NOT — see `mailboxesStatement` —
      // so for that one the WHERE clause is the whole boundary. The wrapper is
      // uniform because a reader should not have to know which is which to see
      // that both are scoped.
      return withTenant(db, key.tenantId, async (tx) => {
        const rows = (await tx.execute(statement(key.tenantId))) as unknown as {
          level: string | number
        }[]
        // `count(*)` is bigint, which postgres-js hands back as a string.
        return Number(rows[0]?.level ?? 0)
      })
    },
  }
}
