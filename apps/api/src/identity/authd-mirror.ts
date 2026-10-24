import { eq } from "drizzle-orm"
import type { Database } from "../db/client.js"
import { authdManagedAccounts } from "../db/schema.js"

/**
 * What authd is told about managed accounts (#344): ONE place that writes
 * `authd.managed_accounts`.
 *
 * ⚠ A MANAGED ACCOUNT IS NEVER SENT TO CLERK'S verify_password. authd only
 * knows an account is managed because of the row written here, so every path
 * that makes, moves or ends a managed account (identity/store.ts) goes through
 * these two functions, inside the SAME transaction as the change to
 * `identity.managed_accounts`: a crash cannot leave the account managed in one
 * table and free in the other.
 *
 * ⚠ THE FAILURE THAT MATTERS IS A MISSING ROW, because a missing row reads as
 * "not managed" and a not-managed account is asked of Clerk. The company took
 * its password away, so Clerk would answer no; but the rule is that authd does
 * not ask at all, and the one-writer shape is what keeps it true.
 */

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0]

/** The account is managed, and its binds are answered by `connectionId`'s pass-through. */
export async function mirrorManaged(
  tx: Tx,
  clerkUserId: string,
  connectionId: string | null,
): Promise<void> {
  const now = new Date()
  await tx
    .insert(authdManagedAccounts)
    .values({ clerkUserId, connectionId, updatedAt: now })
    .onConflictDoUpdate({
      target: authdManagedAccounts.clerkUserId,
      set: { connectionId, updatedAt: now },
    })
}

/** The account is not managed any more: released, or its user is gone. */
export async function unmirrorManaged(tx: Tx, clerkUserId: string): Promise<void> {
  await tx
    .delete(authdManagedAccounts)
    .where(eq(authdManagedAccounts.clerkUserId, clerkUserId))
}
