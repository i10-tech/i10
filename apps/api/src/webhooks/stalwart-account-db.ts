import { sql } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import { mailboxAuthFailures } from "../db/core.js"
import { webhookEvents } from "../db/schema.js"
import { subnetOf } from "../risk/identity.js"
import type { AccountEventOps } from "./stalwart-account.js"

/**
 * `AccountEventOps` on Postgres.
 *
 * ⚠ THE DEDUPE IS `authd.webhook_events`, THE TABLE THE CLERK WEBHOOK ALREADY
 * CLAIMS ITS IDS IN, and `onConflictDoNothing` on its primary key is the claim.
 * The ids are `stalwart_`-prefixed hashes, so they cannot collide with a Svix
 * message id.
 */
export function accountEventOps(db: Database): AccountEventOps {
  const claim = async (
    tx: Pick<Database, "insert">,
    eventId: string,
    eventType: string,
  ): Promise<boolean> => {
    const claimed = await tx
      .insert(webhookEvents)
      .values({ eventId, eventType })
      .onConflictDoNothing()
      .returning({ eventId: webhookEvents.eventId })
    return claimed.length > 0
  }

  return {
    async mailboxOwnerOf(address) {
      // ⚠ ONE QUERY: THE MAILBOX, AND ITS WORKSPACE FROM THE ROW OR ELSE FROM
      // THE DOMAIN IT IS ON. `email` is stored lowercased and the caller has
      // lowercased the address, so this is the unique index, not a scan - which
      // matters, because a scanner can make this run as often as it likes.
      // `mailbox_domains()` is the verified-and-hosting list, the same boundary
      // the projection uses.
      const rows = (await db.execute(sql`
        select a.clerk_user_id,
               coalesce(a.tenant_id, d.tenant_id)::text as tenant_id
          from authd.accounts a
          left join core.mailbox_domains() d
            on lower(d.name) = split_part(a.email, '@', 2)
         where a.email = ${address}
         limit 1
      `)) as unknown as { clerk_user_id: string; tenant_id: string | null }[]

      const row = rows[0]
      return row ? { clerkUserId: row.clerk_user_id, tenantId: row.tenant_id } : null
    },

    async recordAuthFailure({ owner, event }) {
      return withTenant(db, owner.tenantId, async (tx) => {
        if (!(await claim(tx, event.sourceEventId, event.type))) return "duplicate"

        await tx.insert(mailboxAuthFailures).values({
          tenantId: owner.tenantId,
          clerkUserId: owner.clerkUserId,
          account: event.account,
          ip: event.ip,
          subnet: subnetOf(event.ip),
          listener: event.listener,
          occurredAt: event.occurredAt,
        })
        return "recorded"
      })
    },

    async claimQuota(event) {
      return (await claim(db, event.sourceEventId, event.type))
        ? "recorded"
        : "duplicate"
    },
  }
}
