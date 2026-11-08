import { may, type Role } from "./roles.js"
import type { ConsoleDeps } from "../routes/console/deps.js"
import type { KeySummary } from "../auth/store.js"

/**
 * Who may see and act on which API key of a workspace.
 *
 *   - A member: only the keys they created themselves.
 *   - An admin or an owner (`api_keys:manage_all`): every key.
 *   - A key whose creator was deprovisioned: owners only (#345), whoever else
 *     could otherwise reach it.
 *   - A key with no recorded creator (minted before `created_by` was kept):
 *     admins and owners only. Nobody is its creator, so no member is.
 *
 * ⚠ ONE FUNCTION DECIDES, FOR THE LIST AND FOR EVERY MUTATION. The list's
 * `can_rotate` / `can_revoke` flags and the routes' refusals come from the same
 * answer, so the console can never show a button the API then refuses, or
 * worse, the reverse.
 *
 * ⚠ THE ROLE IS READ FROM OUR TABLE, NEVER TAKEN FROM THE REQUEST, AND NO ROLE
 * ROW (or no roles port at all) MEANS MEMBER - the least a person can do.
 */
export type KeyVerdict =
  /** May see and act. */
  | "allowed"
  /** May not even see it: not theirs. Answered as not found. */
  | "hidden"
  /** Sees it, but its creator was deprovisioned and only an owner may act. */
  | "owner_only"

export interface KeyAccess {
  role: Role
  /** Whether the caller may see every key, not just their own. */
  all: boolean
  decide(key: KeySummary): Promise<KeyVerdict>
}

/** Whether the audit log says this person was deprovisioned in this workspace. */
export async function wasDeprovisioned(
  d: Pick<ConsoleDeps, "identity">,
  tenantId: string,
  member: string,
): Promise<boolean> {
  if (!d.identity) return false
  const rows = await d.identity.store.events(tenantId, {
    limit: 200,
    subjectUserId: member,
  })
  return rows.some((r) => r.type === "member.deprovisioned")
}

export async function keyAccess(
  d: Pick<ConsoleDeps, "roles" | "identity">,
  tenantId: string,
  userId: string,
): Promise<KeyAccess> {
  const role: Role = (await d.roles?.store.roleOf(tenantId, userId)) ?? "member"
  const all = may(role, "api_keys:manage_all")
  const owner = may(role, "owners:manage")
  // One audit-log read per creator per request, however many keys they made.
  const left = new Map<string, Promise<boolean>>()
  const creatorLeft = (creator: string) => {
    let known = left.get(creator)
    if (!known) {
      known = wasDeprovisioned(d, tenantId, creator)
      left.set(creator, known)
    }
    return known
  }

  return {
    role,
    all,
    async decide(key) {
      const mine = key.createdBy !== null && key.createdBy === userId
      if (!all && !mine) return "hidden"
      if (owner || key.createdBy === null || mine) return "allowed"
      return (await creatorLeft(key.createdBy)) ? "owner_only" : "allowed"
    },
  }
}
