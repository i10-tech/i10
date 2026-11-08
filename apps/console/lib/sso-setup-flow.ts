import type { SsoConnection } from "@/lib/sso-types"

/**
 * Where a connection's setup stands, worked out from the server's answers so a
 * reload, a second tab or a returning test sign-in all land on the right step.
 */

export const SETUP_STEPS = ["provider", "domain", "connect", "test", "live"] as const
export type SetupStep = (typeof SETUP_STEPS)[number]

export type SetupFacts = {
  connection: Pick<SsoConnection, "status" | "domains"> | null
  /** The provider's values are all saved. */
  ready: boolean
  /** A test sign-in passed in the window the API accepts for going live. */
  passed: boolean
}

export function currentStep(facts: SetupFacts): SetupStep | "done" {
  const { connection, ready, passed } = facts
  if (!connection) return "provider"
  if (connection.status === "active") return "done"
  if (!connection.domains.some((d) => d.live)) return "domain"
  if (!ready || connection.status === "draft") return "connect"
  if (!passed) return "test"
  return "live"
}

export function stepIsDone(step: SetupStep, current: SetupStep | "done"): boolean {
  if (current === "done") return true
  return SETUP_STEPS.indexOf(step) < SETUP_STEPS.indexOf(current)
}

/** The protocol we choose for someone: OpenID Connect wherever the provider has it. */
export function recommendedProtocol(protocols: ("oidc" | "saml")[]): "oidc" | "saml" {
  return protocols.includes("oidc") ? "oidc" : "saml"
}

const TENANT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** What people type for an issuer: org address, URL or tenant ID. */
export function issuerFromInput(input: string): string {
  const value = input.trim().replace(/\/+$/, "")
  if (!value) return ""
  if (TENANT_UUID.test(value)) {
    return `https://login.microsoftonline.com/${value}/v2.0`
  }
  return /^https?:\/\//i.test(value) ? value : `https://${value}`
}

/** The domain of an email address, for offering it in one click. */
export function emailDomain(email: string | null | undefined): string | null {
  const domain = email?.split("@")[1]?.trim().toLowerCase()
  return domain || null
}

const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/

export function isDomainName(input: string): boolean {
  return DOMAIN.test(input.trim().toLowerCase())
}

export function isMicrosoftOwnedDomain(domain: string): boolean {
  const normalized = domain.trim().toLowerCase()
  return normalized === "onmicrosoft.com" || normalized.endsWith(".onmicrosoft.com")
}

export function connectSummary(
  setup: {
    issuer?: string | null
    idpEntityId?: string | null
    idpMetadataUrl?: string | null
  } | null,
  fallback: string,
): string {
  if (!setup) return fallback
  if (setup.issuer) {
    return setup.issuer.replace(/^https?:\/\//, "").replace(/\/+$/, "")
  }
  if (setup.idpEntityId) {
    return setup.idpEntityId.replace(/^https?:\/\//, "").replace(/\/+$/, "")
  }
  if (setup.idpMetadataUrl) {
    return setup.idpMetadataUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "")
  }
  return fallback
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i
const TLD = /^[a-z]{2,}$/i

/** What the OIDC issuer field accepts for this provider, said exactly when it does not. */
export function oidcIssuerCheck(provider: string): (value: string) => string | null {
  return (raw: string) => {
    const value = raw.trim()
    if (!value) return null

    if (provider === "okta") {
      if (/\s/.test(value)) return "An Okta domain cannot contain spaces."
      if (/^http:\/\//i.test(value)) return "Use https, not http."
      const bare = value.replace(/^https?:\/\//i, "").replace(/\/+$/, "")
      if (bare.includes("/")) return "Just the Okta domain, leave off the path."
      if (bare.includes("@")) return "Enter your Okta domain, not an email address."
      const labels = bare.split(".")
      if (labels.length < 2) return "Enter your Okta domain, like acme.okta.com."
      if (labels.some((l) => !l || !LABEL.test(l))) {
        return "That does not look like an Okta domain."
      }
      if (!TLD.test(labels[labels.length - 1] ?? "")) {
        return "Enter your Okta domain, like acme.okta.com."
      }
      return null
    }

    if (provider === "entra") {
      if (TENANT_UUID.test(value)) return null
      if (/^http:\/\//i.test(value)) return "Use https, not http."
      if (/^https:\/\//i.test(value)) {
        try {
          new URL(value)
          return null
        } catch {
          return "Enter a valid https URL or directory ID."
        }
      }
      return "Enter your Directory ID (UUID) or an https issuer URL."
    }

    if (/^http:\/\//i.test(value)) return "Use https, not http."
    if (!/^https:\/\//i.test(value)) {
      return "Enter an https issuer URL, like https://idp.example.com."
    }
    try {
      new URL(value)
      return null
    } catch {
      return "Enter a valid https URL."
    }
  }
}
