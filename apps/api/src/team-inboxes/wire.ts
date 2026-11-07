import type { ClerkClient } from "@clerk/backend"
import type { Database } from "../db/client.js"
import { jmapAs } from "../mail/jmap-as.js"
import { teamMail, type TeamMail } from "../mail/team-mail.js"
import { teamInboxes, type TeamInboxes } from "./service.js"
import { teamInboxStore } from "./store.js"

/**
 * Team inboxes, assembled from the environment: Clerk for who is in the
 * workspace, our roles table for who may manage it, Postgres for the directory
 * rows, Stalwart for the account.
 */

interface StalwartEnv {
  STALWART_URL?: string | undefined
  STALWART_API_TOKEN?: string | undefined
  STALWART_IMPERSONATE_TOKEN?: string | undefined
}

/**
 * The Stalwart side, or `null` without all three settings.
 *
 * ⚠ ALL THREE OR NOTHING. The registry lookup uses the admin token and the mail
 * calls use the impersonation key (see mail/jmap-as.ts); a half-configured
 * deployment would resolve an account and then be unable to act on it, or the
 * reverse.
 */
export function teamMailFor(env: StalwartEnv): TeamMail | null {
  if (!env.STALWART_URL || !env.STALWART_API_TOKEN || !env.STALWART_IMPERSONATE_TOKEN) {
    return null
  }
  return teamMail(
    jmapAs({
      baseUrl: env.STALWART_URL,
      registryToken: env.STALWART_API_TOKEN,
      impersonationToken: env.STALWART_IMPERSONATE_TOKEN,
    }),
  )
}

export function teamInboxesFor(input: {
  db: Database
  clerk: ClerkClient
  mail: TeamMail | null
  /**
   * Whether this person holds `members:manage` in the workspace. Our roles table
   * (#335), not Clerk's permissions: Clerk's roles are powerless, so asking
   * Clerk would call every admin a member.
   */
  isAdmin: (tenantId: string, userId: string) => Promise<boolean>
}): TeamInboxes {
  const { clerk, mail } = input

  return teamInboxes({
    store: teamInboxStore(input.db),

    isAdmin: input.isAdmin,

    // ⚠ A HUNDRED IS THE CEILING, NOT A PAGE, as in console/clerk-members.ts.
    async roster(orgId) {
      const { data } = await clerk.organizations.getOrganizationMembershipList({
        organizationId: orgId,
        limit: 100,
      })
      return new Set(
        data.flatMap((m) =>
          m.publicUserData?.userId ? [m.publicUserData.userId] : [],
        ),
      )
    },

    // Without Stalwart configured there is no account to destroy (a dev setup).
    destroyAccount: async (team) => (mail ? mail.destroy(team) : false),
    revokeAccess: async (team, addresses) => {
      if (mail)
        await mail.revoke(
          team,
          addresses.map((address) => ({ address })),
        )
    },
  })
}
