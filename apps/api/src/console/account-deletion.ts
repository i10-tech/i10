import { realOtherOwner, type RolesDeps } from "./roles.js"

/**
 * Deleting a person's whole i10 account, through our API (#336).
 *
 * ⚠ IT USED TO BE `user.delete()` IN THE BROWSER, AT CLERK'S FRONTEND API, and
 * the Clerk gateway now refuses `DELETE /v1/me` for everyone: deletion is ours,
 * like workspace deletion since #335. That also lets us apply the one rule
 * Clerk could not know about.
 *
 * ⚠ THE RULE: NOBODY IS STRANDED. While the person is the ONLY owner of a
 * workspace that still has OTHER members, deleting them would leave those
 * members in a workspace nobody can manage, so it is refused, naming the
 * workspaces. A workspace where they are the only member is fine: there is
 * nobody to strand, and Clerk's `user.deleted` sweep (tenants/lifecycle.ts)
 * deletes the workspaces they were alone in, as it did with `user.delete()`.
 * Verified end to end on dev 2026-10-20: the sole-member workspace went to
 * `deleted` with the account.
 */

/** The Clerk calls account deletion needs, from the backend API. */
export interface AccountDeps {
  /** Every Clerk organization this person is in. Throws if Clerk cannot be asked. */
  workspaces(userId: string): Promise<{ orgId: string; name: string }[]>
  /** How many members the organization has now. Throws if Clerk cannot be asked. */
  memberCount(orgId: string): Promise<number>
  /**
   * Whether the account is SSO-managed (#337). Throws if it cannot be told.
   * Absent: nobody is (processes with no identity core).
   */
  isManaged?: (userId: string) => Promise<boolean>
  /** Deletes the Clerk user. An account already gone is `already_gone`. */
  remove(userId: string): Promise<"deleted" | "already_gone">
}

export type DeletionCheck =
  | { outcome: "ok" }
  /**
   * ⚠ SSO-MANAGED (#337, sso.md 2.3): the company deactivates it, the person
   * cannot delete it. Clerk's `delete_self_enabled: false` binds only Clerk's
   * Frontend API, never this backend call, so the rule is enforced here.
   */
  | { outcome: "managed" }
  /** The only owner of these workspaces, each with other members. */
  | { outcome: "sole_owner"; workspaces: string[] }
  /** Clerk could not be asked: refused rather than guessed. */
  | { outcome: "unconfirmed" }

export async function checkAccountDeletion(
  d: {
    roles: Pick<RolesDeps, "store" | "clerk" | "log" | "tenantOf">
    accounts: AccountDeps
  },
  userId: string,
): Promise<DeletionCheck> {
  if (d.accounts.isManaged) {
    try {
      if (await d.accounts.isManaged(userId)) return { outcome: "managed" }
    } catch (error) {
      d.roles.log.warn(
        { err: error, userId },
        "could not tell whether an account is SSO-managed - refusing to delete it",
      )
      return { outcome: "unconfirmed" }
    }
  }
  let workspaces: { orgId: string; name: string }[]
  try {
    workspaces = await d.accounts.workspaces(userId)
  } catch (error) {
    d.roles.log.warn(
      { err: error, userId },
      "could not list a person's workspaces with Clerk - refusing to delete the account",
    )
    return { outcome: "unconfirmed" }
  }

  const stranded: string[] = []
  for (const workspace of workspaces) {
    const tenantId = await d.roles.tenantOf(workspace.orgId)
    // ⚠ NO TENANT, NO ROLES: nothing of ours is owned there, so nothing to keep.
    if (!tenantId) continue
    if ((await d.roles.store.roleOf(tenantId, userId)) !== "owner") continue

    let members: number
    try {
      members = await d.accounts.memberCount(workspace.orgId)
    } catch (error) {
      d.roles.log.warn(
        { err: error, userId, clerkOrgId: workspace.orgId },
        "could not count a workspace's members with Clerk - refusing to delete the account",
      )
      return { outcome: "unconfirmed" }
    }
    if (members <= 1) continue

    /*
     * ⚠ ANOTHER OWNER MUST BE REAL, the same check as leaving or stepping down
     * (#335): a deleted co-owner's row does not keep the workspace managed.
     */
    const other = await realOtherOwner(d.roles, {
      tenantId,
      orgId: workspace.orgId,
      userId,
    })
    if (other === "unconfirmed") return { outcome: "unconfirmed" }
    if (other === "none") stranded.push(workspace.name)
  }

  return stranded.length > 0
    ? { outcome: "sole_owner", workspaces: stranded }
    : { outcome: "ok" }
}

/** "Acme", "Acme and Beta", "Acme, Beta and Gamma". */
export function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ""
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
}

/** What the console shows when the account cannot go yet. */
export function soleOwnerMessage(names: string[]): string {
  const one = names.length === 1
  return `Make someone else an owner of ${listNames(names)}, or delete ${one ? "it" : "them"}, first.`
}
