import type { MailSignInInitial } from "@/components/sso/connection/mail-sign-in"
import { defineShape } from "@/lib/shapes"
import { scimSessionLimitNote } from "@/lib/sso-authorization"
import { mfaNotes } from "@/lib/sso-runs"
import type {
  SsoAbilities,
  SsoConnection,
  SsoProtocol,
  SsoStatus,
} from "@/lib/sso-types"

export interface SsoConnectionData {
  connection: SsoConnection
  abilities: SsoAbilities
  authOrigin: string | null
  clerkEnabled: boolean
  mail: MailSignInInitial
}

export interface SsoConnectionShape {
  protocol: SsoProtocol
  provider: string
  status: SsoStatus
  isOkta: boolean
  canDelete: boolean
  /** The viewer is an owner: a live connection says which changes are an owner's. */
  owner: boolean
  /** Sign-ins are failing, so Provider settings opens by itself. */
  failing: boolean
  /** How many notes sit under the Require MFA toggle. */
  mfaNotes: number
  /** SCIM is not connected, so the session limits carry a note. */
  sessionNote: boolean
}

/**
 * The shape of a connection, from the connection and the viewer's abilities.
 * ⚠ ONE DERIVATION FOR TWO CALLERS: the page (`of`) and the list row that seeds
 * the shape before the click (components/sso/sso-home) must agree, or the
 * skeleton drawn after a click is the wrong one.
 */
export function connectionShape(
  connection: SsoConnection,
  abilities: SsoAbilities,
): SsoConnectionShape {
  return {
    protocol: connection.protocol,
    provider: connection.provider,
    status: connection.status,
    isOkta: connection.provider === "okta",
    canDelete: abilities.owner && connection.status === "draft",
    owner: abilities.owner,
    failing: connection.health?.failing === true,
    mfaNotes: mfaNotes(connection).length,
    sessionNote: scimSessionLimitNote(connection.directoryState) !== null,
  }
}

export const ssoConnectionShape = defineShape<SsoConnectionShape, SsoConnectionData>({
  page: "sso-connection",
  fallback: {
    protocol: "saml",
    provider: "google",
    status: "active",
    isOkta: false,
    canDelete: false,
    owner: true,
    failing: false,
    mfaNotes: 0,
    sessionNote: false,
  },
  of: (data) => connectionShape(data.connection, data.abilities),
  // ⚠ A COOKIE FROM BEFORE A FIELD WAS ADDED HAS NO SUCH FIELD. Each new one
  // reads as the quiet default (an owner, nothing failing, no notes) instead of
  // dropping the whole remembered shape, so the old cookie still draws a skeleton.
  parse: (raw) => {
    if (typeof raw !== "object" || raw === null) return null
    const r = raw as Record<string, unknown>
    if (r.protocol !== "saml" && r.protocol !== "oidc" && r.protocol !== "test")
      return null
    if (typeof r.provider !== "string") return null
    if (
      r.status !== "draft" &&
      r.status !== "testing" &&
      r.status !== "active" &&
      r.status !== "disabled"
    )
      return null
    return {
      protocol: r.protocol,
      provider: r.provider,
      status: r.status,
      isOkta: r.isOkta === true,
      canDelete: r.canDelete === true,
      owner: r.owner !== false,
      failing: r.failing === true,
      mfaNotes:
        typeof r.mfaNotes === "number" &&
        Number.isInteger(r.mfaNotes) &&
        r.mfaNotes >= 0
          ? Math.min(r.mfaNotes, 3)
          : 0,
      sessionNote: r.sessionNote === true,
    }
  },
})
