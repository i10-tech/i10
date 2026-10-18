import {
  capacityOf,
  clerkLimitFor,
  memberLimitFor,
  nextAlert,
  roomReasons,
  type Capacity,
} from "./capacity.js"
import type { InvitationRow, MemberStore } from "./members-db.js"
import { expiryForEmail, resolveZone } from "./zones.js"

/**
 * Member limits per plan, invitations with a chosen expiry, and capacity
 * alerts (#327). Built on #325 (Personal workspaces) and #326 (team access).
 *
 * ⚠ CLERK'S INVITATIONS STAY. Clerk holds the invitation, its accept link and
 * the membership it creates; we hold the exact expiry, the wording of it, and
 * the decision of when a seat may be used. Clerk's own emails are off - the
 * invitation raises `email.created` and our auth mail path sends ours, with
 * the expiry this module words for it.
 *
 * ⚠ THE PLAN'S LIMIT IS ENFORCED HERE, NOT ONLY IN CLERK. Clerk's maximum is
 * never set below the members a workspace already has (see `clerkLimitFor`),
 * so a downgraded workspace over its new limit is held to it by `seats`
 * before every seat use rather than by Clerk.
 */

export interface ClerkMembers {
  organization(orgId: string): Promise<{
    name: string
    members: number
    maxAllowed: number
    personal: boolean
  }>
  /** Pending invitations, newest first, as Clerk counts them. */
  pendingInvitations(orgId: string): Promise<{ id: string; createdAt: number }[]>
  setLimit(orgId: string, max: number): Promise<void>
  /** Throws Clerk's error; see `inviteFailure`. */
  invite(input: {
    orgId: string
    inviterUserId: string
    email: string
    role: string
    expiresInDays: number
  }): Promise<{ id: string }>
  /** Already revoked, accepted or gone is done. */
  revoke(orgId: string, invitationId: string): Promise<void>
  /** Already gone is done. */
  removeMember(orgId: string, userId: string): Promise<void>
  /** Addresses of the members who may manage members. */
  admins(orgId: string): Promise<string[]>
}

/** One delayed job per invitation, at its expiry. */
export interface ExpiryScheduler {
  schedule(job: { id: string; tenantId: string }, at: Date): Promise<void>
  cancel(id: string): Promise<void>
}

export interface MemberMail {
  /** The 80% and 100% alerts, to the workspace's admins. */
  capacity(input: {
    to: string[]
    workspace: string
    level: 80 | 100
    members: number
    limit: number
    idempotencyKey: string
  }): Promise<void>
  /** "A spot opened up, you're in" - or simply "you're in". */
  accepted(input: {
    to: string
    workspace: string
    waited: boolean
    idempotencyKey: string
  }): Promise<void>
}

export interface Logger {
  info: (o: object, m: string) => void
  warn: (o: object, m: string) => void
  error: (o: object, m: string) => void
}

export interface MembersDeps {
  store: MemberStore
  clerk: ClerkMembers
  expiry?: ExpiryScheduler
  mail?: MemberMail
  /** Where an invitation email's link points: our own, which checks the clock. */
  inviteLink?: (id: string) => string
  now?: () => Date
  log: Logger
}

const clock = (d: MembersDeps) => (d.now ?? (() => new Date()))()

// ── Expiry ──────────────────────────────────────────────────────────────────

export const HOUR_MS = 60 * 60 * 1000
export const DAY_MS = 24 * HOUR_MS
export const MIN_EXPIRY_MS = HOUR_MS
export const MAX_EXPIRY_MS = 7 * DAY_MS
/**
 * ⚠ THE QUICK PICKS ARE COMPUTED IN THE BROWSER. "1 hour" is one hour from
 * the click, and arrives a little less than that from now; a browser clock a
 * minute ahead makes "7 days" a little more. Within this much either side,
 * the expiry is pulled to the bound instead of refused.
 */
export const EXPIRY_GRACE_MS = 5 * 60 * 1000

export type ExpiryCheck =
  { ok: true; at: Date } | { ok: false; error: "invalid" | "too_soon" | "too_late" }

/** An expiry from 1 hour to 7 days ahead, as one UTC instant. */
export function checkExpiry(value: unknown, now: Date): ExpiryCheck {
  const at =
    value instanceof Date
      ? value
      : typeof value === "string" || typeof value === "number"
        ? new Date(value)
        : null
  if (!at || Number.isNaN(at.getTime())) return { ok: false, error: "invalid" }
  const ahead = at.getTime() - now.getTime()
  if (ahead < MIN_EXPIRY_MS - EXPIRY_GRACE_MS) return { ok: false, error: "too_soon" }
  if (ahead > MAX_EXPIRY_MS + EXPIRY_GRACE_MS) return { ok: false, error: "too_late" }
  const clamped = Math.min(Math.max(ahead, MIN_EXPIRY_MS), MAX_EXPIRY_MS)
  return { ok: true, at: new Date(now.getTime() + clamped) }
}

/**
 * The whole days Clerk is told: the period rounded UP, so Clerk's own expiry
 * is always at or after ours. An OUTER BOUND only - our job revokes at the
 * exact second, and Clerk's expiry is what stops the link if every one of our
 * backups failed.
 */
export function clerkDays(expiresAt: Date, now: Date): number {
  const days = Math.ceil((expiresAt.getTime() - now.getTime()) / DAY_MS)
  return Math.min(7, Math.max(1, days))
}

// ── Seats ───────────────────────────────────────────────────────────────────

export interface WorkspaceSeats extends Capacity {
  personal: boolean
  canUpgrade: boolean
  /** What would make room, when full. */
  reasons: string[]
  name: string
  /** Clerk's maximum as it stands, and what it should be. */
  clerkMax: number
  clerkTarget: number
}

/** Members and invitations from Clerk, the limit from the plan. */
export async function seats(
  d: MembersDeps,
  tenantId: string,
  orgId: string,
): Promise<WorkspaceSeats> {
  const [org, pending, plan] = await Promise.all([
    d.clerk.organization(orgId),
    d.clerk.pendingInvitations(orgId),
    d.store.planLimit(tenantId),
  ])
  const capacity = capacityOf({
    members: org.members,
    invitations: pending.length,
    limit: memberLimitFor(plan.limit, org.personal),
  })
  return {
    ...capacity,
    personal: org.personal,
    canUpgrade: plan.canUpgrade,
    reasons: capacity.full
      ? roomReasons({ invitations: capacity.invitations, canUpgrade: plan.canUpgrade })
      : [],
    name: org.name,
    clerkMax: org.maxAllowed,
    clerkTarget: clerkLimitFor(capacity.limit, org.members),
  }
}

/**
 * Revokes every invitation of ours whose expiry has passed. The delayed job
 * does this at the exact second; this is the backup, run before every seat
 * use and on the pages that show the count.
 */
export async function revokeExpired(d: MembersDeps, tenantId: string): Promise<number> {
  const due = await d.store.due(tenantId, clock(d))
  for (const row of due) await expire(d, row)
  return due.length
}

async function expire(d: MembersDeps, row: InvitationRow): Promise<void> {
  if (row.clerkInvitationId) await d.clerk.revoke(row.clerkOrgId, row.clerkInvitationId)
  await d.store.end(row.tenantId, row.id, "expired")
  await d.expiry?.cancel(row.id).catch(() => {})
}

/**
 * ⚠ THE ONE CALL EVERY SEAT USE MAKES FIRST: auto-join, accepting a request,
 * sending an invitation. An expired invitation still holds a spot in Clerk's
 * count until it is revoked, so asking "is there room" before revoking it
 * would refuse somebody for a spot nobody holds.
 */
export async function beforeSeatUse(
  d: MembersDeps,
  tenantId: string,
  orgId: string,
): Promise<WorkspaceSeats> {
  await revokeExpired(d, tenantId)
  const room = await seats(d, tenantId, orgId)
  /*
   * ⚠ AND CLERK'S MAXIMUM IS PUT RIGHT IF A PLAN CHANGE'S SYNC FAILED. The
   * plan change itself must not fail on Clerk (the payment is recorded
   * either way), so this is where a missed sync heals - before the seat it
   * would otherwise refuse or allow.
   */
  if (room.clerkMax !== room.clerkTarget) {
    await d.clerk
      .setLimit(orgId, room.clerkTarget)
      .catch((error: unknown) =>
        d.log.warn(
          { err: error, tenantId },
          "could not correct the member limit in Clerk",
        ),
      )
  }
  return room
}

// ── The plan's limit, in Clerk ──────────────────────────────────────────────

/**
 * Sets Clerk's maximum to what the plan allows, on every plan change and when
 * a Personal workspace becomes a team.
 *
 * ⚠ A DOWNGRADE MOVES NOBODY OUT AND WITHDRAWS NOTHING (2026-10-14).
 * Members over the new limit stay, and so do pending invitations - an admin
 * sent them and only an admin withdraws them. Clerk's maximum is kept at
 * members plus pending invitations so it never refuses the change; nobody
 * new gets in because our checks hold the workspace to its plan, and an
 * invitation link says "full" while there is no room (see `openInvitation`).
 */
export async function syncMemberLimit(
  d: MembersDeps,
  tenantId: string,
): Promise<"synced" | "unchanged" | "no_org"> {
  const workspace = await d.store.workspace(tenantId)
  if (!workspace?.clerkOrgId) return "no_org"
  const orgId = workspace.clerkOrgId
  const [org, plan, pending] = await Promise.all([
    d.clerk.organization(orgId),
    d.store.planLimit(tenantId),
    d.clerk.pendingInvitations(orgId),
  ])
  const limit = memberLimitFor(plan.limit, org.personal)
  const target = clerkLimitFor(limit, org.members + pending.length)

  const changed = org.maxAllowed !== target
  if (changed) await d.clerk.setLimit(orgId, target)
  await evaluateAlerts(d, tenantId, orgId)
  return changed ? "synced" : "unchanged"
}

// ── Alerts ──────────────────────────────────────────────────────────────────

/**
 * Emails the admins when members cross 80% or 100% of the limit, once per
 * crossing, and re-arms below 80%. Run after anything that changes the
 * members or the limit.
 *
 * ⚠ THE NEW LEVEL IS STORED BEFORE THE EMAIL GOES, and the send is keyed on
 * the moment it was reached. Two webhooks racing store the same level; the
 * second sees nothing new to send.
 */
export async function evaluateAlerts(
  d: MembersDeps,
  tenantId: string,
  orgId: string,
): Promise<80 | 100 | null> {
  /*
   * ⚠ NOTHING WITHOUT A WAY TO SEND. Moving the stored level with no email
   * behind it would swallow the crossing for good - a process without mail
   * (the billing reconcile) leaves it to the next one with.
   */
  if (!d.mail) return null
  const [org, plan, stored] = await Promise.all([
    d.clerk.organization(orgId),
    d.store.planLimit(tenantId),
    d.store.alert(tenantId),
  ])
  // A Personal workspace is always "full" with its one person; nobody to tell.
  if (org.personal) return null
  const limit = memberLimitFor(plan.limit, false)
  const next = nextAlert(stored.level, org.members, limit)
  if (next.level === stored.level) return null
  const at = clock(d)
  await d.store.setAlert(tenantId, next.level, next.send ? at : null)
  if (!next.send) return null
  const admins = await d.clerk.admins(orgId)
  if (admins.length === 0) return next.send
  await d.mail
    .capacity({
      to: admins,
      workspace: org.name,
      level: next.send,
      members: org.members,
      limit,
      idempotencyKey: `member-capacity:${tenantId}:${next.send}:${at.getTime()}`,
    })
    .catch((error: unknown) =>
      d.log.error({ err: error, tenantId }, "capacity alert email failed"),
    )
  return next.send
}

// ── Invitations ─────────────────────────────────────────────────────────────

export type SendOutcome =
  | {
      outcome: "ok"
      sent: { id: string; email: string; expires_at: string }[]
      failed: { email: string; reason: string }[]
    }
  | { outcome: "full"; free: number; reasons: string[] }
  | { outcome: "invalid"; error: string }
  | { outcome: "personal" }

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_BATCH = 50

/** Clerk's refusal for one address, in our words. */
export function inviteFailure(error: unknown): string {
  const codes = ((error as { errors?: { code?: string }[] }).errors ?? []).map(
    (e) => e.code,
  )
  if (codes.includes("duplicate_record")) return "Already invited."
  if (codes.includes("already_a_member_in_organization")) return "Already a member."
  if (codes.includes("organization_membership_quota_exceeded"))
    return "The workspace is full."
  return "Could not send this invitation."
}

/**
 * Sends invitations through Clerk with an expiry the admin picked, and
 * schedules each one's revocation at that second.
 *
 * ⚠ OUR ROW FIRST, CLERK SECOND. Clerk's `email.created` can arrive before
 * Clerk's own answer to us does, and the email path looks our row up to state
 * the expiry; a row written after would miss it. A Clerk refusal deletes it.
 *
 * ⚠ MORE ADDRESSES THAN FREE SPOTS IS REFUSED WHOLE. Sending the first few and
 * failing the rest would leave the admin to work out who got one.
 */
export async function sendInvitations(
  d: MembersDeps,
  input: {
    tenantId: string
    orgId: string
    userId: string
    emails: unknown
    role: unknown
    expiresAt: unknown
    zone: unknown
    country?: unknown
  },
): Promise<SendOutcome> {
  const emails = Array.isArray(input.emails)
    ? [
        ...new Set(
          input.emails.flatMap((e) =>
            typeof e === "string" && e.trim() ? [e.trim().toLowerCase()] : [],
          ),
        ),
      ]
    : []
  if (emails.length === 0) return { outcome: "invalid", error: "Add an email address." }
  if (emails.length > MAX_BATCH)
    return { outcome: "invalid", error: `At most ${MAX_BATCH} invitations at once.` }
  const bad = emails.find((e) => !EMAIL.test(e))
  if (bad) return { outcome: "invalid", error: `${bad} is not an email address.` }
  if (typeof input.role !== "string" || !input.role.startsWith("org:"))
    return { outcome: "invalid", error: "Pick a role." }

  const now = clock(d)
  const expiry = checkExpiry(input.expiresAt, now)
  if (!expiry.ok)
    return {
      outcome: "invalid",
      error:
        expiry.error === "too_soon"
          ? "An invitation has to last at least an hour."
          : expiry.error === "too_late"
            ? "An invitation can last at most 7 days."
            : "Pick when the invitation expires.",
    }
  const where = resolveZone({ zone: input.zone, country: input.country })
  if (!where) return { outcome: "invalid", error: "Pick a time zone." }

  const room = await beforeSeatUse(d, input.tenantId, input.orgId)
  if (room.personal) return { outcome: "personal" }
  if (emails.length > room.free)
    return {
      outcome: "full",
      free: room.free,
      reasons: roomReasons({
        invitations: room.invitations,
        canUpgrade: room.canUpgrade,
      }),
    }

  const role = input.role
  const sent: { id: string; email: string; expires_at: string }[] = []
  const failed: { email: string; reason: string }[] = []
  for (const email of emails) {
    const id = await d.store.createInvitation(input.tenantId, {
      clerkOrgId: input.orgId,
      email,
      role,
      inviterUserId: input.userId,
      expiresAt: expiry.at,
      zone: where.zone,
      country: where.country,
    })
    try {
      const made = await d.clerk.invite({
        orgId: input.orgId,
        inviterUserId: input.userId,
        email,
        role,
        expiresInDays: clerkDays(expiry.at, now),
      })
      await d.store.attachClerk(input.tenantId, id, made.id)
    } catch (error) {
      await d.store.discard(input.tenantId, id)
      failed.push({ email, reason: inviteFailure(error) })
      continue
    }
    /*
     * ⚠ A SCHEDULING FAILURE DOES NOT UNSEND THE INVITATION. The backups -
     * revoking before every seat use, on the Team page and /usage, and the
     * webhook - still end it on time for anything that matters.
     */
    await d.expiry
      ?.schedule({ id, tenantId: input.tenantId }, expiry.at)
      .catch((error: unknown) =>
        d.log.error({ err: error, id }, "could not schedule an invitation's expiry"),
      )
    sent.push({ id, email, expires_at: expiry.at.toISOString() })
  }
  return { outcome: "ok", sent, failed }
}

/** Withdraws a pending invitation. Its expiry cannot be edited; only this. */
export async function withdrawInvitation(
  d: MembersDeps,
  input: { tenantId: string; id: string },
): Promise<"ok" | "missing"> {
  const row = await d.store.invitation(input.tenantId, input.id)
  if (!row || row.status !== "pending") return "missing"
  if (row.clerkInvitationId) await d.clerk.revoke(row.clerkOrgId, row.clerkInvitationId)
  await d.store.end(input.tenantId, row.id, "withdrawn")
  await d.expiry?.cancel(row.id).catch(() => {})
  return "ok"
}

/**
 * The delayed job's work: revoke one invitation at its expiry.
 *
 * ⚠ IT CHECKS THE CLOCK ITSELF AND NEVER REVOKES EARLY. groupmq promotes
 * delayed jobs on a timer and has been seen to run a job early in other paths
 * (see the webhook engine's notes); a job that arrives before `expires_at`
 * answers how long is left, and the caller waits or re-schedules - an
 * invitation is never cut short.
 */
export async function expireInvitation(
  d: MembersDeps,
  job: { id: string; tenantId: string },
): Promise<{ outcome: "expired" | "done" } | { outcome: "early"; ms: number }> {
  const row = await d.store.invitation(job.tenantId, job.id)
  if (!row || row.status !== "pending") return { outcome: "done" }
  const left = row.expiresAt.getTime() - clock(d).getTime()
  if (left > 0) return { outcome: "early", ms: left }
  await expire(d, row)
  return { outcome: "expired" }
}

// ── Clerk's webhooks ────────────────────────────────────────────────────────

const field = (data: unknown, key: string): string | null => {
  const value = (data as Record<string, unknown> | null)?.[key]
  return typeof value === "string" && value ? value : null
}

/**
 * `organizationInvitation.accepted`: the person is in. In time, the row is
 * marked accepted and its job cancelled.
 *
 * ⚠ LATE, THEY ARE TAKEN OUT AGAIN. An invitation we had already expired -
 * or one past its expiry that every backup missed - can still be accepted in
 * Clerk until Clerk's whole-day bound. The membership it made is removed:
 * the admin said when the offer ended, and it ended.
 */
export async function onInvitationAccepted(
  d: MembersDeps,
  data: unknown,
): Promise<string | null> {
  const invitationId = field(data, "id")
  const orgId = field(data, "organization_id")
  const userId = field(data, "user_id")
  if (!invitationId || !orgId) return null
  const tenantId = await d.store.tenantOf(orgId)
  if (!tenantId) return null
  const row = await d.store.byClerkId(tenantId, invitationId)
  const now = clock(d)
  if (row && (row.status !== "pending" || row.expiresAt.getTime() <= now.getTime())) {
    if (userId) await d.clerk.removeMember(orgId, userId)
    if (row.status === "pending") await d.store.end(tenantId, row.id, "expired")
    await d.expiry?.cancel(row.id).catch(() => {})
    d.log.warn(
      { tenantId, invitationId, userId },
      "removed a membership made through an invitation that had expired",
    )
    return "removed_late"
  }
  if (row) {
    await d.store.end(tenantId, row.id, "accepted")
    await d.expiry?.cancel(row.id).catch(() => {})
  }
  await evaluateAlerts(d, tenantId, orgId)
  return row ? "accepted" : "not_ours"
}

/** `organizationInvitation.revoked`: from anywhere, our row ends too. */
export async function onInvitationRevoked(
  d: MembersDeps,
  data: unknown,
): Promise<string | null> {
  const invitationId = field(data, "id")
  const orgId = field(data, "organization_id")
  if (!invitationId || !orgId) return null
  const tenantId = await d.store.tenantOf(orgId)
  if (!tenantId) return null
  const row = await d.store.byClerkId(tenantId, invitationId)
  if (!row) return "not_ours"
  if (row.status === "pending") await d.store.end(tenantId, row.id, "withdrawn")
  await d.expiry?.cancel(row.id).catch(() => {})
  return "revoked"
}

/** `organizationMembership.created` and `.deleted`: members moved. */
export async function onMembershipChanged(
  d: MembersDeps,
  data: unknown,
): Promise<string | null> {
  const org = (data as { organization?: { id?: unknown } } | null)?.organization
  const orgId = typeof org?.id === "string" ? org.id : null
  if (!orgId) return null
  const tenantId = await d.store.tenantOf(orgId)
  if (!tenantId) return null
  const sent = await evaluateAlerts(d, tenantId, orgId)
  return sent ? `alert:${sent}` : "checked"
}

/** `organization.created`: a new workspace starts on its plan's limit. */
export async function onOrganizationCreated(
  d: MembersDeps,
  data: unknown,
): Promise<string | null> {
  const orgId = field(data, "id")
  if (!orgId) return null
  const tenantId = await d.store.tenantOf(orgId)
  if (!tenantId) return null
  return `limit:${await syncMemberLimit(d, tenantId)}`
}

// ── The invitation email and its link ───────────────────────────────────────

/**
 * What our invitation email adds to Clerk's: when it expires, worded in the
 * zone the admin chose, and a link through us instead of straight to Clerk.
 *
 * ⚠ NULL FOR AN INVITATION WE DID NOT SEND. Somebody invited from Clerk's
 * dashboard gets the email as it was.
 */
export async function invitationEmail(
  d: MembersDeps,
  input: { to: string; actionUrl: string | null },
): Promise<{ expires: string; url: string | null } | null> {
  const since = new Date(clock(d).getTime() - HOUR_MS)
  const row = await d.store.forInvitee(input.to, since)
  if (!row) return null
  let url: string | null = null
  if (input.actionUrl && d.inviteLink) {
    await d.store.keepLink(input.to, row.id, input.actionUrl)
    url = d.inviteLink(row.id)
  }
  return { expires: expiryForEmail(row.expiresAt, row), url }
}

/**
 * Somebody opened the link in their invitation email. In time, they go on to
 * Clerk's accept link; past the expiry, the invitation is revoked now, if
 * nothing has yet, and they are told it expired.
 */
export async function openInvitation(
  d: MembersDeps,
  id: string,
): Promise<
  | { outcome: "open"; url: string }
  | { outcome: "expired" | "ended" | "missing" | "full" }
> {
  const row = await d.store.byLink(id)
  if (!row) return { outcome: "missing" }
  if (row.status === "expired") return { outcome: "expired" }
  if (row.status !== "pending") return { outcome: "ended" }
  if (row.expiresAt.getTime() <= clock(d).getTime()) {
    await expire(d, row)
    return { outcome: "expired" }
  }
  if (!row.actionUrl) return { outcome: "missing" }
  /*
   * ⚠ A WORKSPACE AT OR OVER ITS PLAN TAKES NOBODY NEW, INVITED OR NOT. After
   * a downgrade the invitations are left standing, and each one holds its own
   * place in Clerk's count - so Clerk would let it be accepted. The link says
   * "full" instead, and works again once there is room, until it expires.
   */
  const workspace = await d.store.workspace(row.tenantId)
  if (workspace?.clerkOrgId) {
    const [org, plan] = await Promise.all([
      d.clerk.organization(workspace.clerkOrgId),
      d.store.planLimit(row.tenantId),
    ])
    if (org.members >= memberLimitFor(plan.limit, org.personal))
      return { outcome: "full" }
  }
  return { outcome: "open", url: row.actionUrl }
}

// ── Accept and notify ───────────────────────────────────────────────────────

/** Tells somebody whose request was accepted that they are in. */
export async function notifyAccepted(
  d: MembersDeps,
  input: { tenantId: string; requestId: string; email: string; waited: boolean },
): Promise<void> {
  if (!d.mail) return
  const workspace = await d.store.workspace(input.tenantId)
  await d.mail.accepted({
    to: input.email,
    workspace: workspace?.name ?? "the workspace",
    waited: input.waited,
    idempotencyKey: `join-accepted:${input.requestId}`,
  })
}

/** The Clerk events this module answers; everything else is null. */
export async function onClerkEvent(
  d: MembersDeps,
  type: string,
  data: unknown,
): Promise<string | null> {
  switch (type) {
    case "organization.created":
      return onOrganizationCreated(d, data)
    case "organizationInvitation.accepted":
      return onInvitationAccepted(d, data)
    case "organizationInvitation.revoked":
      return onInvitationRevoked(d, data)
    case "organizationMembership.created":
    case "organizationMembership.deleted":
      return onMembershipChanged(d, data)
    default:
      return null
  }
}

/**
 * The plan-granting port with Clerk's member limit synced after every grant
 * (#327) - every place a workspace's plan changes goes through `grantPlan`.
 *
 * ⚠ BEST EFFORT, AFTER THE ROW. The plan is what was paid for and is already
 * written; a Clerk outage must not turn a payment into a failed webhook. A
 * missed sync is corrected before the next seat use (`beforeSeatUse`), and
 * our own checks hold the plan's limit in the meantime.
 */
export function withMemberLimitSync<
  E extends {
    grantPlan(input: {
      tenantId: string
      planId: string
      subscriptionId?: string
    }): Promise<void>
  },
>(entitlements: E, members: () => MembersDeps | null): E {
  return {
    ...entitlements,
    async grantPlan(input: {
      tenantId: string
      planId: string
      subscriptionId?: string
    }) {
      await entitlements.grantPlan(input)
      const d = members()
      if (!d) return
      await syncMemberLimit(d, input.tenantId).catch((error: unknown) =>
        d.log.error(
          { err: error, tenantId: input.tenantId, planId: input.planId },
          "plan changed but Clerk's member limit was not synced",
        ),
      )
    },
  }
}
