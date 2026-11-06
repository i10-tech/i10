import { and, count, countDistinct, eq, gte, max } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import { mailboxAuthFailures } from "../db/core.js"

/**
 * What failed sign-ins to one mailbox look like over a window (#384).
 *
 * ⚠ NOT WIRED INTO THE SCORE YET. The signal is recorded so there is history
 * when a rule wants it. `loadFacts` (facts.ts) is where this would be called
 * per workspace, and a rule in rules.ts would turn "many failures from many
 * addresses" into a contribution. Reading it changes nothing until then.
 */
export interface AuthFailureSummary {
  failures: number
  /** Distinct client addresses: one address hammering is a bot, many is a botnet. */
  distinctIps: number
  distinctSubnets: number
  lastAt: Date | null
}

export async function mailboxAuthFailureSummary(
  db: Database,
  input: { tenantId: string; account: string; since: Date },
): Promise<AuthFailureSummary> {
  const [row] = await withTenant(db, input.tenantId, (tx) =>
    tx
      .select({
        failures: count(),
        distinctIps: countDistinct(mailboxAuthFailures.ip),
        distinctSubnets: countDistinct(mailboxAuthFailures.subnet),
        lastAt: max(mailboxAuthFailures.occurredAt),
      })
      .from(mailboxAuthFailures)
      .where(
        and(
          eq(mailboxAuthFailures.tenantId, input.tenantId),
          eq(mailboxAuthFailures.account, input.account.toLowerCase()),
          gte(mailboxAuthFailures.occurredAt, input.since),
        ),
      ),
  )

  return {
    failures: row?.failures ?? 0,
    distinctIps: row?.distinctIps ?? 0,
    distinctSubnets: row?.distinctSubnets ?? 0,
    lastAt: row?.lastAt ?? null,
  }
}
