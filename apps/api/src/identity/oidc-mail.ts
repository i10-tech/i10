import { isIP } from "node:net"
import { z } from "zod"
import type { Connection } from "./model.js"
import { IdpUnreachable, type OidcFetch } from "./oidc-fetch.js"

/**
 * An OIDC provider as the place a managed account's MAIL password is asked
 * (#383, B9): Okta, Keycloak, Auth0, PingFederate, FusionAuth, or any provider
 * whose token endpoint takes a public client's password grant.
 *
 * A managed account's password belongs to its company, so authd never asks Clerk
 * about it (ldap.ts). For an OIDC connection the company's directory is its
 * provider: authd sends the password to the provider's token endpoint as an OAuth
 * password grant, and the provider's yes or no is the answer.
 *
 * ⚠ NOTHING HERE IS A SECRET. The settings are the issuer, the token endpoint
 * read from its discovery document, and a PUBLIC client id (no client secret, no
 * basic auth); nothing is sealed, and i10 stores no mail password, hash, app
 * password or per-device secret for this. Which providers could not be offered
 * for that reason is in services/authd/internal/oidc/presets.go (OneLogin).
 *
 * ⚠ WHERE THINGS LIVE: `config.oidcMail` = `{ preset, issuer, clientId,
 * tokenEndpoint, extra, enabled }`, and only that. Event-hook state (Okta, step
 * 2b) is kept elsewhere on the connection, so a write here never has to know
 * about it; the routes spread what they find. An Okta-only `config.oktaMail`
 * (`{ issuer, clientId, enabled }`, from before this lane was generic) is still
 * READ, as the okta preset with the issuer's /v1/token, and is replaced by
 * `oidcMail` on the next write; nothing is migrated in bulk.
 *
 * ⚠ THE TRUST RULE (sso.md 2.14) APPLIES, HARDER THAN FOR AN ISSUER OF SIGN-IN:
 * the token endpoint decides which server every member's mail password is POSTed
 * to. An attacker-chosen one is a password harvester, so changing or enabling
 * these is an owner's move, with step-up (routes/console/identity-oidc-mail.ts).
 *
 * ⚠ THE TOKEN ENDPOINT IS READ FROM DISCOVERY, ONCE, WHEN AN OWNER SAVES, and is
 * then the value the owner approved: authd does not fetch discovery again at
 * bind time. A provider that later moves its token endpoint breaks sign-in until
 * an owner saves again; that is an outage an admin can see and fix, where an
 * endpoint that quietly followed the provider's document would let whoever can
 * change that document choose where passwords go. It must be on the ISSUER'S OWN
 * HOST (`canonicalTokenEndpoint`).
 */

/** The key in the connection's `config`. */
export const OIDC_MAIL_KEY = "oidcMail"
/** Okta's own key from before this lane was generic. Only ever read. */
export const LEGACY_OKTA_MAIL_KEY = "oktaMail"

/** In the order the console lists them. Mirrors services/authd/internal/oidc/presets.go. */
export const OIDC_MAIL_PRESETS = [
  "okta",
  "keycloak",
  "auth0",
  "ping",
  "fusionauth",
  "generic",
] as const
export type OidcMailPreset = (typeof OIDC_MAIL_PRESETS)[number]

export const isOidcMailPreset = (v: unknown): v is OidcMailPreset =>
  typeof v === "string" && (OIDC_MAIL_PRESETS as readonly string[]).includes(v)

/** The fields whose change is a change of who is trusted. */
export const OIDC_MAIL_FIELDS = ["preset", "issuer", "clientId", "extra"] as const
export type OidcMailField = (typeof OIDC_MAIL_FIELDS)[number]

// Mirrors services/authd/internal/oidc (Settings.Validate and the preset table):
// the API and authd must agree, or a value saved here is refused at the first
// bind.
const HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
/** Zero to eight plain segments: no empty one, no `%`, so nothing decodes two ways. */
const PATH = /^(?:\/[A-Za-z0-9._~-]{1,64}){0,8}$/
const OKTA_SERVER_PATH = /^\/oauth2\/[0-9A-Za-z]{1,64}$/
const OKTA_CLIENT_ID = /^0oa[0-9A-Za-z]{17}$/
const ANY_CLIENT_ID = /^[\x21-\x7e]{1,256}$/
/** Printable, a space only inside (a scope is "openid email"). */
const EXTRA_VALUE = /^[\x21-\x7e](?:[\x20-\x7e]{0,254}[\x21-\x7e])?$/

interface ExtraField {
  key: string
  label: string
}

interface PresetRules {
  label: string
  issuerHint: string
  clientIdHint: string
  clientId: RegExp
  clientIdMessage: string
  /** When set, the only path an issuer may have. */
  issuerPath: RegExp | null
  issuerPathMessage: string
  /** Optional, non-secret form fields. `scope` is on every preset. */
  extras: readonly ExtraField[]
}

const SCOPE: ExtraField = { key: "scope", label: "Scope (default: openid)" }
const ANY_ID_MESSAGE =
  "clientId must be printable text of up to 256 characters, with no spaces."

const RULES: Readonly<Record<OidcMailPreset, PresetRules>> = {
  okta: {
    label: "Okta",
    issuerHint: "https://your-org.okta.com/oauth2/default",
    clientIdHint: "0oa1b2c3d4e5f6g7h8i9",
    clientId: OKTA_CLIENT_ID,
    clientIdMessage: "clientId must be an Okta client id, like 0oa1b2c3d4e5f6g7h8i9.",
    // The org authorization server has no password grant; a custom one does.
    issuerPath: OKTA_SERVER_PATH,
    issuerPathMessage:
      "For Okta the issuer must be a custom authorization server, like https://your-org.okta.com/oauth2/default.",
    extras: [SCOPE],
  },
  keycloak: {
    label: "Keycloak",
    issuerHint: "https://sso.example.com/realms/your-realm",
    clientIdHint: "mail-client",
    clientId: ANY_CLIENT_ID,
    clientIdMessage: ANY_ID_MESSAGE,
    issuerPath: null,
    issuerPathMessage: "",
    extras: [SCOPE],
  },
  auth0: {
    label: "Auth0",
    issuerHint: "https://your-tenant.auth0.com",
    clientIdHint: "Zk3q9XvYw0aB5cD7eF1gH2iJ4kL6mN8o",
    clientId: ANY_CLIENT_ID,
    clientIdMessage: ANY_ID_MESSAGE,
    issuerPath: null,
    issuerPathMessage: "",
    // A realm is a named connection (the password-realm grant); without one the
    // tenant's Default Directory decides. An audience is the API the token is for.
    extras: [
      { key: "audience", label: "Audience (API identifier)" },
      { key: "realm", label: "Realm (connection name)" },
      SCOPE,
    ],
  },
  ping: {
    label: "PingFederate",
    issuerHint: "https://auth.example.com",
    clientIdHint: "mail-client",
    clientId: ANY_CLIENT_ID,
    clientIdMessage: ANY_ID_MESSAGE,
    issuerPath: null,
    issuerPathMessage: "",
    extras: [{ key: "validator_id", label: "Password credential validator id" }, SCOPE],
  },
  fusionauth: {
    label: "FusionAuth",
    issuerHint: "https://auth.example.com",
    clientIdHint: "85a03867-dccf-4882-adde-1a79aeec50df",
    clientId: ANY_CLIENT_ID,
    clientIdMessage: ANY_ID_MESSAGE,
    issuerPath: null,
    issuerPathMessage: "",
    extras: [SCOPE],
  },
  generic: {
    label: "Other OpenID Connect provider",
    issuerHint: "https://idp.example.com",
    clientIdHint: "mail-client",
    clientId: ANY_CLIENT_ID,
    clientIdMessage: ANY_ID_MESSAGE,
    issuerPath: null,
    issuerPathMessage: "",
    extras: [
      { key: "audience", label: "Audience" },
      { key: "resource", label: "Resource" },
      SCOPE,
    ],
  },
}

/** What the console shows for each preset: no regex, only words. */
export const OIDC_MAIL_CATALOG = OIDC_MAIL_PRESETS.map((id) => ({
  id,
  label: RULES[id].label,
  issuerHint: RULES[id].issuerHint,
  clientIdHint: RULES[id].clientIdHint,
  extras: RULES[id].extras,
}))

/**
 * The preset a connection's provider starts with, or null when the provider has
 * no OIDC mail lane.
 *
 * ⚠ ENTRA, GOOGLE AND ONELOGIN ARE NOT HERE ON PURPOSE. Entra and Google have
 * their own mail sign-in (#383 PR 4, #400); OneLogin's password grant is
 * documented only with a client secret, which i10 does not hold. An owner may
 * pick any other preset for a provider that has one (a custom Keycloak behind a
 * "generic" connection), never one for a provider that has none.
 */
const DEFAULT_PRESET: Readonly<Record<string, OidcMailPreset | null>> = {
  okta: "okta",
  ping: "ping",
  jumpcloud: "generic",
  generic: "generic",
  entra: null,
  google: null,
  onelogin: null,
}

export function defaultPresetFor(provider: string): OidcMailPreset | null {
  return Object.hasOwn(DEFAULT_PRESET, provider)
    ? (DEFAULT_PRESET[provider] ?? null)
    : null
}

/** A space or a control character of any kind. (ldap.ts has the same loop, without the space; it imports this file.) */
function hasControlOrSpace(value: string): boolean {
  for (const ch of value) {
    const c = ch.codePointAt(0)!
    if (c <= 0x20 || (c >= 0x7f && c <= 0x9f)) return true
  }
  return false
}

/**
 * A URL that is a public DNS name and a plain path, or null: https, no port, no
 * credentials, no query, no fragment, no IP literal.
 *
 * ⚠ THE STRING CHECK IS NOT THE EGRESS GUARD, as for an OIDC issuer or an LDAP
 * host. It refuses what is obviously wrong so the admin hears it at once; the
 * real check resolves the name and vets every address at every connection
 * (services/authd/internal/egress, and `guardedFetch` for discovery).
 */
function plainHttpsUrl(raw: string): URL | null {
  // ⚠ The URL parser DROPS tabs and newlines, where authd's refuses them. A value
  // the two read differently is one they disagree about.
  if (hasControlOrSpace(raw) || raw.includes("?") || raw.includes("#")) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== "https:" || url.username || url.password) return null
  if (url.port || url.search || url.hash) return null
  const host = url.hostname
  const bare = host.replace(/^\[(.*)\]$/, "$1")
  if (isIP(bare) !== 0 || !HOSTNAME.test(host)) return null
  // `127.1.2.3`-shaped names that are not an address in the strict sense.
  if (/^[0-9]+$/.test(host.slice(host.lastIndexOf(".") + 1))) return null
  return url
}

/** A path of plain segments, no `.`, `..` or `...`. */
function plainPath(path: string): boolean {
  return PATH.test(path) && !path.split("/").some((s) => s !== "" && /^\.+$/.test(s))
}

/**
 * The issuer in the one form authd accepts, or null: `https://<dns name>[/path]`.
 * A trailing slash is dropped (Auth0's issuer ends in one) and the host
 * lower-cased, so what is stored is what authd compares.
 */
export function canonicalIssuer(raw: string): string | null {
  const url = plainHttpsUrl(raw)
  if (!url) return null
  const path = url.pathname.replace(/\/$/, "")
  if (!plainPath(path)) return null
  return `https://${url.hostname}${path}`
}

/**
 * The token endpoint a discovery document names, in the form authd accepts, or
 * the reason it is refused.
 *
 * ⚠ ON THE ISSUER'S OWN HOST, EXACTLY: same name, https on 443. It is where every
 * managed member's mail password goes, and a discovery document is the
 * provider's own word, so one that names another host is a provider (or whoever
 * controls its document) choosing where the owner's approved issuer sends
 * passwords. Exact host rather than "the same registrable domain": acme.okta.com
 * and evil.okta.com share okta.com, and no preset here splits its issuer and
 * token endpoint across hosts. A provider that does is refused, loudly, on save.
 */
export function canonicalTokenEndpoint(
  raw: unknown,
  issuerHost: string,
): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof raw !== "string")
    return { ok: false, message: "The discovery document has no token_endpoint." }
  const url = plainHttpsUrl(raw)
  if (!url)
    return {
      ok: false,
      message:
        "The token endpoint is not a plain https URL on a public name (no port, query, fragment or credentials).",
    }
  if (url.hostname !== issuerHost)
    return {
      ok: false,
      message: `The token endpoint is on ${url.hostname}, not on the issuer's host ${issuerHost}. Mail passwords are only ever sent to the issuer's own host.`,
    }
  if (url.pathname.endsWith("/") || !plainPath(url.pathname))
    return {
      ok: false,
      message:
        "The token endpoint's path is not plain segments, or it ends in a slash.",
    }
  return { ok: true, value: `https://${url.hostname}${url.pathname}` }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/** `config.oidcMail`. */
export interface StoredOidcMail {
  preset?: string
  issuer?: string
  clientId?: string
  tokenEndpoint?: string
  extra?: Record<string, string>
  enabled?: boolean
}

/** What the PUT can say about `extra`. Empty values mean "not set". */
const extraInput = z
  .record(z.string().max(64), z.string().trim().max(256))
  .refine((e) => Object.keys(e).length <= 16, { message: "extra has too many fields." })
  .transform((e) => Object.fromEntries(Object.entries(e).filter(([, v]) => v !== "")))

/** The PUT body: only what is present changes. `extra` replaces the whole object. */
export const oidcMailInput = z
  .object({
    preset: z
      .string()
      .refine(isOidcMailPreset, {
        message: `preset must be one of ${OIDC_MAIL_PRESETS.join(", ")}.`,
      })
      .transform((v) => v as OidcMailPreset)
      .optional(),
    issuer: z
      .string()
      .trim()
      .max(512)
      .refine((v) => canonicalIssuer(v) !== null, {
        message:
          "issuer must be an https URL on a public name, like https://sso.example.com/realms/acme (no port, query or credentials).",
      })
      .transform((v) => canonicalIssuer(v) as string)
      .optional(),
    // The preset's own format is checked once the preset is known (settingsProblem).
    clientId: z
      .string()
      .trim()
      .min(1, { message: "clientId is empty." })
      .max(256)
      .optional(),
    extra: extraInput.optional(),
    enabled: z.boolean().optional(),
  })
  .strict()

export type OidcMailInput = z.infer<typeof oidcMailInput>

/**
 * `config.oidcMail`, or an Okta-only `config.oktaMail` read as one.
 *
 * ⚠ THE LEGACY KEY IS ONLY READ FOR AN OKTA CONNECTION, as before: its provider
 * is what says its people are Okta's, so the key on any other is ignored even if
 * something put it there. `oidcMail`, once present, wins outright.
 */
export function storedOidcMail(
  connection: Pick<Connection, "config" | "provider">,
): StoredOidcMail {
  const raw = connection.config[OIDC_MAIL_KEY]
  if (isRecord(raw)) return raw as StoredOidcMail
  const legacy = connection.config[LEGACY_OKTA_MAIL_KEY]
  if (connection.provider !== "okta" || !isRecord(legacy)) return {}
  // ⚠ WHATEVER ELSE IS IN THE OBJECT COMES ALONG: the next write replaces the
  // key, and a field some other feature put there is not this module's to drop.
  // Its token endpoint was always the issuer's /v1/token.
  const out = { ...legacy, preset: "okta" } as StoredOidcMail
  if (typeof legacy.issuer === "string") out.tokenEndpoint = `${legacy.issuer}/v1/token`
  return out
}

/**
 * Whether the connection's mail lane is on, from the raw config and whatever the
 * provider.
 *
 * ⚠ NOT PROVIDER-AWARE ON PURPOSE: it is what LDAP's "one place for passwords"
 * check asks, and a row that says it is on must count even where `oidcMailFor`
 * would ignore it. Refusing to turn LDAP on too is the safe side.
 */
export function oidcMailEnabled(config: Record<string, unknown>): boolean {
  const own = config[OIDC_MAIL_KEY]
  const stored = isRecord(own) ? own : config[LEGACY_OKTA_MAIL_KEY]
  return isRecord(stored) && stored.enabled === true
}

/** What authd needs to ask a provider about a password. */
export interface OidcMailSettings {
  preset: OidcMailPreset
  issuer: string
  tokenEndpoint: string
  clientId: string
  extra: Record<string, string>
}

/** The extras, as an object of strings, or null if they are not that. */
export function storedExtra(raw: unknown): Record<string, string> | null {
  if (raw === undefined) return {}
  if (!isRecord(raw)) return null
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "string") return null
    out[k] = v
  }
  return out
}

/**
 * The first thing wrong with the settings that ARE set, in words for the owner,
 * or null. Fields not yet set are not wrong; `completeOidcMail` is what asks for
 * them all.
 */
export function settingsProblem(s: StoredOidcMail): string | null {
  if (!isOidcMailPreset(s.preset))
    return s.preset === undefined ? null : "Unknown preset."
  const rules = RULES[s.preset]
  if (s.issuer !== undefined && rules.issuerPath) {
    const path = s.issuer.replace(/^https:\/\/[^/]+/, "")
    if (!rules.issuerPath.test(path)) return rules.issuerPathMessage
  }
  if (s.clientId !== undefined && !rules.clientId.test(s.clientId))
    return rules.clientIdMessage
  const extra = storedExtra(s.extra)
  if (extra === null) return "extra must be an object of text values."
  const allowed = rules.extras.map((e) => e.key)
  for (const [k, v] of Object.entries(extra)) {
    if (!allowed.includes(k))
      return `The ${rules.label} preset does not take the field "${k}". It takes: ${allowed.join(", ")}.`
    if (!EXTRA_VALUE.test(v))
      return `"${k}" must be printable text of up to 256 characters, with no space at either end.`
  }
  return null
}

/**
 * The settings, or null while something is missing or no longer valid.
 *
 * ⚠ RE-CHECKED ON READ. The column is JSON that anything with write access can
 * change; a value that would not pass the PUT is not handed to authd. Includes
 * the token endpoint's host rule, so a row edited by hand cannot point an
 * approved issuer's passwords elsewhere.
 */
export function completeOidcMail(stored: StoredOidcMail): OidcMailSettings | null {
  const { preset, issuer, tokenEndpoint, clientId } = stored
  if (
    !isOidcMailPreset(preset) ||
    typeof issuer !== "string" ||
    typeof tokenEndpoint !== "string" ||
    typeof clientId !== "string"
  )
    return null
  const canonical = canonicalIssuer(issuer)
  if (canonical === null || canonical !== issuer) return null
  const token = canonicalTokenEndpoint(tokenEndpoint, new URL(canonical).hostname)
  if (!token.ok || token.value !== tokenEndpoint) return null
  const extra = storedExtra(stored.extra)
  if (extra === null || settingsProblem(stored) !== null) return null
  return { preset, issuer, tokenEndpoint, clientId, extra }
}

/**
 * The OIDC lane for a connection, or null if it does not run one.
 *
 * ⚠ ONLY A PROVIDER THAT HAS THE LANE (`defaultPresetFor`), enabled, whole. A
 * connection's `provider` is what says whose people they are, so `config.oidcMail`
 * on Entra or Google is ignored even if something put it there.
 */
export function oidcMailFor(
  connection: Pick<Connection, "provider" | "config">,
): OidcMailSettings | null {
  if (defaultPresetFor(connection.provider) === null) return null
  const stored = storedOidcMail(connection)
  return stored.enabled === true ? completeOidcMail(stored) : null
}

const sameExtra = (a: Record<string, string>, b: Record<string, string>): boolean => {
  const ka = Object.keys(a)
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k])
}

/**
 * What a PUT would write for the settings, and which settings it moves. The one
 * place that decides it, run before the lock (to know whether to go and read
 * discovery) and under it (to write).
 *
 * `extra` belongs to a preset, so a PUT that moves the preset and says nothing
 * about `extra` clears it rather than carrying Auth0's realm to Keycloak.
 */
export function applyInput(
  stored: StoredOidcMail,
  input: OidcMailInput,
  fallbackPreset: OidcMailPreset,
): { next: StoredOidcMail; changed: OidcMailField[] } {
  const next: StoredOidcMail = { ...stored }
  const changed: OidcMailField[] = []
  const was = stored.preset
  if (input.preset !== undefined && input.preset !== was) {
    changed.push("preset")
    next.preset = input.preset
    if (input.extra === undefined && Object.keys(stored.extra ?? {}).length > 0) {
      next.extra = {}
      changed.push("extra")
    }
  }
  for (const k of ["issuer", "clientId"] as const) {
    const v = input[k]
    if (v !== undefined && v !== (stored[k] ?? null)) {
      changed.push(k)
      next[k] = v
    }
  }
  if (input.extra !== undefined) {
    const before = storedExtra(stored.extra) ?? {}
    if (!sameExtra(input.extra, before)) {
      if (!changed.includes("extra")) changed.push("extra")
      next.extra = input.extra
    }
  }
  // A stored row without a preset takes the provider's default once anything moves.
  if (changed.length > 0 && next.preset === undefined) next.preset = fallbackPreset
  return { next, changed }
}

/** Discovery could not be had: `unreachable` is ours or the network's, `refused` is the document's. */
export class DiscoveryFailed extends Error {
  constructor(
    message: string,
    readonly kind: "unreachable" | "refused",
  ) {
    super(message)
    this.name = "DiscoveryFailed"
  }
}

const UNREACHABLE: Record<IdpUnreachable["kind"], string> = {
  blocked: "i10 will not connect to that address: it is not a public one.",
  unresolved: "The issuer's name did not resolve.",
  timeout: "The issuer did not answer in time.",
  network: "The issuer could not be reached.",
  too_large: "The issuer's discovery document is too large.",
}

const PASSWORD_GRANT = "password"
/** Auth0's extension grant, used when a realm is set. */
const AUTH0_REALM_GRANT = "http://auth0.com/oauth/grant-type/password-realm"

/**
 * Reads the token endpoint from the issuer's discovery document, through the
 * egress guard (`fetch` is `guardedFetch`, applied to the discovery URL and to
 * nothing else the document names).
 *
 * ⚠ THE DOCUMENT'S `issuer` IS NOT COMPARED WITH THE ONE GIVEN, which is what an
 * OIDC relying party must do before it TRUSTS tokens. Nothing here trusts a
 * token: the only thing taken from the document is a URL, and that one must be on
 * the issuer's own host (`canonicalTokenEndpoint`). FusionAuth's `issuer` is
 * a free-form string that is usually not the URL it is served from.
 *
 * `grant_types_supported`, when the document has it, must list the password
 * grant: a provider that says it does not support one is refused here, in words,
 * where it would otherwise be an `unsupported_grant_type` at every bind.
 */
export async function discoverTokenEndpoint(input: {
  issuer: string
  preset: OidcMailPreset
  extra: Record<string, string>
  fetch: OidcFetch
}): Promise<string> {
  const url = `${input.issuer}/.well-known/openid-configuration`
  let response: Response
  try {
    response = await input.fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "manual",
    })
  } catch (error) {
    throw new DiscoveryFailed(
      error instanceof IdpUnreachable ? UNREACHABLE[error.kind] : UNREACHABLE.network,
      "unreachable",
    )
  }
  if (response.status >= 500)
    throw new DiscoveryFailed(
      `The issuer answered ${response.status}. Try again later.`,
      "unreachable",
    )
  if (response.status >= 300 && response.status < 400)
    throw new DiscoveryFailed(
      "The discovery URL redirects. Give the issuer that serves its own document.",
      "refused",
    )
  if (!response.ok)
    throw new DiscoveryFailed(
      `${url} answered ${response.status}. Check the issuer URL.`,
      "refused",
    )

  let doc: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(await response.text())
    if (!isRecord(parsed)) throw new Error()
    doc = parsed
  } catch {
    throw new DiscoveryFailed("The discovery document is not JSON.", "refused")
  }

  const token = canonicalTokenEndpoint(
    doc.token_endpoint,
    new URL(input.issuer).hostname,
  )
  if (!token.ok) throw new DiscoveryFailed(token.message, "refused")

  const grants = doc.grant_types_supported
  if (Array.isArray(grants)) {
    const accepted = [
      PASSWORD_GRANT,
      ...(input.preset === "auth0" && input.extra.realm ? [AUTH0_REALM_GRANT] : []),
    ]
    if (!grants.some((g) => typeof g === "string" && accepted.includes(g)))
      throw new DiscoveryFailed(
        "The provider's discovery document does not list the password grant (grant_types_supported), so it will not accept mail passwords this way.",
        "refused",
      )
  }
  return token.value
}
