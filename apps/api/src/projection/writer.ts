import { and, eq, inArray, isNull, not, or, sql } from "drizzle-orm"
import type { Database } from "../db/client.js"
import { accounts, aliases, webhookEvents } from "../db/schema.js"
import { projectUser, type ClerkUser } from "./clerk-user.js"

export type ApplyOutcome =
  /** The mailbox now matches Clerk. */
  | "upserted"
  /** The user has no address in a domain we host, so they are not a recipient. */
  | "removed"
  /** A newer event has already been applied; this one is discarded. */
  | "stale"
  /** Svix delivered this message before. */
  | "duplicate"
  /** An event type the projection does not care about. */
  | "ignored"

export interface ApplyResult {
  outcome: ApplyOutcome
  email?: string
}

/**
 * Applies one Clerk webhook event to the projection, atomically.
 *
 * ⚠ THE DEDUPLICATION CLAIM AND THE WRITE SHARE ONE TRANSACTION. Claiming the
 * event id in a separate statement would leave a window where the process dies
 * after the claim and before the write: the event is recorded as handled, the
 * retry is discarded as a duplicate, and the mailbox silently never updates.
 * Rolling both back together makes a retry do the right thing.
 */
export async function applyClerkEvent(
  db: Database,
  eventId: string,
  eventType: string,
  data: unknown,
  hostedDomains: readonly string[],
): Promise<ApplyResult> {
  return db.transaction(async (tx) => {
    // Svix guarantees at-least-once delivery and can deliver concurrently,
    // which is why this is an insert with a conflict clause rather than a
    // select followed by an insert.
    const claimed = await tx
      .insert(webhookEvents)
      .values({ eventId, eventType })
      .onConflictDoNothing()
      .returning({ eventId: webhookEvents.eventId })

    if (claimed.length === 0) return { outcome: "duplicate" }

    switch (eventType) {
      case "user.created":
      case "user.updated":
        return applyUser(tx, data as ClerkUser, hostedDomains)

      case "user.deleted": {
        const { id } = (data ?? {}) as { id?: string }
        if (id) await tx.delete(accounts).where(eq(accounts.clerkUserId, id))
        return { outcome: "removed" }
      }

      default:
        // Clerk sends far more event types than the projection cares about.
        return { outcome: "ignored" }
    }
  })
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0]

/**
 * Brings one user's rows in line with Clerk.
 *
 * ⚠ `active` IS NEVER WRITTEN HERE. It is the subscription gate — whether the
 * mailbox accepts mail — and a Clerk identity event says nothing about whether
 * an invoice cleared. New rows land inactive by column default and only billing
 * flips them. Adding `active` to the update clause would silently switch every
 * suspended mailbox back on the next time its owner edited their profile.
 */
async function applyUser(
  tx: Tx,
  user: ClerkUser,
  hostedDomains: readonly string[],
): Promise<ApplyResult> {
  const mailbox = projectUser(user, hostedDomains)

  if (!mailbox) {
    // No hosted address: either they never had one, or they gave it up. Either
    // way they must stop resolving as a recipient. Aliases and memberships
    // cascade.
    await tx.delete(accounts).where(eq(accounts.clerkUserId, user.id))
    return { outcome: "removed" }
  }

  const updated = await tx
    .insert(accounts)
    .values({
      clerkUserId: mailbox.clerkUserId,
      email: mailbox.email,
      displayName: mailbox.displayName || null,
      clerkUpdatedAt: mailbox.clerkUpdatedAt,
    })
    .onConflictDoUpdate({
      target: accounts.clerkUserId,
      set: {
        email: sql`excluded.email`,
        displayName: sql`excluded.display_name`,
        clerkUpdatedAt: sql`excluded.clerk_updated_at`,
        updatedAt: sql`now()`,
      },
      // Out-of-order delivery guard. A delayed older event must not overwrite
      // newer state; a row with no timestamp yet always accepts the write.
      setWhere: or(
        isNull(accounts.clerkUpdatedAt),
        sql`excluded.clerk_updated_at >= ${accounts.clerkUpdatedAt}`,
      ),
    })
    .returning({ email: accounts.email })

  if (updated.length === 0) return { outcome: "stale" }

  // Aliases are replaced wholesale rather than diffed. The set is small, it is
  // two statements either way, and a diff still has to get removal right.
  if (mailbox.aliases.length > 0) {
    await tx
      .delete(aliases)
      .where(
        and(
          eq(aliases.clerkUserId, mailbox.clerkUserId),
          not(inArray(aliases.address, mailbox.aliases)),
        ),
      )
    await tx
      .insert(aliases)
      .values(
        mailbox.aliases.map((address) => ({
          address,
          clerkUserId: mailbox.clerkUserId,
        })),
      )
      .onConflictDoUpdate({
        target: aliases.address,
        set: { clerkUserId: sql`excluded.clerk_user_id` },
      })
  } else {
    await tx.delete(aliases).where(eq(aliases.clerkUserId, mailbox.clerkUserId))
  }

  return { outcome: "upserted", email: updated[0]!.email }
}
