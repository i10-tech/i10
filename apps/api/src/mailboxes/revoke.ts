import type {
  DirectoryMailStore,
  MailboxLifecycle,
} from "../identity/directory-mail.js"
import { KEEP } from "../identity/directory-mail.js"
import type { AuditEvent, Logger } from "../identity/ports.js"
import { mailAccess } from "./store.js"
import type { Database } from "../db/client.js"

/**
 * The reasons a person's mail login ends that are not a company's directory
 * switching them off: they left the workspace, the workspace is gone, its domain
 * is gone. Each SUSPENDS - the login is refused (authd, before its credential
 * cache), the mailbox keeps receiving, and its mail is kept so an owner can
 * export, reassign or delete it.
 *
 * ⚠ THE PRIVILEGE BEING TAKEN AWAY IS A PASSWORD AUTHD HAS CACHED FOR HOURS. A
 * removed member's Clerk account is untouched and their password still verifies,
 * so nothing but the projection says they must not get in. That is why each of
 * these writes `authd.accounts` and not only the thing it is named for.
 *
 * ⚠ NOTHING HERE RESUMES. Re-adding a removed member does not lift the
 * suspension: an owner or admin decides about the mailbox (`resumeMailbox` in
 * identity/directory-mail.ts, behind `POST /identity/mailboxes/:userId/resume`,
 * which refuses somebody who is not a member and clears `suspended_at` only), or
 * a directory's reactivation does (`store.resume`). A login that came back on its
 * own is the failure this exists to close.
 */

export interface MailRevocationDeps {
  db: Database
  /** The lifecycle store: a per-person suspension writes its row and audit event. */
  mail: Pick<DirectoryMailStore, "suspend" | "hostedBy">
  /** Whether the person is a member of the workspace now (our roles table). */
  isMember(tenantId: string, userId: string): Promise<boolean>
  /** Whether THIS workspace's SSO or directory manages the person's account. */
  managedHere(tenantId: string, userId: string): Promise<boolean>
  /**
   * The leaver policy's suspension (identity/directory-mail.ts `suspendMailbox`),
   * resolved when used: it is built after this and only called once an event
   * arrives.
   */
  leaver(): Pick<MailboxLifecycle, "suspend">
  /** The identity audit log. A failure here never undoes a revocation. */
  record(tenantId: string, event: AuditEvent): Promise<void>
  log: Logger
  now?: () => Date
}

export type MemberOutcome = "suspended" | "already" | "no_mailbox" | "still_member"

export interface MailRevocation {
  /**
   * A member left or was removed: their mailbox in THIS workspace is suspended.
   *
   * ⚠ ONLY THIS WORKSPACE'S. A person can belong to several, and the mailbox they
   * hold in another is that workspace's (the lookup is by the domains this one
   * owns). ⚠ AND ONLY IF THEY ARE NOT A MEMBER NOW: a `deleted` event for a
   * membership that has since been replaced must not take the login of somebody
   * who is back in.
   *
   * ⚠ WHAT HAPPENS TO THE MAIL DEPENDS ON WHO LEFT. A person the workspace's own
   * SSO or directory manages is suspended by the workspace's leaver policy - the
   * very call deprovisioning makes next (managed.ts) - so whichever of the two
   * runs first sets the same plan; two writers with different plans would let a
   * race decide whether the policy applies. Anybody else is suspended and KEPT:
   * a member removed or leaving has not been through the directory, and a
   * workspace-wide "delete after N days" is for the people a directory switches
   * off, so nothing is scheduled for deletion on their behalf.
   */
  memberLeft(tenantId: string, userId: string, cause: string): Promise<MemberOutcome>
  /** The workspace is gone: every mailbox of it. Returns how many were newly suspended. */
  workspaceGone(tenantId: string, cause: string): Promise<number>
  /**
   * The workspace gave up a domain: the mailboxes on it are suspended and the
   * aliases on it removed. Called BEFORE the domain row goes, so a failure leaves
   * the domain standing and the delete can be retried.
   */
  domainGone(
    tenantId: string,
    domain: string,
  ): Promise<{ suspended: number; aliases: number }>
  /**
   * The workspace stopped hosting mail on a domain it still holds (#406). The
   * login is refused by authd's domain gate, not by a stamp on each mailbox, so
   * nothing is suspended, no alias goes and an admin's own suspension is left as
   * it was; what this does is raise each mailbox's credential epoch so no cached
   * password outlives the switch. Returns how many it reached.
   *
   * ⚠ ONLY A NAME NOBODY ELSE HOSTS, for the reason `domainGone` spells out.
   * Called AFTER the flag is off, so the domain has already left
   * `core.mailbox_domains()` and the gate is closed; a failure here leaves the
   * logins refused and the call repeatable.
   */
  domainOff(tenantId: string, domain: string): Promise<{ invalidated: number }>
}

export function mailRevocation(d: MailRevocationDeps): MailRevocation {
  const now = () => (d.now ?? (() => new Date()))()

  /** Best-effort: the revocation has already happened and must stand without its record. */
  async function audit(tenantId: string, event: AuditEvent) {
    try {
      await d.record(tenantId, event)
    } catch (error) {
      d.log.warn(
        {
          tenantId,
          type: event.type,
          err: error instanceof Error ? error.name : "error",
        },
        "could not record a mailbox revocation in the audit log",
      )
    }
  }

  return {
    async memberLeft(tenantId, userId, cause) {
      if (await d.isMember(tenantId, userId)) return "still_member"
      if (await d.managedHere(tenantId, userId))
        return d.leaver().suspend({
          tenantId,
          clerkUserId: userId,
          actorUserId: null,
          cause,
        })
      return d.mail.suspend(tenantId, userId, KEEP, now(), {
        type: "mailbox.suspended",
        subjectUserId: userId,
        reason: cause,
        data: { next: KEEP.next },
      })
    },

    async workspaceGone(tenantId, cause) {
      const ids = await mailAccess.suspendWorkspace(d.db, tenantId, now())
      if (ids.length > 0)
        await audit(tenantId, {
          type: "mailbox.workspace_suspended",
          reason: cause,
          data: { count: ids.length },
        })
      return ids.length
    },

    async domainGone(tenantId, domain) {
      /*
       * ⚠ ONLY A NAME NOBODY ELSE HOSTS. Several workspaces may hold one name as
       * pending (migration 0039), and deleting a pending row says nothing about
       * the mailboxes of whoever actually hosts it; a stale `tenant_id` on one of
       * theirs must not let this workspace suspend it. So a name hosted by another
       * workspace is not this one's to touch, and a name this one hosts also takes
       * in mailboxes whose `tenant_id` was never filled in.
       */
      const host = await d.mail.hostedBy(domain)
      if (host !== null && host !== tenantId) return { suspended: 0, aliases: 0 }
      const done = await mailAccess.suspendDomain(
        d.db,
        tenantId,
        domain,
        now(),
        host === tenantId,
      )
      if (done.suspended.length > 0 || done.aliases.length > 0)
        await audit(tenantId, {
          type: "mailbox.domain_removed",
          reason: "domain_removed",
          data: {
            domain: domain.toLowerCase(),
            suspended: done.suspended.length,
            aliases: done.aliases.length,
          },
        })
      return { suspended: done.suspended.length, aliases: done.aliases.length }
    },

    async domainOff(tenantId, domain) {
      const host = await d.mail.hostedBy(domain)
      if (host !== null && host !== tenantId) return { invalidated: 0 }
      const ids = await mailAccess.invalidateDomain(
        d.db,
        tenantId,
        domain,
        // Nobody hosts the name now (this workspace just switched it off), so the
        // mailboxes whose `tenant_id` was never filled in are this workspace's.
        host === null,
      )
      if (ids.length > 0)
        await audit(tenantId, {
          type: "mailbox.domain_hosting_off",
          reason: "hosting_off",
          data: { domain: domain.toLowerCase(), invalidated: ids.length },
        })
      return { invalidated: ids.length }
    },
  }
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value ? value : null

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null

export interface MailAccessEventDeps {
  revocation: Pick<MailRevocation, "memberLeft">
  /** The tenant behind a Clerk organization (from a verified webhook). */
  tenantOf(clerkOrgId: string): Promise<string | null>
  log: { info: (o: object, m: string) => void }
}

/**
 * `organizationMembership.deleted`: whoever leaves a workspace, however they
 * leave - our Team page, the Leave button, SCIM, or Clerk's own Frontend API -
 * loses the login of their mailbox in it.
 *
 * ⚠ IN THE WEBHOOK AND NOT IN EACH REMOVAL ROUTE, BECAUSE THE WEBHOOK IS THE ONE
 * PLACE EVERY WAY OUT PASSES THROUGH. Clerk lets any member leave on its own
 * API, which no route of ours sees. It runs AFTER our roles table has handled the
 * same event (routes/webhooks.ts order), so "not a member" is already true when
 * it asks.
 *
 * ⚠ OUTSIDE THE SVIX DEDUPE AND IDEMPOTENT, like the others, and a failure
 * answers 500 so Svix retries: a missed suspension is a login that stays open.
 */
export async function onMailAccessEvent(
  d: MailAccessEventDeps,
  type: string,
  data: unknown,
): Promise<string | null> {
  if (type !== "organizationMembership.deleted") return null
  const orgId = text(record(record(data)?.organization)?.id)
  const userId = text(record(record(data)?.public_user_data)?.user_id)
  if (!orgId || !userId) return null
  const tenantId = await d.tenantOf(orgId)
  if (!tenantId) return null

  const outcome = await d.revocation.memberLeft(tenantId, userId, "membership_removed")
  if (outcome === "suspended")
    d.log.info({ tenantId, userId }, "suspended the mailbox of a former member")
  return outcome === "suspended" ? "mailbox:suspended" : null
}
