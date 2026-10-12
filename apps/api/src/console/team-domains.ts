/**
 * The workspace's sending domains, offered to the Team page as Clerk
 * "verified domains" (2026-10-12).
 *
 * A domain verified on /domains has already proved ownership through DNS - a
 * stronger proof than Clerk's own, which emails a code to one address at it.
 * So an admin can turn one on for join suggestions in one press, and we
 * create it in Clerk as already verified, with `automatic_suggestion`:
 * people who sign up with an address there are suggested to request to join.
 *
 * ⚠ ONLY A DOMAIN THIS WORKSPACE VERIFIED, AND ONLY FOR AN ADMIN OF THE
 * ORGANIZATION IT IS ACTING IN. Both are checked here rather than trusted from
 * the browser: Clerk's backend call skips its own verification, so this is
 * the whole of the proof.
 */

export interface TeamDomainDeps {
  /** Names of this workspace's domains whose DNS is verified. */
  verified(tenantId: string): Promise<string[]>
  /** Whether this person may manage the organization's verified domains. */
  canManage(userId: string, orgId: string): Promise<boolean>
  /** Clerk's backend `createOrganizationDomain`, verified, suggestions on. */
  create(orgId: string, name: string): Promise<void>
}

export type ClaimOutcome = "created" | "not_verified" | "forbidden" | "no_org" | "exists"

export async function claimTeamDomain(
  d: TeamDomainDeps,
  input: { tenantId: string; userId: string; orgId?: string; name: string },
): Promise<ClaimOutcome> {
  if (!input.orgId) return "no_org"
  const name = input.name.trim().toLowerCase()
  const verified = (await d.verified(input.tenantId)).map((n) => n.toLowerCase())
  if (!verified.includes(name)) return "not_verified"
  if (!(await d.canManage(input.userId, input.orgId))) return "forbidden"
  try {
    await d.create(input.orgId, name)
    return "created"
  } catch (error) {
    // Clerk refuses a domain the organization already has, or one another uses.
    const status = (error as { status?: number } | null)?.status
    if (status === 422 || status === 409) return "exists"
    throw error
  }
}
