import type { JoinStore } from "./join.js"

/**
 * Join suggestions, run by us (2026-10-13): a workspace switches on one of its
 * verified sending domains; anybody signed in with a verified address at it
 * is suggested the workspace and can ask to join; an admin approves, and only
 * then is Clerk asked for anything - an ordinary membership.
 *
 * ⚠ THIS REPLACED CLERK'S "VERIFIED ORGANIZATION DOMAINS", WHICH IS NOT ON OUR
 * CLERK PLAN FOR PRODUCTION (it answered 403 `organization_domain_enrollment_
 * mode_not_enabled`). The proof was always ours anyway: a domain verified on
 * /domains has proved ownership through DNS, a stronger proof than Clerk's
 * code emailed to one address at it.
 *
 * ⚠ ONLY A DOMAIN THIS WORKSPACE VERIFIED, AND ONLY FOR AN ADMIN OF THE
 * ORGANIZATION IT IS ACTING IN - both checked here, never trusted from the
 * browser. A seeker's domains come from Clerk's VERIFIED addresses only.
 */

export interface TeamDomainDeps {
  /** Names of this workspace's domains whose DNS is verified. */
  verified(tenantId: string): Promise<string[]>
  /** Whether this person holds `permission` in the organization. */
  can(userId: string, orgId: string, permission: string): Promise<boolean>
  store: JoinStore
  /** Clerk organizations this person already belongs to. */
  memberOrgIds(userId: string): Promise<string[]>
  /** Each organization's public face, for a suggestion card. */
  describe(
    orgIds: string[],
  ): Promise<Record<string, { name: string; imageUrl: string | null }>>
  /** Adds an approved person to the organization, as a member. */
  addMember(orgId: string, userId: string): Promise<void>
}

/** Turning suggestions on needs the same permission Clerk's domains did. */
export const MANAGE_DOMAINS = "org:sys_domains:manage"
/** Answering requests needs the permission that manages members. */
export const MANAGE_MEMBERS = "org:sys_memberships:manage"

export type SetOutcome = "ok" | "not_verified" | "forbidden" | "no_org"

export async function setTeamDomain(
  d: TeamDomainDeps,
  input: {
    tenantId: string
    userId: string
    orgId?: string
    name: string
    on: boolean
  },
): Promise<SetOutcome> {
  if (!input.orgId) return "no_org"
  const name = input.name.trim().toLowerCase()
  if (!(await d.can(input.userId, input.orgId, MANAGE_DOMAINS))) return "forbidden"
  if (input.on) {
    const verified = (await d.verified(input.tenantId)).map((n) => n.toLowerCase())
    if (!verified.includes(name)) return "not_verified"
  }
  const outcome = await d.store.set(input.tenantId, {
    name,
    on: input.on,
    clerkOrgId: input.orgId,
  })
  return outcome === "missing" ? "not_verified" : "ok"
}

export type AnswerOutcome = "ok" | "forbidden" | "missing" | "no_org"

/**
 * Accepting adds the member in Clerk FIRST and marks the request answered
 * after, so a Clerk failure leaves the request open to try again rather than
 * "accepted" with nobody added.
 */
export async function answerJoinRequest(
  d: TeamDomainDeps,
  input: {
    tenantId: string
    userId: string
    orgId?: string
    id: string
    accept: boolean
  },
): Promise<AnswerOutcome> {
  if (!input.orgId) return "no_org"
  if (!(await d.can(input.userId, input.orgId, MANAGE_MEMBERS))) return "forbidden"
  const request = (await d.store.pending(input.tenantId)).find((r) => r.id === input.id)
  if (!request) return "missing"
  if (input.accept) await d.addMember(input.orgId, request.user_id)
  const answered = await d.store.answer(input.tenantId, input.id, input.accept)
  return answered ? "ok" : "missing"
}
