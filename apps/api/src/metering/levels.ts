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

const SOURCES: Readonly<Record<string, (tenantId: string) => SQL>> = {
  [SENDING_DOMAINS]: sendingDomainsStatement,
  [MAILBOX_DOMAINS]: mailboxDomainsStatement,
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
      // required — the WHERE clause below is defence in depth, not the boundary.
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
