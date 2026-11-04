import type { SsoConnection, SsoEnforcement, SsoStatus } from "./sso-types"

export type ConnectionWritePatch = {
  status?: SsoStatus
  enforcement?: SsoEnforcement
}

export function connectionWriteNeedsStepUp(
  connection: Pick<SsoConnection, "status" | "enforcement">,
  patch: ConnectionWritePatch = {},
): boolean {
  return (
    connection.status === "active" ||
    connection.status === "disabled" ||
    patch.status === "active" ||
    patch.enforcement === "required_domain" ||
    patch.enforcement === "required_all"
  )
}

export const SCIM_SESSION_LIMIT_NOTE =
  "SCIM is not connected: removing someone in your provider does not end their i10 session until the session limit."

export function scimSessionLimitNote(
  directoryState: "enabled" | "none" | null | undefined,
): string | null {
  return directoryState === "none" ? SCIM_SESSION_LIMIT_NOTE : null
}
