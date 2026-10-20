/**
 * Workspace roles and permissions, ours (#335).
 *
 * ⚠ CLERK'S ROLES ARE POWERLESS NOW, AND THIS IS WHERE THE POWER WENT. Probe
 * P6 (docs/decisions/sso.md, Part 5) showed a Clerk `org:admin` can invite,
 * remove and re-role members straight at Clerk's Frontend API, skipping our
 * waiting list, block list and anything else we put in front of a seat. So
 * every Clerk membership and invitation we make is `org:member` (reads only),
 * and who may do what in a workspace is a row in `core.workspace_roles`,
 * checked here, by our API, with no Clerk call on the way.
 *
 * ⚠ EXCEPT FOR ONE MOMENT: A WORKSPACE'S CREATOR. Clerk refuses a powerless
 * `creator_role` (`organization_missing_creator_role_permissions`: it must
 * hold `sys_memberships:manage`, `sys_profile:delete` and
 * `sys_memberships:read`), and provisioning needs Clerk's `created_by`, so
 * every creator starts as a Clerk admin. We create workspaces ourselves and
 * demote the creator in the same request (`createWorkspace`), and the
 * membership webhooks demote any powerful Clerk role they see from anywhere
 * else (`fixClerkRole`). `domains_default_role` can simply be `org:member`.
 *
 * ⚠ ONE MAP, ONE PLACE. Roles are a closed set and permissions are our own
 * strings; a role is exactly the permissions `ROLE_PERMISSIONS` gives it. A
 * new role (IT admin, billing) is a key here and a value in the table's check.
 *
 * ⚠ NO ROW MEANS MEMBER. A Clerk member we hold nothing for - a webhook still
 * in Svix's retry queue, a membership from before this existed - gets the least
 * a member can do, never more. Owners and admins always have a row.
 */

// ── Roles and what they may do ──────────────────────────────────────────────

export const ROLES = ["owner", "admin", "member"] as const
export type Role = (typeof ROLES)[number]

export const PERMISSIONS = [
  /** Invite, withdraw, answer requests, remove people, the removed and block lists. */
  "members:manage",
  /** Team access domains and their rules. */
  "access_domains:manage",
  /** Make a member an admin or an admin a member. */
  "roles:manage",
  /** Make somebody an owner, or remove or demote one. */
  "owners:manage",
  /** The workspace's name and logo. */
  "workspace:manage",
  /** Delete the workspace. */
  "workspace:delete",
  /**
   * SSO connections, their domains, enforcement and session policy, and what
   * deprovisioning does (#337). The IT-admin role (sso.md 2.11) will hold it
   * without billing.
   */
  "sso:manage",
] as const
export type Permission = (typeof PERMISSIONS)[number]

/**
 * ⚠ A MEMBER HOLDS NOTHING HERE, AND THAT IS TODAY'S MEMBER EXACTLY. Every
 * route that asked Clerk for a system permission asked for one `org:member`
 * never had (`sys_memberships:manage`, `sys_domains:manage`); everything else
 * in the console was never gated on a role and still is not.
 */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  owner: PERMISSIONS,
  admin: [
    "members:manage",
    "access_domains:manage",
    "roles:manage",
    "workspace:manage",
    "sso:manage",
  ],
  member: [],
}

export const ROLE_LABELS: Readonly<Record<Role, string>> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
}

export function permissionsOf(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role]
}

export function may(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission)
}

/**
 * The roles somebody may give an existing member: an owner any of them, an
 * admin only admin or member.
 */
export function grantable(role: Role): Role[] {
  if (may(role, "owners:manage")) return [...ROLES]
  if (may(role, "roles:manage")) return ROLES.filter((r) => r !== "owner")
  return []
}

/**
 * The roles a person can join with: by invitation or by an access rule.
 *
 * ⚠ NEVER OWNER. Ownership is handed to somebody already in the workspace, by
 * an owner, on the Team page - not to whoever holds an address at a domain or
 * an email that might be forwarded.
 */
export const JOIN_ROLES = ["member", "admin"] as const satisfies readonly Role[]
export type JoinRole = (typeof JOIN_ROLES)[number]

/** Who joins with no rule, no invitation, or a rule that no longer applies. */
export const DEFAULT_ROLE: JoinRole = "member"

/** The roles an admin or owner may invite with. */
export function invitable(role: Role): JoinRole[] {
  return may(role, "members:manage") ? [...JOIN_ROLES] : []
}

/**
 * What Clerk is told for every membership and invitation we make. Reads only:
 * `sys_memberships:read`, `sys_billing:read`.
 */
export const CLERK_ROLE = "org:member"

// ── Reading and validating ──────────────────────────────────────────────────

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value)
}

/**
 * ⚠ CLERK'S KEYS ARE STILL IN THE DATA. Access rules and invitations written
 * before #335 hold `org:admin` and `org:member`; they read as our keys, and
 * anything unrecognised reads as member. Only our keys are ever written.
 */
const LEGACY: Readonly<Record<string, Role>> = {
  "org:admin": "admin",
  "org:member": "member",
}

/** A stored role. Legacy Clerk keys are mapped; anything else is member. */
export function readRole(value: unknown): Role {
  if (isRole(value)) return value
  if (typeof value === "string" && value in LEGACY) return LEGACY[value]!
  return "member"
}

/** A stored rule's or invitation's role: never owner, whatever was stored. */
export function readJoinRole(value: unknown): JoinRole {
  const role = readRole(value)
  return role === "owner" ? DEFAULT_ROLE : role
}

/**
 * A role from a request, or null. Our keys, and Clerk's two old ones mapped,
 * so a console tab left open across the deploy still saves.
 */
export function parseRole(value: unknown): Role | null {
  if (typeof value !== "string") return null
  const key = value.trim()
  if (isRole(key)) return key
  return LEGACY[key] ?? null
}

/** A joining role from a request, or null; owner is refused. */
export function parseJoinRole(value: unknown): JoinRole | null {
  const role = parseRole(value)
  return role === null || role === "owner" ? null : role
}

// ── The table's rows, and the decisions made about them ─────────────────────

/** Why a row says what it says. */
export type RoleSource =
  /** The person who created the workspace. */
  | "creator"
  /** Joined through one of our invitations. */
  | "invitation"
  /** Joined through an access rule: auto-join, Join, or an accepted request. */
  | "access_rule"
  /** A membership Clerk told us about with nothing else to go on. */
  | "membership"
  /** Changed by an owner or admin on the Team page. */
  | "changed"
  /** Written by scripts/workspace-roles.ts from Clerk's roles before #335. */
  | "backfill"

export interface RoleRow {
  userId: string
  role: Role
  /**
   * Clerk's membership this row describes. Null when it was written before
   * Clerk's `organizationMembership.created` named it: the creator's row, made
   * on `organization.created`, and rows the backfill or a role change wrote.
   */
  membershipId: string | null
  source: RoleSource
  /** Who gave it: a Clerk user id, or null when the system did. */
  grantedBy: string | null
}

export type RoleWrite = { put: RoleRow } | { remove: string }

export interface Decision<T> {
  writes: RoleWrite[]
  result: T
}

/**
 * The table, per workspace.
 *
 * ⚠ EVERY WRITE IS A READ-DECIDE-WRITE UNDER ONE LOCK PER WORKSPACE. `transact`
 * hands `decide` every row of the workspace (a workspace has at most a few
 * dozen) while holding the workspace's lock, and applies what it returns in
 * the same transaction. So "is this the last owner" and "who got here first,
 * the webhook or our own call" are answered against rows nobody else can be
 * changing - and all the deciding is the pure functions below.
 */
export interface RoleStore {
  roleOf(tenantId: string, userId: string): Promise<Role | null>
  list(tenantId: string): Promise<RoleRow[]>
  transact<T>(tenantId: string, decide: (rows: RoleRow[]) => Decision<T>): Promise<T>
}

const none = <T>(result: T): Decision<T> => ({ writes: [], result })
const rowOf = (rows: RoleRow[], userId: string) => rows.find((r) => r.userId === userId)
const ownersIn = (rows: RoleRow[]) => rows.filter((r) => r.role === "owner").length
const roleIn = (rows: RoleRow[], userId: string): Role =>
  rowOf(rows, userId)?.role ?? "member"

/**
 * The creator of a new workspace becomes its owner (`organization.created`).
 *
 * ⚠ ONLY WHILE THE WORKSPACE HAS NO OWNER. Svix redelivers, for up to a day
 * and a half: a redelivery after the creator handed ownership on, or demoted
 * themselves, must not make them owner again - and whoever demoted them was
 * an owner, so an owner exists and this does nothing. A creator whose
 * membership webhook landed first, as a member, is upgraded in place.
 */
export function seedOwner(
  rows: RoleRow[],
  userId: string,
): Decision<"seeded" | "kept"> {
  if (ownersIn(rows) > 0) return none("kept")
  const existing = rowOf(rows, userId)
  return {
    writes: [
      {
        put: {
          userId,
          role: "owner",
          membershipId: existing?.membershipId ?? null,
          source: "creator",
          grantedBy: null,
        },
      },
    ],
    result: "seeded",
  }
}

export interface MembershipEvent {
  userId: string
  membershipId: string
  /** The role this membership would get if we had nothing for it yet. */
  role: Role
  source: RoleSource
}

/**
 * `organizationMembership.created`.
 *
 * ⚠ KEYED ON CLERK'S MEMBERSHIP ID, WHICH IS WHAT MAKES ARRIVAL ORDER HARMLESS.
 *
 *   - Nothing for them: the role this event carries.
 *   - A row with no membership yet (the creator's, from `organization.created`,
 *     or one the backfill wrote): it is this membership's - the id is attached
 *     and the role kept.
 *   - The same membership: a redelivery, or our own `addMember` got here
 *     first with the exact role. Nothing changes - and nothing a role change
 *     made since is undone.
 *   - A different membership: they left and came back. A new membership is a
 *     new decision, so the old role goes; nobody walks back into a role they
 *     held before they left.
 */
export function membershipCreated(
  rows: RoleRow[],
  event: MembershipEvent,
): Decision<"inserted" | "attached" | "kept" | "replaced"> {
  const existing = rowOf(rows, event.userId)
  if (existing && existing.membershipId === event.membershipId) return none("kept")
  if (existing && existing.membershipId === null)
    return {
      writes: [{ put: { ...existing, membershipId: event.membershipId } }],
      result: "attached",
    }
  return {
    writes: [
      {
        put: {
          userId: event.userId,
          role: event.role,
          membershipId: event.membershipId,
          source: event.source,
          grantedBy: null,
        },
      },
    ],
    result: existing ? "replaced" : "inserted",
  }
}

/**
 * Our own `addMember`: the membership Clerk just made for an access rule.
 *
 * ⚠ AUTHORITATIVE FOR THE MEMBERSHIP IT MADE. If Clerk's webhook for it got
 * here first it could only guess (member); we know the rule's role, so ours
 * replaces it. If ours is first, the webhook finds the same membership id and
 * leaves it alone (`membershipCreated`).
 */
export function joinedByRule(
  rows: RoleRow[],
  event: { userId: string; membershipId: string; role: JoinRole },
): Decision<"set"> {
  return {
    writes: [
      {
        put: {
          userId: event.userId,
          role: event.role,
          membershipId: event.membershipId,
          source: "access_rule",
          grantedBy: null,
        },
      },
    ],
    result: "set",
  }
}

/**
 * `organizationMembership.deleted`: the row goes.
 *
 * ⚠ UNLESS IT IS ALREADY ABOUT A NEWER MEMBERSHIP. Somebody removed and added
 * back has a new membership id; a late `deleted` for the old one must not take
 * the new one's role away.
 */
export function membershipDeleted(
  rows: RoleRow[],
  event: { userId: string; membershipId: string | null },
): Decision<{ removed: boolean; owners: number }> {
  const existing = rowOf(rows, event.userId)
  const newer =
    existing?.membershipId &&
    event.membershipId &&
    existing.membershipId !== event.membershipId
  if (!existing || newer) return none({ removed: false, owners: ownersIn(rows) })
  const left = rows.filter((r) => r.userId !== event.userId)
  return {
    writes: [{ remove: event.userId }],
    result: { removed: true, owners: ownersIn(left) },
  }
}

export type ChangeOutcome =
  | { outcome: "ok"; from: Role; to: Role }
  /** Needs `roles:manage`. */
  | { outcome: "forbidden" }
  /** Making, demoting or removing an owner needs `owners:manage`. */
  | { outcome: "owner_only" }
  /** The workspace would have no owner. */
  | { outcome: "last_owner" }

/**
 * Who may change whose role, decided from the rows as they stand.
 *
 * ⚠ THE ACTOR'S ROLE IS READ UNDER THE SAME LOCK AS THE TARGET'S. Two owners
 * demoting each other at once are serialised: the second finds it is no longer
 * an owner, and is refused, rather than both succeeding and leaving nobody.
 */
export function changeRole(
  rows: RoleRow[],
  input: { actorUserId: string; userId: string; role: Role },
): Decision<ChangeOutcome> {
  const actor = roleIn(rows, input.actorUserId)
  const from = roleIn(rows, input.userId)
  if (!may(actor, "roles:manage")) return none({ outcome: "forbidden" })
  if ((from === "owner" || input.role === "owner") && !may(actor, "owners:manage"))
    return none({ outcome: "owner_only" })
  if (from === input.role) return none({ outcome: "ok", from, to: input.role })
  if (from === "owner" && ownersIn(rows) <= 1) return none({ outcome: "last_owner" })
  const existing = rowOf(rows, input.userId)
  return {
    writes: [
      {
        put: {
          userId: input.userId,
          role: input.role,
          membershipId: existing?.membershipId ?? null,
          source: "changed",
          grantedBy: input.actorUserId,
        },
      },
    ],
    result: { outcome: "ok", from, to: input.role },
  }
}

export type ReleaseOutcome =
  | { outcome: "ok"; previous: RoleRow | null }
  | { outcome: "forbidden" | "owner_only" | "last_owner" }

/**
 * Whether one person may take another out of a workspace, or act on them as
 * removing would (end their sessions, deprovision them, #337): an admin
 * anybody but an owner, an owner anybody.
 */
export function mayRemove(
  actor: Role,
  target: Role,
): "ok" | "forbidden" | "owner_only" {
  if (!may(actor, "members:manage")) return "forbidden"
  if (target === "owner" && !may(actor, "owners:manage")) return "owner_only"
  return "ok"
}

/**
 * Somebody leaving (`actorUserId === userId`) or being removed: whether they
 * may, and their row taken out if so.
 *
 * ⚠ THE ROW GOES BEFORE CLERK IS ASKED. Asked after, two owners leaving at
 * once could both see the other and both go; under the lock, the second sees
 * it is the last. If Clerk then fails, the caller puts the row back.
 */
export function release(
  rows: RoleRow[],
  input: { actorUserId: string; userId: string },
): Decision<ReleaseOutcome> {
  const target = roleIn(rows, input.userId)
  if (input.actorUserId !== input.userId) {
    const allowed = mayRemove(roleIn(rows, input.actorUserId), target)
    if (allowed !== "ok") return none({ outcome: allowed })
  }
  if (target === "owner" && ownersIn(rows) <= 1) return none({ outcome: "last_owner" })
  const previous = rowOf(rows, input.userId) ?? null
  return {
    writes: previous ? [{ remove: input.userId }] : [],
    result: { outcome: "ok", previous },
  }
}

/**
 * Takes out owner rows found to belong to nobody any more - only where, under
 * the lock, the row is still the one that was checked: same person, still an
 * owner, same membership. A row changed meanwhile is somebody's real decision.
 */
export function pruneGhosts(rows: RoleRow[], ghosts: RoleRow[]): Decision<string[]> {
  const gone = ghosts.filter((g) =>
    rows.some(
      (r) =>
        r.userId === g.userId &&
        r.role === "owner" &&
        r.membershipId === g.membershipId,
    ),
  )
  return {
    writes: gone.map((g) => ({ remove: g.userId })),
    result: gone.map((g) => g.userId),
  }
}

/** Puts a released row back, unless something newer took its place. */
export function restore(rows: RoleRow[], previous: RoleRow): Decision<boolean> {
  if (rowOf(rows, previous.userId)) return none(false)
  return { writes: [{ put: previous }], result: true }
}

// ── Asking ──────────────────────────────────────────────────────────────────

/** Whether this person may do this in this workspace. No Clerk call. */
export async function can(
  store: Pick<RoleStore, "roleOf">,
  tenantId: string,
  userId: string,
  permission: Permission,
): Promise<boolean> {
  return may((await store.roleOf(tenantId, userId)) ?? "member", permission)
}

/** The signed-in person's role, and what it lets them do and give. */
export async function accessOf(
  store: Pick<RoleStore, "roleOf">,
  tenantId: string,
  userId: string,
) {
  const role = (await store.roleOf(tenantId, userId)) ?? "member"
  return {
    role,
    permissions: [...permissionsOf(role)],
    grantable: grantable(role),
    invitable: invitable(role),
  }
}

// ── Keeping the table in step with Clerk ────────────────────────────────────

export interface Logger {
  info: (o: object, m: string) => void
  warn: (o: object, m: string) => void
  error: (o: object, m: string) => void
}

/** The few membership calls the roles need from Clerk's backend API. */
export interface ClerkMemberships {
  /**
   * Adds a person, always as `CLERK_ROLE`. `already_member` when they were;
   * `full` when Clerk refuses with `organization_membership_quota_exceeded`.
   */
  create(
    orgId: string,
    userId: string,
  ): Promise<
    | { outcome: "created"; membershipId: string }
    | { outcome: "already_member" | "full" }
  >
  /** Already gone is done. */
  remove(orgId: string, userId: string): Promise<void>
  /** Whether they are a member - asked only about somebody we hold no row for. */
  isMember(orgId: string, userId: string): Promise<boolean>
  /**
   * Creates an organization with its creator, whom Clerk makes `creator_role`
   * (an admin: see the top of this file).
   */
  createOrganization(input: {
    name: string
    createdBy: string
    slug?: string
    maxAllowedMemberships?: number
    publicMetadata?: Record<string, unknown>
  }): Promise<{ id: string }>
  /** Sets their Clerk role to `CLERK_ROLE`. A membership already gone is done. */
  demote(orgId: string, userId: string): Promise<void>
  /** Whether Clerk still has the organization: false once it is deleted. */
  organizationExists(orgId: string): Promise<boolean>
  /**
   * Whether this person's account still exists AND they are still a member
   * of the organization. False for a 404 on the user or no membership; any
   * other failure throws (see `confirmOwners`).
   */
  stillMember(orgId: string, userId: string): Promise<boolean>
}

export interface RolesDeps {
  store: RoleStore
  clerk: ClerkMemberships
  /** Our tenant for a Clerk organization, from a verified webhook or our own call. */
  tenantOf(orgId: string): Promise<string | null>
  /**
   * Our invitations that could have brought somebody in: pending or accepted,
   * sent since `since`, not yet used by another membership - unused, or used
   * by `membershipId` itself - newest first.
   */
  invitations(
    tenantId: string,
    since: Date,
    membershipId: string,
  ): Promise<{ id: string; email: string; role: string }[]>
  /**
   * Marks an invitation used by this membership; false when another
   * membership used it first. Using it again for the same one is true.
   */
  applyInvitation(tenantId: string, id: string, membershipId: string): Promise<boolean>
  /** A person's VERIFIED addresses, from Clerk. */
  emailsOf(userId: string): Promise<string[]>
  now?: () => Date
  log: Logger
}

const DAY_MS = 24 * 60 * 60 * 1000
/**
 * How far back an invitation can explain a new membership: our longest expiry
 * (7 days) and Svix's whole retry schedule (about a day and a half) on top.
 */
const INVITATION_REACH_MS = 9 * DAY_MS

const text = (value: unknown): string | null =>
  typeof value === "string" && value ? value : null

/**
 * The role a membership we did not make ourselves joins with: our invitation
 * for one of the person's verified addresses, or member.
 *
 * ⚠ CLERK IS ONLY ASKED FOR THE ADDRESSES WHEN THERE IS AN INVITATION TO
 * MATCH. Most memberships have none, and a webhook is no place for a call we
 * do not need.
 *
 * ⚠ AN INVITATION GIVES ITS ROLE ONCE. Somebody invited as admin, removed,
 * and back within days through some other door must not walk back in as
 * admin, so the invitation is marked used by this membership BEFORE its row
 * is written. Marked by membership id, not just "used": a redelivery, or a
 * retry after the row write failed, finds the same membership and gets the
 * same answer, in either order against `organizationInvitation.accepted`.
 */
async function joiningRole(
  d: RolesDeps,
  tenantId: string,
  userId: string,
  membershipId: string,
): Promise<{ role: Role; source: RoleSource }> {
  const since = new Date(
    (d.now ?? (() => new Date()))().getTime() - INVITATION_REACH_MS,
  )
  const invited = await d.invitations(tenantId, since, membershipId)
  if (invited.length > 0) {
    const emails = new Set((await d.emailsOf(userId)).map((e) => e.toLowerCase()))
    const match = invited.find((i) => emails.has(i.email.toLowerCase()))
    if (match && (await d.applyInvitation(tenantId, match.id, membershipId)))
      return { role: readJoinRole(match.role), source: "invitation" }
  }
  return { role: DEFAULT_ROLE, source: "membership" }
}

/**
 * The safety net under `createWorkspace`: a Clerk membership with any role but
 * `CLERK_ROLE` is set back to it, whatever made it - an organization created
 * at Clerk's Frontend API or dashboard, a creator whose demotion failed, a
 * role changed in Clerk's dashboard. Until the gateway (#336) closes those
 * doors, this is what keeps Clerk's admins short-lived.
 *
 * ⚠ IT NEVER TOUCHES OUR ROW. Clerk's role says nothing about ours.
 *
 * ⚠ SAFE IN ANY ORDER AND AGAIN. The payload's role is a snapshot, so a late
 * `created` can still say admin after we demoted - demoting again is a no-op
 * at Clerk, and its own `updated` echo says `org:member`, which stops here.
 */
async function fixClerkRole(d: RolesDeps, data: unknown): Promise<string | null> {
  const { orgId, userId } = membershipOf(data)
  const role = text((data as { role?: unknown } | null)?.role)
  if (!orgId || !userId || !role || role === CLERK_ROLE) return null
  await d.clerk.demote(orgId, userId)
  d.log.warn(
    { clerkOrgId: orgId, userId, clerkRole: role },
    `demoted a Clerk ${role} membership to ${CLERK_ROLE}`,
  )
  return "clerk:demoted"
}

/**
 * Clerk's webhooks, kept idempotent and safe in any order.
 *
 * ⚠ THE ORDER CLERK SENDS THEM IN IS NOT THE ORDER THEY ARRIVE IN. Svix
 * retries each delivery on its own schedule, so `organizationMembership.created`
 * for the creator can land before `organization.created` made the tenant, and
 * our own `addMember` can race the webhook for the membership it made. Rather
 * than wait for an order that is not promised, each event writes only what it
 * knows, keyed on Clerk's membership id (see `membershipCreated`):
 *
 *   - `organization.created` makes the creator owner - after provisioning,
 *     which runs first in the same delivery - while the workspace has none.
 *   - `organizationMembership.created` before the tenant exists writes nothing
 *     (`no_tenant`): the only membership that early is the creator's, which
 *     `organization.created` covers.
 *   - after it, the role is our invitation's or member, unless a row already
 *     names that membership.
 *   - `organizationMembership.deleted` removes the row unless it is already
 *     about a newer membership.
 *   - `organizationMembership.created` and `.updated` with a powerful Clerk
 *     role also set Clerk's back to `CLERK_ROLE` (`fixClerkRole`), with or
 *     without a tenant: the power is Clerk's, whoever's workspace it is.
 *
 * ⚠ THROWS ON A DATABASE OR CLERK FAILURE, SO SVIX RETRIES. Every step above
 * is safe to run again.
 */
export async function onClerkEvent(
  d: RolesDeps,
  type: string,
  data: unknown,
): Promise<string | null> {
  switch (type) {
    case "organization.created":
      return onOrganizationCreated(d, data)
    case "organizationMembership.created": {
      const role = await onMembershipCreated(d, data)
      const clerk = await fixClerkRole(d, data)
      return [role, clerk].filter(Boolean).join(",") || null
    }
    case "organizationMembership.updated":
      return fixClerkRole(d, data)
    case "organizationMembership.deleted":
      return onMembershipDeleted(d, data)
    default:
      return null
  }
}

async function onOrganizationCreated(
  d: RolesDeps,
  data: unknown,
): Promise<string | null> {
  const org = (data ?? {}) as { id?: unknown; created_by?: unknown }
  const orgId = text(org.id)
  const createdBy = text(org.created_by)
  if (!orgId || !createdBy) return null
  const tenantId = await d.tenantOf(orgId)
  if (!tenantId) return null
  return `owner:${await d.store.transact(tenantId, (rows) => seedOwner(rows, createdBy))}`
}

function membershipOf(data: unknown) {
  const m = (data ?? {}) as {
    id?: unknown
    organization?: { id?: unknown }
    public_user_data?: { user_id?: unknown }
  }
  return {
    membershipId: text(m.id),
    orgId: text(m.organization?.id),
    userId: text(m.public_user_data?.user_id),
  }
}

async function onMembershipCreated(
  d: RolesDeps,
  data: unknown,
): Promise<string | null> {
  const { membershipId, orgId, userId } = membershipOf(data)
  if (!membershipId || !orgId || !userId) return null
  const tenantId = await d.tenantOf(orgId)
  if (!tenantId) return "role:no_tenant"
  // Already ours for this membership: no reason to work out a role (or ask Clerk).
  const existing = (await d.store.list(tenantId)).find((r) => r.userId === userId)
  const known =
    existing &&
    (existing.membershipId === null || existing.membershipId === membershipId)
  const joining = known
    ? { role: existing.role, source: existing.source }
    : await joiningRole(d, tenantId, userId, membershipId)
  const outcome = await d.store.transact(tenantId, (rows) =>
    membershipCreated(rows, { userId, membershipId, ...joining }),
  )
  return `role:${outcome}`
}

async function onMembershipDeleted(
  d: RolesDeps,
  data: unknown,
): Promise<string | null> {
  const { membershipId, orgId, userId } = membershipOf(data)
  if (!orgId || !userId) return null
  const tenantId = await d.tenantOf(orgId)
  if (!tenantId) return "role:no_tenant"
  const done = await d.store.transact(tenantId, (rows) =>
    membershipDeleted(rows, { userId, membershipId }),
  )
  if (!done.removed) return "role:kept"
  if (done.owners > 0) return "role:removed"
  /*
   * ⚠ LOUD, BECAUSE NOTHING CAN FIX IT FROM INSIDE THE WORKSPACE. Our API
   * never lets the last owner go, but Clerk lets anybody leave at its own
   * Frontend API, and an account can be deleted. With no owner nobody can
   * delete the workspace or make a new owner; staff have to.
   *
   * ⚠ UNLESS THE WORKSPACE IS BEING DELETED. Clerk ends every membership of
   * a deleted organization, and those deletions can land before
   * `organization.deleted` marks our tenant - so our tenant still reads live
   * and only Clerk can say the organization is gone. Asked only here, when
   * the last owner has just gone, which is rare.
   */
  if (await d.clerk.organizationExists(orgId))
    d.log.error(
      { tenantId, clerkOrgId: orgId, userId },
      "the last owner left a workspace through Clerk - it has no owner now",
    )
  else
    d.log.info(
      { tenantId, clerkOrgId: orgId, userId },
      "the last owner's membership ended with its deleted organization",
    )
  return "role:removed"
}

// ── What the API does with them ─────────────────────────────────────────────

/**
 * Whether Clerk would have let this person create one more organization:
 * `create_organization_enabled` and `create_organizations_limit`, which
 * Clerk enforces at its Frontend API only - creating through the backend
 * skips them, so `POST /console/workspaces` asks this first.
 */
export function mayCreateWorkspace(
  user: { createOrganizationEnabled: boolean; createOrganizationsLimit: number | null },
  created: number,
): boolean {
  if (!user.createOrganizationEnabled) return false
  const limit = user.createOrganizationsLimit
  return limit === null || limit === 0 || created < limit
}

/**
 * Creates a workspace for this person, and takes Clerk's admin role away from
 * them in the same request. Their real role, owner, is written when Clerk's
 * `organization.created` reaches us (`seedOwner`): the tenant only exists
 * once provisioning has run, so there is nowhere to write it before.
 *
 * ⚠ A FAILED DEMOTION IS LOGGED AT ERROR, AND THE PERSON STILL GETS THEIR
 * WORKSPACE. The organization exists either way - failing the request would
 * leave them a workspace they were told they did not get, and a retry that
 * makes a second one. The membership webhooks demote it again (`fixClerkRole`),
 * and Svix retries until Clerk answers; for that window the creator is an
 * admin at Clerk in their own new, empty workspace.
 */
export async function createWorkspace(
  d: Pick<RolesDeps, "clerk" | "log">,
  input: {
    name: string
    userId: string
    slug?: string
    maxAllowedMemberships?: number
    publicMetadata?: Record<string, unknown>
  },
): Promise<{ id: string }> {
  const { userId, ...rest } = input
  const org = await d.clerk.createOrganization({ ...rest, createdBy: userId })
  try {
    await d.clerk.demote(org.id, userId)
  } catch (error) {
    d.log.error(
      { err: error, clerkOrgId: org.id, userId },
      "created a workspace but could not demote its creator in Clerk - the " +
        "membership webhook will try again",
    )
  }
  return org
}

export type AddOutcome = "added" | "full"

/**
 * Adds a person through an access rule (auto-join, Join, an accepted request)
 * with the rule's role: `CLERK_ROLE` in Clerk, the real role here.
 *
 * ⚠ OUR ROW AFTER CLERK'S, WITH CLERK'S MEMBERSHIP ID. Written before, a row
 * for a membership Clerk then refused would sit there for somebody who is not
 * a member. If this process dies between the two, the webhook makes them a
 * member: the least they could have been, never more.
 *
 * ⚠ ALREADY A MEMBER IS LEFT ALONE. An invitation got there first, or they
 * were always in; either way their role is not this rule's to change.
 */
export async function addMember(
  d: RolesDeps,
  input: { orgId: string; userId: string; role: JoinRole },
): Promise<AddOutcome> {
  const made = await d.clerk.create(input.orgId, input.userId)
  if (made.outcome !== "created") return made.outcome === "full" ? "full" : "added"
  const tenantId = await d.tenantOf(input.orgId)
  if (!tenantId) {
    d.log.error(
      { clerkOrgId: input.orgId, userId: input.userId },
      "added a member to an organization with no tenant - their role is member",
    )
    return "added"
  }
  await d.store.transact(tenantId, (rows) =>
    joinedByRule(rows, {
      userId: input.userId,
      membershipId: made.membershipId,
      role: input.role,
    }),
  )
  return "added"
}

export type RoleChangeOutcome =
  | ChangeOutcome
  | { outcome: "invalid" }
  /** Another owner could not be confirmed with Clerk: see `confirmOwners`. */
  | { outcome: "unconfirmed" }
  /** Not a member of this workspace. */
  | { outcome: "missing" }

/**
 * Changes a member's role (the Team page's picker).
 *
 * ⚠ SOMEBODY WE HOLD NO ROW FOR IS CHECKED WITH CLERK FIRST. A missing row is
 * an ordinary member as often as it is nobody at all, and a role must never be
 * written for somebody outside the workspace. That call checks the TARGET; who
 * may make the change is our table alone.
 *
 * ⚠ AUDITED AS A LOG LINE UNTIL #337 BRINGS THE AUDIT LOG.
 */
export async function setRole(
  d: RolesDeps,
  input: {
    tenantId: string
    orgId: string
    actorUserId: string
    userId: string
    role: unknown
  },
): Promise<RoleChangeOutcome> {
  const role = parseRole(input.role)
  if (!role) return { outcome: "invalid" }
  const held = await d.store.roleOf(input.tenantId, input.userId)
  if (held === null && !(await d.clerk.isMember(input.orgId, input.userId)))
    return { outcome: "missing" }
  if (
    held === "owner" &&
    role !== "owner" &&
    (await confirmOwners(d, input)) === "unconfirmed"
  )
    return { outcome: "unconfirmed" }
  const changed = await d.store.transact(input.tenantId, (rows) =>
    changeRole(rows, { actorUserId: input.actorUserId, userId: input.userId, role }),
  )
  if (changed.outcome === "ok" && changed.from !== changed.to)
    d.log.info(
      {
        audit: "workspace.role_changed",
        tenantId: input.tenantId,
        clerkOrgId: input.orgId,
        actorUserId: input.actorUserId,
        userId: input.userId,
        from: changed.from,
        to: changed.to,
      },
      "workspace role changed",
    )
  return changed
}

/**
 * Before an owner steps down, leaves or is removed: are the OTHER owners real?
 *
 * ⚠ CHECKED AT DECISION TIME, NOT CLEANED UP ON `user.deleted`. Removing a
 * deleted account's rows in every workspace is a cross-tenant delete, which
 * RLS refuses `i10_api`, and doing it anyway needs a hand-written definer -
 * which this repo does not write for this. And it is only HERE that a dead
 * row matters: anywhere else it grants nothing, because nobody can sign in as
 * an account that is gone. So the one decision a ghost could corrupt - "is
 * there another owner?" - asks Clerk about the other owners first, and a ghost
 * found is removed through `transact`, with a warning.
 *
 * ⚠ CLERK IS ASKED OUTSIDE THE LOCK, AND ONLY WHEN IT MATTERS: the target is
 * an owner and the actor is not another owner (one who is acting is plainly
 * real). Members and admins cost nothing extra. The first owner confirmed
 * real ends the check.
 *
 * ⚠ A CLERK FAILURE REMOVES NOTHING AND REFUSES. If no other owner could be
 * confirmed and one could not be asked, the answer is `unconfirmed`: at worst
 * a real last owner is told to try again, never allowed to leave a workspace
 * whose only other "owner" may be nobody.
 */
async function confirmOwners(
  d: Pick<RolesDeps, "store" | "clerk" | "log">,
  input: { tenantId: string; orgId: string; actorUserId: string; userId: string },
): Promise<"ok" | "unconfirmed"> {
  const rows = await d.store.list(input.tenantId)
  if (rows.find((r) => r.userId === input.userId)?.role !== "owner") return "ok"
  const others = rows.filter((r) => r.role === "owner" && r.userId !== input.userId)
  if (others.some((r) => r.userId === input.actorUserId)) return "ok"
  return (await realOtherOwner(d, input, others)) === "unconfirmed"
    ? "unconfirmed"
    : "ok"
}

/**
 * Is there an owner of this workspace, other than `userId`, whose account and
 * membership Clerk confirms? The core of `confirmOwners`, and what account
 * deletion asks for every workspace the person owns.
 *
 * ⚠ GHOSTS FOUND ON THE WAY ARE PRUNED, as in `confirmOwners`, and a Clerk
 * failure with no real owner found is `unconfirmed`, never `none`: the caller
 * refuses and asks for a retry rather than guessing.
 */
export async function realOtherOwner(
  d: Pick<RolesDeps, "store" | "clerk" | "log">,
  input: { tenantId: string; orgId: string; userId: string },
  owners?: RoleRow[],
): Promise<"found" | "none" | "unconfirmed"> {
  const others =
    owners ??
    (await d.store.list(input.tenantId)).filter(
      (r) => r.role === "owner" && r.userId !== input.userId,
    )
  const ghosts: RoleRow[] = []
  let unknown = false
  for (const owner of others) {
    try {
      if (await d.clerk.stillMember(input.orgId, owner.userId)) {
        if (ghosts.length > 0) await prune(d, input, ghosts)
        return "found"
      }
      ghosts.push(owner)
    } catch (error) {
      unknown = true
      d.log.warn(
        {
          err: error,
          tenantId: input.tenantId,
          clerkOrgId: input.orgId,
          userId: owner.userId,
        },
        "could not confirm an owner with Clerk - refusing rather than guessing",
      )
    }
  }
  if (ghosts.length > 0) await prune(d, input, ghosts)
  return unknown ? "unconfirmed" : "none"
}

async function prune(
  d: Pick<RolesDeps, "store" | "log">,
  input: { tenantId: string; orgId: string },
  ghosts: RoleRow[],
): Promise<void> {
  const removed = await d.store.transact(input.tenantId, (rows) =>
    pruneGhosts(rows, ghosts),
  )
  for (const userId of removed)
    d.log.warn(
      { tenantId: input.tenantId, clerkOrgId: input.orgId, userId },
      "removed the role of an owner whose account or membership is gone",
    )
}

export type Released =
  | { outcome: "ok"; undo: () => Promise<void> }
  | { outcome: "forbidden" | "owner_only" | "last_owner" | "unconfirmed" }

/**
 * Takes somebody's row out before they leave or are removed in Clerk, if they
 * may go; `undo` puts it back when Clerk then fails. See `release`.
 */
export async function releaseMember(
  d: Pick<RolesDeps, "store" | "clerk" | "log">,
  input: { tenantId: string; orgId: string; actorUserId: string; userId: string },
): Promise<Released> {
  if ((await confirmOwners(d, input)) === "unconfirmed")
    return { outcome: "unconfirmed" }
  const released = await d.store.transact(input.tenantId, (rows) =>
    release(rows, { actorUserId: input.actorUserId, userId: input.userId }),
  )
  if (released.outcome !== "ok") return released
  const previous = released.previous
  return {
    outcome: "ok",
    undo: async () => {
      if (previous)
        await d.store.transact(input.tenantId, (rows) => restore(rows, previous))
    },
  }
}

/**
 * Leaves the workspace through our API, so the last owner cannot.
 *
 * ⚠ CLERK WOULD LET THEM - leaving is the one membership change its Frontend
 * API allows any member - so the console's Leave goes through here, and a
 * leave made at Clerk directly is caught by the webhook and logged.
 */
export async function leaveWorkspace(
  d: RolesDeps,
  input: { tenantId: string; orgId: string; userId: string },
): Promise<"ok" | "last_owner" | "unconfirmed"> {
  const released = await releaseMember(d, {
    tenantId: input.tenantId,
    orgId: input.orgId,
    actorUserId: input.userId,
    userId: input.userId,
  })
  if (released.outcome === "last_owner" || released.outcome === "unconfirmed")
    return released.outcome
  if (released.outcome !== "ok") throw new Error(`leaving refused: ${released.outcome}`)
  try {
    await d.clerk.remove(input.orgId, input.userId)
  } catch (error) {
    await released.undo()
    throw error
  }
  d.log.info(
    {
      audit: "workspace.left",
      tenantId: input.tenantId,
      clerkOrgId: input.orgId,
      userId: input.userId,
    },
    "left a workspace",
  )
  return "ok"
}

/**
 * Takes somebody else out of the workspace as `actorUserId` (#337's
 * deprovisioning): our row first under the role rule, then Clerk, the row put
 * back if Clerk fails. The Team page's removal does the same through
 * team-domains.ts, with its block list on top.
 */
export async function removeMemberAs(
  d: RolesDeps,
  input: { tenantId: string; orgId: string; actorUserId: string; userId: string },
): Promise<"ok" | "forbidden" | "owner_only" | "last_owner" | "unconfirmed"> {
  const released = await releaseMember(d, input)
  if (released.outcome !== "ok") return released.outcome
  try {
    await d.clerk.remove(input.orgId, input.userId)
  } catch (error) {
    await released.undo()
    throw error
  }
  d.log.info(
    {
      audit: "member.removed",
      tenantId: input.tenantId,
      clerkOrgId: input.orgId,
      actorUserId: input.actorUserId,
      userId: input.userId,
    },
    "removed a member",
  )
  return "ok"
}
