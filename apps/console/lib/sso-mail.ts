import type { LdapSetup, OidcMailSetup, SsoAbilities } from "./sso-types"

/**
 * The decisions behind a connection's "Mail sign-in" section (#383), kept out
 * of the components so they can be read, and tested, as plain functions.
 *
 * Three lanes decide where a managed person's mail password is checked, and the
 * API lets only ONE be on per connection (each refuses to turn on while the
 * other is). The section never trusts itself to keep that true: moving between
 * lanes asks the API to turn the old one off first.
 */

export type MailLane = "off" | "oidc" | "ldap"

/** The lane that is on right now. The API refuses both on, so OIDC winning a tie is only a fallback. */
export function activeLane(
  oidc: Pick<OidcMailSetup, "enabled"> | null,
  ldap: Pick<LdapSetup, "enabled"> | null,
): MailLane {
  if (oidc?.enabled) return "oidc"
  if (ldap?.enabled) return "ldap"
  return "off"
}

/** How a provider reads in a sentence. Anything without a name of its own is "your identity provider". */
const PROVIDER_NAME: Record<string, string> = {
  okta: "Okta",
  ping: "PingFederate",
  jumpcloud: "JumpCloud",
}

const UNNAMED = "your identity provider"

export function providerName(provider: string): string {
  return PROVIDER_NAME[provider] ?? UNNAMED
}

/** "their Okta password", or "their company password" where the provider has no name to say. */
export const passwordOf = (name: string): string =>
  name === UNNAMED ? "company password" : `${name} password`

/** Who checks the password on the OIDC lane, as a name: the chosen preset's, else the provider's. */
export function oidcProviderName(
  data: Pick<OidcMailSetup, "preset" | "defaultPreset" | "presets">,
  provider: string,
): string {
  const id = data.preset ?? data.defaultPreset
  const info = data.presets.find((p) => p.id === id)
  return info && info.id !== "generic" ? info.label : providerName(provider)
}

/**
 * Whether changing the OIDC lane is this person's move. The API wants
 * `owners:manage` for any change to it, on every connection status; the one
 * thing an admin keeps is turning it off.
 */
export const canChangeOidcMail = (abilities: Pick<SsoAbilities, "owner">): boolean =>
  abilities.owner

export interface OidcMailForm {
  preset: string
  issuer: string
  clientId: string
  extra: Record<string, string>
}

/** The form a saved answer fills in. A preset never chosen shows the provider's default. */
export function oidcMailForm(data: OidcMailSetup): OidcMailForm {
  return {
    preset: data.preset ?? data.defaultPreset ?? data.presets[0]?.id ?? "generic",
    issuer: data.issuer ?? "",
    clientId: data.clientId ?? "",
    extra: { ...data.extra },
  }
}

const sameExtra = (a: Record<string, string>, b: Record<string, string>) => {
  const keys = Object.keys(a).filter((k) => a[k] !== "")
  const other = Object.keys(b).filter((k) => b[k] !== "")
  return keys.length === other.length && keys.every((k) => a[k] === b[k])
}

/** Whether the form differs from what is saved. */
export function oidcMailDirty(form: OidcMailForm, data: OidcMailSetup): boolean {
  const saved = oidcMailForm(data)
  return (
    form.preset !== saved.preset ||
    form.issuer.trim() !== saved.issuer ||
    form.clientId.trim() !== saved.clientId ||
    !sameExtra(form.extra, saved.extra)
  )
}

/** Whether the saved settings are whole enough for the API to let the lane turn on. */
export const oidcMailComplete = (data: OidcMailSetup): boolean =>
  Boolean(data.issuer && data.clientId && data.tokenEndpoint)

/**
 * Why the lane's switch cannot be turned ON right now, in words, or null.
 * Turning it off is never blocked here.
 */
export function oidcMailEnableBlock(
  data: OidcMailSetup,
  form: OidcMailForm,
  abilities: Pick<SsoAbilities, "owner">,
): string | null {
  if (!canChangeOidcMail(abilities))
    return "Only a workspace owner can turn this on. Ask an owner."
  if (data.ldapEnabled) return "Turn the directory password check off first."
  if (oidcMailDirty(form, data)) return "Save your changes first."
  if (!oidcMailComplete(data)) return "Save the issuer and client ID first."
  return null
}

/** The save needs both of these; the API has no way to unset either. */
export const oidcMailSavable = (form: OidcMailForm): boolean =>
  form.issuer.trim() !== "" && form.clientId.trim() !== ""

/**
 * The body of the save: every field, trimmed. The API changes only what
 * differs, so sending what is already saved is harmless. `allowed` is the
 * extras the chosen preset takes; one left over from another preset is dropped.
 */
export function oidcMailBody(form: OidcMailForm, allowed: readonly string[]) {
  const extra = Object.fromEntries(
    Object.entries(form.extra)
      .filter(([key]) => allowed.includes(key))
      .map(([key, value]) => [key, value.trim()] as const)
      .filter(([, value]) => value !== ""),
  )
  return {
    preset: form.preset,
    issuer: form.issuer.trim(),
    clientId: form.clientId.trim(),
    extra,
  }
}
