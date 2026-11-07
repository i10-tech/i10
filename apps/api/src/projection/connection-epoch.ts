import { eq, inArray, sql } from "drizzle-orm"
import type { Database } from "../db/client.js"
import { accounts, authdManagedAccounts } from "../db/schema.js"

/**
 * authd keeps a connection's settings for up to this long (`MaxCacheTTL` in
 * services/authd/internal/passthrough/settings.go). Keep the two together.
 */
export const AUTHD_SETTINGS_TTL_MS = 60_000

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

/**
 * Runs `raise` once more after authd has forgotten the settings it held when the
 * first one ran. Does not wait: the caller has already raised, and answers.
 *
 * ⚠ ONCE IS NOT ENOUGH. authd answers from a connection's settings for up to
 * AUTHD_SETTINGS_TTL_MS after they change, so a mail client that reconnects in
 * that minute is verified against the OLD settings and remembered under the NEW
 * epoch. This second raise, just after the minute, removes what that minted. It
 * is a timer in this process: if the process is gone before it fires, that entry
 * lives out its cache limit (fifteen minutes for Okta) and no longer.
 */
export function raiseAgainWhenAuthdForgets(
  raise: () => PromiseLike<unknown>,
  options: {
    schedule?: (run: () => void, ms: number) => void
    onFailure?: (error: unknown) => void
  } = {},
): void {
  const schedule = options.schedule ?? ((run, ms) => void setTimeout(run, ms).unref?.())
  schedule(() => {
    // An async wrapper, so a raise that throws before it returns anything is a
    // failure like any other and not an uncaught exception out of a timer.
    void (async () => {
      await raise()
    })().catch((error: unknown) => options.onFailure?.(error))
  }, AUTHD_SETTINGS_TTL_MS + 5_000)
}
