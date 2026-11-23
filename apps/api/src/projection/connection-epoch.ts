import { eq, inArray, sql } from "drizzle-orm"
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
 * ⚠ IT LIVES IN ITS OWN MODULE, NOT IN `writer.ts`, for the reason
 * test/credential-epoch.test.ts gives.
 *
 * Returns the unexecuted statement, to be awaited.
 */
export function raiseConnectionCredentialEpochs(
  db: Pick<Database, "update" | "select">,
  connectionId: string,
) {
  return db
    .update(accounts)
    .set({
      credentialEpoch: sql`${accounts.credentialEpoch} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      inArray(
        accounts.clerkUserId,
        db
          .select({ id: authdManagedAccounts.clerkUserId })
          .from(authdManagedAccounts)
          .where(eq(authdManagedAccounts.connectionId, connectionId)),
      ),
    )
}
