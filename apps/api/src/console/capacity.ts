/**
 * How full a workspace is, and what that means (#327).
 *
 * ⚠ TWO COUNTS, ON PURPOSE. FULL is members PLUS pending invitations at or
 * over the limit, because that is what Clerk enforces: it refuses a
 * membership with `organization_membership_quota_exceeded` once both together
 * reach the organization's maximum. ALERTS count members only - the 80% email
 * goes out when the 16th of 20 actually joins, not at 10 members and 6
 * invitations nobody has opened.
 *
 * Everything here is arithmetic; the callers read the numbers from Clerk and
 * the plan from our database.
 */

export interface Seats {
  members: number
  invitations: number
  limit: number
}

export interface Capacity extends Seats {
  /** Spots nobody holds or has been offered. Never negative. */
  free: number
  /** Members plus invitations at or over the limit: nobody new can join. */
  full: boolean
}

export function capacityOf(seats: Seats): Capacity {
  const taken = seats.members + seats.invitations
  return {
    ...seats,
    free: Math.max(0, seats.limit - taken),
    full: taken >= seats.limit,
  }
}

/** A Personal workspace holds one person whatever its plan says (#325). */
export const PERSONAL_LIMIT = 1

export function memberLimitFor(planLimit: number, personal: boolean): number {
  return personal ? PERSONAL_LIMIT : Math.max(1, planLimit)
}

/**
 * What Clerk's `maxAllowedMemberships` is set to.
 *
 * ⚠ NEVER BELOW THE MEMBERS ALREADY THERE. A downgrade leaves everybody in
 * place - nobody is removed because a plan got smaller - and whether Clerk
 * accepts a maximum under its current count is not something we could prove
 * without a live organization to break. So Clerk is given the larger of the
 * two, which it can always accept, and the plan's own limit is enforced by
 * our checks before every seat use (`full` above). The two agree for every
 * workspace that is not over its plan.
 */
export function clerkLimitFor(limit: number, members: number): number {
  return Math.max(limit, members)
}

// ── Alerts ──────────────────────────────────────────────────────────────────

export type AlertLevel = 0 | 80 | 100

/** The level members alone have reached: 100, 80, or 0 below 80%. */
export function levelOf(members: number, limit: number): AlertLevel {
  if (limit <= 0) return 0
  if (members >= limit) return 100
  // ⚠ IN WHOLE NUMBERS, SO 16 OF 20 IS 80% AND NOT 79.99999.
  if (members * 100 >= limit * 80) return 80
  return 0
}

/**
 * The next armed state, and the alert to send if a crossing just happened.
 *
 * ⚠ ONCE PER CROSSING. The stored level is the highest alert sent since the
 * workspace was last under 80%; it only rises while the workspace stays at or
 * over 80%, so wobbling between 85% and 95% sends nothing, and 90% after a
 * 100% alert sends nothing either. Dropping under 80% re-arms both.
 *
 * ⚠ A JUMP STRAIGHT PAST BOTH SENDS ONE ALERT, THE HIGHER. A plan change
 * that takes a workspace from 50% to full is one piece of news.
 */
export function nextAlert(
  stored: AlertLevel,
  members: number,
  limit: number,
): { level: AlertLevel; send: 80 | 100 | null } {
  const now = levelOf(members, limit)
  if (now === 0) return { level: 0, send: null }
  if (now > stored) return { level: now, send: now }
  return { level: stored, send: null }
}

// ── What would make room ────────────────────────────────────────────────────

/**
 * The ways to make room in a full workspace, naming only what applies:
 * withdrawing needs a pending invitation, upgrading needs a higher plan.
 */
export function roomReasons(input: {
  invitations: number
  canUpgrade: boolean
}): string[] {
  return [
    "Remove a member",
    ...(input.invitations > 0 ? ["Withdraw an invitation"] : []),
    ...(input.canUpgrade ? ["Upgrade"] : []),
  ]
}

// ── The last spot ───────────────────────────────────────────────────────────

/** "a", "a and b", "a, b and c". */
export function listOf(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ""
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`
}

/**
 * The warning on the invitation (or batch) that takes the last free spot,
 * or null when it does not. Too many for the spots left is not a warning but
 * a refusal, and the caller says so instead.
 *
 * ⚠ IT NAMES WHO IS SHUT OUT. A workspace with access rules is about to stop
 * taking the people those rules were written for; "@pslhq.app sign-ups won't
 * be able to join" says it in the admin's own terms. Without rules it only
 * says the workspace will be full.
 */
export function lastSpotWarning(input: {
  free: number
  adding: number
  /** Patterns of rules that let people in: suggest or auto-join. */
  patterns: string[]
}): string | null {
  if (input.adding <= 0 || input.free <= 0) return null
  if (input.adding < input.free) return null
  if (input.adding > input.free) return null
  const who = [...new Set(input.patterns)].map((p) => `@${p}`)
  const first =
    input.adding === 1
      ? "This invitation takes the last spot."
      : "These invitations take the last spots."
  if (who.length === 0) return `${first} The workspace will be full.`
  return `${first} ${listOf(who)} sign-ups won't be able to join until a spot frees up.`
}
