import type { WorkspaceRole } from "@/lib/types"

/**
 * Workspace roles in the console (#335): labels, and the picker items for
 * what the reader may give. Who may do what is the API's answer
 * (`/console/team/roles`, `/console/me`'s `access`), never Clerk's
 * `membership.role` or `has()` - Clerk gives everybody the same powerless role.
 */

export const ROLE_LABELS: Record<WorkspaceRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
}

/** Owners first, then admins, then members. */
const ORDER: WorkspaceRole[] = ["owner", "admin", "member"]

export function roleItems<R extends WorkspaceRole>(roles: readonly R[]) {
  return ORDER.filter((r): r is R =>
    (roles as readonly WorkspaceRole[]).includes(r),
  ).map((value) => ({ value, label: ROLE_LABELS[value] }))
}

export function roleLabel(role: string): string {
  return role in ROLE_LABELS ? ROLE_LABELS[role as WorkspaceRole] : ROLE_LABELS.member
}
