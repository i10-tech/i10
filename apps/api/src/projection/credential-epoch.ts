import { eq, sql } from "drizzle-orm"
import type { Database } from "../db/client.js"
import { accounts } from "../db/schema.js"

/**
 * Kills every cached mail-password verification for one person, on every
 * Stalwart pod, by raising `authd.accounts.credential_epoch`.
 *
 * authd remembers a verified password for hours and compares the epoch on each
 * hit, so this is what makes the next IMAP or SMTP login ask the identity
 * provider again. Call it from a revocation that leaves the account row ACTIVE
 * and does not move `clerk_updated_at`: access taken away by something other
 * than a password change, a delete, or a deactivation.
 *
 * ⚠ DO NOT CALL IT FOR THOSE THREE. A password change in Clerk already moves
 * `clerk_updated_at` through `user.updated`; a deleted row and an `active = false`
 * row are turned away by authd's projection lookup before the cache is read.
 * Bumping here too would only make the next bind pay for a provider call.
 *
 * ⚠ ONE STATEMENT, AND THE INCREMENT IS IN SQL. Reading the value and writing
 * back `n + 1` would let two writers raise it to the same number, and a missed
 * raise is a cached password that survives its revocation. Pass the transaction
 * when the revocation is in one, so the epoch moves with it or not at all.
 *
 * Returns the unexecuted statement, to be awaited, so a test can read its SQL.
 * A user with no row is a no-op: there is nothing cached for them.
 */
export function raiseCredentialEpoch(
  db: Pick<Database, "update">,
  clerkUserId: string,
) {
  return db
    .update(accounts)
    .set({
      credentialEpoch: sql`${accounts.credentialEpoch} + 1`,
      updatedAt: sql`now()`,
    })
    .where(eq(accounts.clerkUserId, clerkUserId))
}
