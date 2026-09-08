import { eq, sql } from "drizzle-orm"
import { union } from "drizzle-orm/pg-core"
import type { Mailbox } from "@repo/contracts"
import type { Database } from "../db/client.js"
import { accounts, aliases } from "../db/schema.js"
import type { MailboxDirectory } from "./provision.js"

/**
 * The projection's rows, read and gated for provisioning.
 *
 * ⚠ NO `withTenant` ANYWHERE IN THIS FILE, AND THAT IS NOT AN OVERSIGHT. The
 * `authd` schema has no row level security — no migration ever enabled it,
 * unlike every table in `core` — so wrapping these in a tenant context would
 * set a variable no policy reads and buy nothing but the appearance of safety.
 * Isolation here is `domainOwner`: a caller may only ever reach an address on a
 * domain some tenant has verified, and the seat is charged to that tenant. The
 * same reasoning is written out at `metering/levels.ts`.
 */
export function mailboxDirectory(db: Database): MailboxDirectory {
  return {
    /**
     * ⚠ THROUGH THE FUNCTION, NEVER THE TABLE. `core.mailbox_domains()` is
     * `SECURITY DEFINER` and carries the two predicates that make a domain safe
     * to host mail on — verified, and marked as hosting mailboxes. Querying
     * `core.domains` here would be a second copy of a security boundary, free
     * to drift from the one the projection uses.
     *
     * ⚠ AND IT IS THE ONE STATEMENT IN THIS FILE THAT IS NOT DRIZZLE, because
     * a set-returning function is not a table and there is nothing in the
     * schema to type it against. `projection/writer.ts` reaches for the same
     * function the same way; the typed alternative would be declaring a fake
     * table over it, which types the columns by asserting them and hides that
     * the shape is unchecked. Everything with a real table behind it —
     * `accounts`, `aliases` — goes through the query builder.
     */
    async domainOwner(domain) {
      const rows = (await db.execute(
        sql`select tenant_id::text as tenant_id
              from core.mailbox_domains()
             where lower(name) = ${domain.toLowerCase()}
             limit 1`,
      )) as unknown as { tenant_id: string | null }[]

      return rows[0]?.tenant_id ?? null
    },

    /**
     * ⚠ ACCOUNTS *AND* ALIASES. An address free in one table and taken in the
     * other is already receiving somebody's mail; checking only `accounts`
     * would hand a stranger an address that currently delivers to a real
     * person. The unique constraints would catch the first case and not the
     * second, and only after we had written to Clerk.
     */
    async addressTaken(address) {
      // ⚠ ONE ROUND TRIP, NOT TWO SELECTS. The two halves have to be answered
      // against the same snapshot: asking sequentially leaves a window where an
      // address is free in the first query and claimed as an alias before the
      // second, which is exactly the race this check exists to lose safely.
      const rows = await union(
        db
          .select({ address: accounts.email })
          .from(accounts)
          .where(eq(accounts.email, address)),
        db
          .select({ address: aliases.address })
          .from(aliases)
          .where(eq(aliases.address, address)),
      ).limit(1)

      return rows.length > 0
    },

    async current(userId) {
      const [row] = await db
        .select()
        .from(accounts)
        .where(eq(accounts.clerkUserId, userId))
        .limit(1)

      return row ? toMailbox(row) : null
    },

    /**
     * ⚠ THE ONE PLACE `active` IS EVER SET TRUE. It is the subscription gate:
     * authd's every query filters on it, so a mailbox is invisible — no bind,
     * no delivery — until this runs. It is deliberately not part of the
     * projection's upsert, which must never touch it.
     */
    async activate(userId) {
      const [row] = await db
        .update(accounts)
        .set({ active: true, updatedAt: sql`now()` })
        .where(eq(accounts.clerkUserId, userId))
        .returning()

      return row ? toMailbox(row) : null
    },
  }
}

type AccountRow = typeof accounts.$inferSelect

function toMailbox(row: AccountRow): Mailbox {
  return {
    object: "mailbox",
    address: row.email,
    display_name: row.displayName,
    active: row.active,
    created_at: row.createdAt.toISOString(),
  }
}
