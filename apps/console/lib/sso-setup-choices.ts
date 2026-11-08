import type { SsoConnections } from "@/lib/sso-types"

export type IdpChoice = {
  idp: string
  label: string
  protocols: ("oidc" | "saml")[]
}

/** The identity providers, merged across the two protocols' presets. */
export function idpChoices(presets: SsoConnections["presets"]): IdpChoice[] {
  const byId = new Map<string, IdpChoice>()
  for (const p of presets.oidc)
    byId.set(p.id, { idp: p.id, label: p.label, protocols: ["oidc"] })
  for (const p of presets.saml) {
    const existing = byId.get(p.id)
    if (existing) existing.protocols.push("saml")
    else byId.set(p.id, { idp: p.id, label: p.label, protocols: ["saml"] })
  }
  // The generic presets are one choice for both protocols, so neither
  // preset's own label ("Other OpenID Connect provider") fits it.
  const generic = byId.get("generic")
  if (generic && generic.protocols.length > 1) generic.label = "Another provider"
  return [...byId.values()]
}

export function protocolOptions(protocols: ("oidc" | "saml")[]) {
  return protocols.map((protocol) =>
    protocol === "oidc"
      ? {
          value: protocol,
          label: "OpenID Connect",
          description: "Recommended. The fewest steps.",
        }
      : {
          value: protocol,
          label: "SAML 2.0",
          description: "If your company's policy asks for SAML.",
        },
  )
}

export function defaultConnectionName(label: string, protocol: "oidc" | "saml") {
  return `${label} (${protocol === "oidc" ? "OIDC" : "SAML"})`
}
