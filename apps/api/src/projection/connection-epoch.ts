import { asc, eq, inArray, sql } from "drizzle-orm"
import type { Database } from "../db/client.js"
import { accounts, authdManagedAccounts } from "../db/schema.js"

/**
 * Kills every cached mail-password verification for the accounts one connection
 * manages, on every Stalwart pod, by raising their `authd.accounts.
 * credential_epoch` (see `raiseCredentialEpoch`, which does it for one person).
 *
 * For a change to a connection's settings rather than to a person: a different
 * Okta org, or Okta mail sign-in switched off, must stop answering from a
 * success the old settings minted. An account that has never authenticated has
 * no row and nothing cached, so it is not touched.
 *
 * ⚠ ONE STATEMENT, AND THE INCREMENT IS IN SQL, for the reason `raiseCredentialEpoch`
 * gives: a missed raise is a cached password that survives its revocation.
 *
 * ⚠ DETERMINISTIC LOCK ORDER: locks target `authd.accounts` rows in ascending
 * `clerk_user_id` order (`FOR NO KEY UPDATE`) before updating so concurrent bulk
 * updates (`suspendWorkspace`, `suspendDomain`, `raiseConnectionCredentialEpochs`)
 * cannot deadlock on overlapping accounts.
 *
 * ⚠ IT LIVES IN ITS OWN MODULE, NOT IN `writer.ts`, for the reason
 * test/credential-epoch.test.ts gives.
 *
 * Returns the unexecuted statement, to be awaited.
 */
export function raiseConnectionCredentialEpochs(
  db: Pick<Database, "update" | "select" | "with" | "$with">,
  connectionId: string,
) {
  const locked = db.$with("locked").as(
    db
      .select({ id: accounts.clerkUserId })
      .from(accounts)
      .where(
        inArray(
          accounts.clerkUserId,
          db
            .select({ id: authdManagedAccounts.clerkUserId })
            .from(authdManagedAccounts)
            .where(eq(authdManagedAccounts.connectionId, connectionId)),
        ),
      )
      .orderBy(asc(accounts.clerkUserId))
      .for("no key update"),
  )
  return db
    .with(locked)
    .update(accounts)
    .set({
      credentialEpoch: sql`${accounts.credentialEpoch} + 1`,
      updatedAt: sql`now()`,
    })
    .from(locked)
    .where(eq(accounts.clerkUserId, locked.id))
}
