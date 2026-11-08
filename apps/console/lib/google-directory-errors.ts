import type { GoogleDirectoryErrorCode } from "@/lib/sso-types"

export const DEFAULT_GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/admin.directory.user.readonly",
  "https://www.googleapis.com/auth/admin.directory.group.readonly",
] as const

export interface GoogleErrorContext {
  clientId?: string | null
  scopes?: readonly string[]
  missingScopes?: readonly string[]
  removedUsers?: number
  existingUsers?: number
  /** The viewer is an owner, who can confirm a refused removal. */
  canConfirmRemovals?: boolean
}

export const GOOGLE_ERROR_COPY: Record<
  GoogleDirectoryErrorCode,
  (ctx: GoogleErrorContext) => string
> = {
  not_configured: () =>
    "Set the Google Workspace admin address and domain first, then try again.",
  domain_not_verified: () =>
    "The directory domain or the admin's address is not one of this workspace's verified domains; verify the domain under Domains first, then try again.",
  unauthorized_client: ({ clientId }) =>
    `Google rejected our service account credentials; check that ${clientId ? `Client ID ${clientId}` : "our Client ID"} is active in Google Admin > Security > API controls > Domain-wide delegation and try again.`,
  delegation_missing: ({ clientId, scopes }) => {
    const idPart = clientId ? `Client ID ${clientId}` : "our Client ID"
    const scopeList = (
      scopes && scopes.length > 0 ? scopes : DEFAULT_GOOGLE_SCOPES
    ).join(", ")
    return `Domain-wide delegation is not set up yet: add ${idPart} with scopes ${scopeList} in Google Admin > Security > API controls > Domain-wide delegation, then try again (Google can take up to 24 hours to apply it).`
  },
  scope_missing: ({ missingScopes, scopes }) => {
    const list = (
      missingScopes && missingScopes.length > 0
        ? missingScopes
        : scopes && scopes.length > 0
          ? scopes
          : DEFAULT_GOOGLE_SCOPES
    ).join(", ")
    return `Your domain-wide delegation entry is missing required scopes: open Google Admin > Security > API controls > Domain-wide delegation and add ${list} to the existing entry.`
  },
  missing_scope: ({ scopes }) => {
    const scopeList = (
      scopes && scopes.length > 0 ? scopes : DEFAULT_GOOGLE_SCOPES
    ).join(", ")
    return `Google refused one of the required Directory API scopes; grant ${scopeList} in Google Admin > Security > API controls > Domain-wide delegation, then try again.`
  },
  admin_not_found: () =>
    "The admin address does not exist in Google Workspace; enter a real admin user's email address and try again.",
  subject_not_admin: () =>
    "That address exists in Google, but is not a Google Workspace admin; use a super admin or an admin with the Users and Groups read privileges.",
  unknown_customer: () =>
    "Google could not find a Workspace customer for this domain; check the domain and admin address in Google Admin and try again.",
  rate_limited: () =>
    "Google rate-limited the directory request; wait a few minutes and try again.",
  too_many_users: () =>
    "This Google Workspace has more users than a single directory sync supports; narrow the verified domains or contact support.",
  too_many_groups: () =>
    "This Google Workspace has more groups or group members than a single directory sync supports; remove unused groups or contact support.",
  empty_directory: () =>
    "Google returned zero users on your verified domains while this directory already has people, so nothing was changed; check your verified domains and Google Workspace users.",
  large_drop: ({ removedUsers, existingUsers, canConfirmRemovals }) => {
    const countPart =
      removedUsers !== undefined && existingUsers !== undefined
        ? `${removedUsers} of ${existingUsers} ${existingUsers === 1 ? "person" : "people"} would be removed`
        : removedUsers !== undefined
          ? `${removedUsers} ${removedUsers === 1 ? "person" : "people"} would be removed`
          : "A large share of your people would be removed"
    // The button is shown only to an owner, and only once the count is known.
    const button =
      canConfirmRemovals && removedUsers !== undefined
        ? "; if these removals are expected, confirm them below, otherwise"
        : ";"
    return `${countPart}, so nothing was changed${button} check that every domain your people use is verified here.`
  },
  user_conflict: () =>
    "Some users could not be updated because an email address is still held by another directory entry; wait for the next sync or check Conflicts.",
  invalid_response: () =>
    "Google returned an unexpected Directory API response, so nothing was changed; wait a few minutes and try again.",
  unreachable: () =>
    "Could not reach Google right now, so nothing was changed; wait a few minutes and try again.",
}

export function isGoogleDirectoryErrorCode(
  code: string,
): code is GoogleDirectoryErrorCode {
  return Object.hasOwn(GOOGLE_ERROR_COPY, code)
}

export function describeGoogleError(
  code: string | null | undefined,
  ctx: GoogleErrorContext = {},
): string {
  if (code && isGoogleDirectoryErrorCode(code)) {
    return GOOGLE_ERROR_COPY[code](ctx)
  }
  return "Google refused the request; check the delegation in your Google Admin console, then try again."
}
