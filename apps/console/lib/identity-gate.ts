/**
 * The three refusals the workspace's session and network policies add to every
 * console call (#345), read off the answer of the shell's own `/console/me`.
 *
 *   401 session_expired  { reason: max_age | idle | revoked }
 *   403 ip_not_allowed
 *   403 mfa_required
 */

export type SessionEndReason = "max_age" | "idle" | "revoked"

export type GateRefusal =
  | { kind: "session_expired"; reason: SessionEndReason }
  | { kind: "ip_not_allowed" }
  | { kind: "mfa_required" }

/** The refusal an API error body is, or null when it is some other failure. */
export function gateRefusal(error: {
  name: string
  reason?: unknown
}): GateRefusal | null {
  if (error.name === "ip_not_allowed") return { kind: "ip_not_allowed" }
  if (error.name === "mfa_required") return { kind: "mfa_required" }
  if (error.name === "session_expired") {
    const { reason } = error
    return {
      kind: "session_expired",
      reason: reason === "max_age" || reason === "idle" ? reason : "revoked",
    }
  }
  return null
}

/** Why the person was signed out, in the words the sign-in page shows. */
export function sessionEndedCopy(reason: SessionEndReason): {
  title: string
  body: string
} {
  switch (reason) {
    case "idle":
      return {
        title: "You were signed out",
        body: "You were inactive for longer than this workspace allows. Sign in again to carry on.",
      }
    case "max_age":
      return {
        title: "Your session ended",
        body: "Your session reached the longest this workspace allows. Sign in again to carry on.",
      }
    case "revoked":
      return {
        title: "Your session was ended",
        body: "An admin ended this session, or you signed out somewhere else. Sign in again to carry on.",
      }
  }
}
