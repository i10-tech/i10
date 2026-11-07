import type { Refusal } from "./model.js"

export type SsoFailureProtocol = "oidc" | "saml"

export interface SsoFailure {
  protocol: SsoFailureProtocol
  code: string
  adminNextStep: string
  endUserMessage: string
  retry: boolean
}

const SAML_CODES: Record<string, string> = {
  audience: "audience",
  destination: "destination",
  bad_signature: "signature",
  no_usable_certificate: "signature",
  assertion_unsigned: "unsigned",
  signature_algorithm: "algorithm",
  digest_algorithm: "algorithm",
  not_before: "clock",
  not_on_or_after: "clock",
  issue_instant: "clock",
}

const OIDC_NEXT: Record<string, string> = {
  access_denied:
    "This person is not allowed into the application at your identity provider. In Okta and Entra, assign them to it; at Google, turn the app on for them.",
  unauthorized_client:
    "Check that this application is enabled and assigned to the person in the identity provider.",
  login_required: "Sign in at the identity provider, then run the test again.",
  interaction_required:
    "Complete the required identity provider interaction, then run the test again.",
}

/** Microsoft's codes that have one known fix. Others get the general Microsoft step. */
const AADSTS_NEXT: Record<string, string> = {
  AADSTS50105:
    "Assign this person or their group to the application under Enterprise applications in Entra.",
  AADSTS65001:
    "Grant admin consent for the application in Entra, then run the test again.",
  AADSTS50011:
    "Add the redirect URI shown for this connection to the application in Entra.",
  AADSTS700016:
    "Check the client ID and tenant of this connection: Entra cannot find that application.",
  AADSTS7000215:
    "The client secret is wrong. Create a new one in Entra and save it on this connection.",
  AADSTS7000222:
    "The client secret has expired. Create a new one in Entra and save it on this connection.",
  AADSTS50020:
    "This account is not in the tenant. Invite them to it or sign in with a member account.",
}

function boundedCode(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(value)
    ? value
    : null
}

function samlCode(value: string | null): string | null {
  if (!value) return null
  const last = value.split(":").at(-1)
  return last && /^[A-Za-z0-9_.-]{1,40}$/.test(last) ? last.toLowerCase() : value
}

export function ssoFailure(input: {
  protocol: SsoFailureProtocol
  provider: string
  reason: Refusal
  extra?: Record<string, unknown>
}): SsoFailure | null {
  const extra = input.extra ?? {}
  const raw =
    boundedCode(extra.error) ??
    boundedCode(extra.failure) ??
    boundedCode(extra.status) ??
    boundedCode(extra.aadsts)
  const aadsts =
    typeof extra.aadsts === "string" && /^AADSTS\d{3,}$/.test(extra.aadsts)
      ? extra.aadsts
      : raw && /^AADSTS\d{3,}$/.test(raw)
        ? raw
        : null

  if (input.protocol === "oidc") {
    const code = aadsts ?? raw ?? input.reason
    const adminNextStep =
      AADSTS_NEXT[code] ??
      OIDC_NEXT[code] ??
      (aadsts
        ? "Check the Microsoft application registration and its consent or assignment, then run the test again."
        : "Check the identity provider application settings, then run the test again.")
    return {
      protocol: "oidc",
      code,
      adminNextStep,
      endUserMessage:
        code === "access_denied" || code === "unauthorized_client"
          ? "Your administrator has not granted you access to this sign-in application."
          : "Your administrator needs to correct the identity provider sign-in settings.",
      retry: code === "login_required" || code === "interaction_required",
    }
  }

  const statusOrFailure =
    extra.status !== undefined ? samlCode(boundedCode(extra.status)) : raw
  const code = statusOrFailure
    ? (SAML_CODES[statusOrFailure] ?? statusOrFailure)
    : input.reason
  const adminNextStep =
    code === "audience"
      ? "Set the identity provider audience or entity ID to the value shown for this connection, then run the test again."
      : code === "destination"
        ? "Set the identity provider destination to this connection's ACS URL, then run the test again."
        : code === "signature"
          ? "Upload the identity provider signing certificate that signed this response, then run the test again."
          : code === "unsigned"
            ? "Configure the identity provider to sign its SAML response or assertion, then run the test again."
            : code === "algorithm"
              ? "Configure the identity provider to sign with a supported algorithm, then run the test again."
              : code === "clock"
                ? "Check the identity provider clock and its assertion lifetime, then run the test again."
                : "Check the identity provider SAML settings for this connection, then run the test again."
  return {
    protocol: "saml",
    code,
    adminNextStep,
    endUserMessage:
      "Your administrator needs to correct the identity provider sign-in settings.",
    retry: false,
  }
}

export function oidcErrorCode(value: unknown): string | null {
  return boundedCode(value)
}

export function aadstsCode(value: unknown): string | null {
  if (typeof value !== "string") return null
  const match = value.match(/\b(AADSTS\d{3,})\b/)
  return match?.[1] ?? null
}
