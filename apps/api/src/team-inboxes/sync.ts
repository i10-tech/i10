import type { TeamInboxes } from "./service.js"

/**
 * Team inboxes follow the workspace.
 *
 * Membership of a team inbox is a subset of the workspace's, so when the
 * workspace loses somebody they must lose the inbox with them, and when the
 * workspace goes the inboxes go. Both arrive as Clerk webhooks.
 *
 * ⚠ NEEDS THESE EVENTS SUBSCRIBED ON CLERK'S WEBHOOK ENDPOINT:
 * `organizationMembership.deleted` and `organization.deleted`. The first is also
 * what the member-limit alerts listen to (console/members.ts), so it is already
 * on; check the second.
 *
 * ⚠ A DELETED USER NEEDS NOTHING HERE. `user.deleted` removes their `authd`
 * account, and `group_members` cascades from it.
 *
 * ⚠ ALSO RUN WHEN CLERK REDELIVERS, AND IDEMPOTENT FOR IT: removing someone who
 * is not in an inbox, or an inbox that is gone, changes nothing. A failure here
 * answers 500 so Svix retries, which is the only repair for a member who is
 * still in the directory after the workspace removed them.
 */

export interface TeamInboxSyncDeps {
  inboxes: Pick<TeamInboxes, "onMemberRemoved" | "onWorkspaceDeleted">
  /** The tenant behind a Clerk organization (from a verified webhook). */
  tenantOf(clerkOrgId: string): Promise<string | null>
  log: { info: (o: object, m: string) => void }
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value ? value : null

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null

export async function onTeamInboxEvent(
  d: TeamInboxSyncDeps,
  type: string,
  data: unknown,
): Promise<string | null> {
  switch (type) {
    case "organizationMembership.deleted": {
      const orgId = text(record(record(data)?.organization)?.id)
      const userId = text(record(record(data)?.public_user_data)?.user_id)
      if (!orgId || !userId) return null

      const tenantId = await d.tenantOf(orgId)
      if (!tenantId) return null

      const changed = await d.inboxes.onMemberRemoved(tenantId, userId)
      if (changed.length > 0) {
        d.log.info(
          { tenantId, inboxes: changed },
          "removed a former member from team inboxes",
        )
      }
      return changed.length > 0 ? `removed:${changed.length}` : null
    }

    case "organization.deleted": {
      const orgId = text(record(data)?.id)
      if (!orgId) return null

      const tenantId = await d.tenantOf(orgId)
      if (!tenantId) return null

      const gone = await d.inboxes.onWorkspaceDeleted(tenantId)
      return gone.length > 0 ? `deleted:${gone.length}` : null
    }

    default:
      return null
  }
}
