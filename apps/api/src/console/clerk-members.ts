import type { ClerkClient } from "@clerk/backend"
import { notFound } from "../mailboxes/clerk.js"
import type { ClerkMembers } from "./members.js"
import { MANAGE_MEMBERS } from "./team-domains.js"

/**
 * `ClerkMembers` over Clerk's backend API (#327), shared by the API and the
 * worker that runs the expiry jobs.
 *
 * ⚠ A HUNDRED IS THE CEILING, NOT A PAGE, as everywhere else here: Clerk's cap
 * without its add-on is 20 members, and invitations are bounded by the same
 * limit.
 */
export function clerkMembers(clerk: ClerkClient): ClerkMembers {
  return {
    async organization(orgId) {
      const org = await clerk.organizations.getOrganization({
        organizationId: orgId,
        includeMembersCount: true,
      })
      return {
        name: org.name,
        members: org.membersCount ?? 0,
        maxAllowed: org.maxAllowedMemberships,
        personal: org.publicMetadata?.kind === "personal",
      }
    },

    async pendingInvitations(orgId) {
      const { data } = await clerk.organizations.getOrganizationInvitationList({
        organizationId: orgId,
        status: ["pending"],
        limit: 100,
      })
      return data
        .map((i) => ({ id: i.id, createdAt: i.createdAt }))
        .sort((a, b) => b.createdAt - a.createdAt)
    },

    async setLimit(orgId, max) {
      await clerk.organizations.updateOrganization(orgId, {
        maxAllowedMemberships: max,
      })
    },

    async invite(input) {
      const made = await clerk.organizations.createOrganizationInvitation({
        organizationId: input.orgId,
        inviterUserId: input.inviterUserId,
        emailAddress: input.email,
        role: input.role,
        expiresInDays: input.expiresInDays,
      })
      return { id: made.id }
    },

    /*
     * ⚠ ALREADY ENDED IS DONE. Revoking an invitation that was accepted a
     * moment ago, or revoked from somewhere else, is refused by Clerk; asked
     * again, an invitation that is no longer pending needs nothing from us.
     */
    async revoke(orgId, invitationId) {
      try {
        await clerk.organizations.revokeOrganizationInvitation({
          organizationId: orgId,
          invitationId,
        })
      } catch (error) {
        if (notFound(error)) return
        const current = await clerk.organizations
          .getOrganizationInvitation({ organizationId: orgId, invitationId })
          .catch(() => null)
        if (current && current.status !== "pending") return
        throw error
      }
    },

    async removeMember(orgId, userId) {
      try {
        await clerk.organizations.deleteOrganizationMembership({
          organizationId: orgId,
          userId,
        })
      } catch (error) {
        if (!notFound(error)) throw error
      }
    },

    async admins(orgId) {
      const { data } = await clerk.organizations.getOrganizationMembershipList({
        organizationId: orgId,
        limit: 100,
      })
      return data
        .filter((m) => m.permissions.includes(MANAGE_MEMBERS))
        .flatMap((m) =>
          m.publicUserData?.identifier ? [m.publicUserData.identifier] : [],
        )
        .filter((identifier) => identifier.includes("@"))
    },
  }
}
