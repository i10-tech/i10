import type { Protocol } from "./model.js"
import { presetOf } from "./oidc-presets.js"
import { samlPresetOf } from "./saml-presets.js"

/**
 * What each identity provider can actually prove over OIDC and SAML (P0 #5,
 * sso.md 2.22), from live probes against real tenants:
 *
 *   - Google OIDC sends no `amr`, `acr` or `auth_time` (discovery lists none).
 *   - Google SAML sets `AuthnContextClassRef` to `unspecified` and ignores
 *     `ForceAuthn="true"`, returning the earlier `AuthnInstant`.
 *   - Entra OIDC v2 sends no `amr`; it sends `auth_time` only once the admin
 *     adds the optional `auth_time` claim to the ID token.
 *   - Entra SAML proves MFA via `authnmethodsreferences` (`multipleauthn`, read
 *     by `SAML_PRESETS.entra.amr`), and our SAML engine already sends
 *     `ForceAuthn="true"` (`saml.ts`) and checks the signed `AuthnInstant`
 *     (`saml-verify.ts`, `bridge.ts`), which Entra SAML includes by default.
 *   - Okta OIDC sends `amr` and `auth_time` out of the box.
 *   - Okta SAML returns a fixed `AuthnContextClassRef` and ignores `ForceAuthn`
 *     by default: MFA proof requires sending `session.amr` as an attribute we
 *     read (`amr`), and fresh sign-in requires "Honor Force Authentication: Yes".
 *   - Generic (and other certified OIDC / SAML providers) keep today's
 *     behaviour (`yes` / `yes`).
 */

export type CapabilityLevel = "yes" | "with_setting" | "no"

export interface IdpCapabilities {
  protocol: Protocol
  provider: string
  label: string
  canProveMfa: CapabilityLevel
  canProveFreshAuth: CapabilityLevel
  /** Exact IdP instruction shown when `canProveMfa` is `with_setting`. */
  mfaSetting: string | null
  /** Exact IdP instruction shown when `canProveFreshAuth` is `with_setting`. */
  freshAuthSetting: string | null
}

interface Entry {
  canProveMfa: CapabilityLevel
  canProveFreshAuth: CapabilityLevel
  mfaSetting?: string
  freshAuthSetting?: string
}

const DEFAULT_ENTRY: Entry = {
  canProveMfa: "yes",
  canProveFreshAuth: "yes",
}

export const IDP_CAPABILITIES: Readonly<
  Record<"oidc" | "saml", Readonly<Record<string, Entry>>>
> = {
  oidc: {
    google: {
      canProveMfa: "no",
      canProveFreshAuth: "no",
    },
    entra: {
      canProveMfa: "no",
      canProveFreshAuth: "with_setting",
      freshAuthSetting:
        "Add the optional claim auth_time to the ID token in your Entra app registration.",
    },
    okta: {
      canProveMfa: "yes",
      canProveFreshAuth: "yes",
    },
    jumpcloud: DEFAULT_ENTRY,
    onelogin: DEFAULT_ENTRY,
    ping: DEFAULT_ENTRY,
    generic: DEFAULT_ENTRY,
  },
  saml: {
    google: {
      canProveMfa: "no",
      canProveFreshAuth: "no",
    },
    entra: {
      canProveMfa: "yes",
      canProveFreshAuth: "yes",
    },
    okta: {
      canProveMfa: "with_setting",
      mfaSetting:
        "Send session.amr as an attribute named amr in your Okta SAML app so i10 can read it.",
      canProveFreshAuth: "with_setting",
      freshAuthSetting:
        "Set Honor Force Authentication to Yes in your Okta SAML app.",
    },
    generic: DEFAULT_ENTRY,
  },
}

function providerLabel(protocol: Protocol, provider: string): string {
  if (protocol === "oidc") return presetOf(provider)?.label ?? provider
  if (protocol === "saml") return samlPresetOf(provider)?.label ?? provider
  return provider
}

export function capabilitiesOf(
  protocol: Protocol,
  provider: string,
): IdpCapabilities {
  const table = protocol === "oidc" || protocol === "saml" ? IDP_CAPABILITIES[protocol] : null
  const entry =
    table && Object.hasOwn(table, provider) ? table[provider]! : DEFAULT_ENTRY
  return {
    protocol,
    provider,
    label: providerLabel(protocol, provider),
    canProveMfa: entry.canProveMfa,
    canProveFreshAuth: entry.canProveFreshAuth,
    mfaSetting: entry.mfaSetting ?? null,
    freshAuthSetting: entry.freshAuthSetting ?? null,
  }
}

export function mfaUnprovableMessage(
  capabilities: Pick<IdpCapabilities, "label" | "protocol">,
): string {
  const protocolName = capabilities.protocol === "saml" ? "SAML" : "OIDC"
  return `${capabilities.label} cannot prove multi-factor sign-in over ${protocolName}, so requiring MFA would refuse every sign-in.`
}
