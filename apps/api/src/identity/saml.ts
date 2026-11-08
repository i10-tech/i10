import { createHash, type KeyObject } from "node:crypto"
import {
  attemptForCallback,
  completeLogin,
  precheckAttempt,
  refuseLogin,
  type BridgeDeps,
  type CompleteOutcome,
  type Engine,
} from "./bridge.js"
import {
  ATTEMPT_TTL_MS,
  hashSecret,
  newSecret,
  normaliseEmail,
  readSecret,
  upnAsAddress,
  type Assertion,
  type Connection,
  type GroupsState,
  type Refusal,
} from "./model.js"
import type {
  ClerkIdentity,
  IdentityStore,
  Logger,
  ReplayCache,
  SamlCertificateRow,
  SamlStore,
} from "./ports.js"
import { IdpUnreachable, type OidcFetch } from "./oidc-fetch.js"
import { privateKeyOf, type SpCertificate, type SpPrivateKey } from "./saml-crypto.js"
import {
  authnRequest,
  logoutRequest,
  logoutResponse,
  newRequestId,
  parseIdpMetadata,
  readPostLogout,
  readRedirectLogout,
  redirectUrl,
  spMetadata,
  type IdpMetadata,
  type SloRead,
} from "./saml-messages.js"
import { samlPresetOf, type SamlPreset } from "./saml-presets.js"
import {
  NAMEID,
  REPLAY_MAX_MS,
  verifySamlResponse,
  type VerifiedAssertion,
} from "./saml-verify.js"

/**
 * The SAML engine (#339, sso.md Option A and 2.16): our own SP, with
 * xml-crypto 6 doing the signature arithmetic and identity/saml-verify.ts
 * doing every rule the advisories were about.
 *
 *   begin:   an AuthnRequest on the HTTP-Redirect binding (signed with the
 *            connection's SP key when it signs requests), `ForceAuthn="true"`
 *            for a step-up or a forced login, RelayState = the attempt's state, its ID kept on
 *            the attempt for InResponseTo.
 *   ACS:     the HTTP-POST binding to apps/auth's `/sso/saml/acs/<id>`,
 *            forwarded to `POST /sso/saml/acs`: `finishSaml` below.
 *   SLO:     `/sso/saml/slo/<id>`, both bindings, LogoutRequests signed or
 *            refused, mapped through `idp_session` to revocations.
 *
 * Where things live on a connection:
 *
 *   config.saml    idpEntityId, ssoUrl, sloUrl, metadataUrl, nameIdFormat,
 *                  signRequests, requireEncryption, idpInitiated,
 *                  subjectAttribute, mfaContextClasses, spCertificates (PUBLIC)
 *   secrets.saml   spKeys - sealed (store.ts)
 *   saml_certificates   the IdP's signing certificates, several, for rotation
 *
 * ⚠ ONE SP ENTITY ID AND ONE ACS URL PER CONNECTION. An assertion names the
 * audience and recipient it was made for; with them per connection, an
 * assertion for one workspace's connection can never be spent on another's,
 * even when both trust the same IdP.
 */

// ── Settings ─────────────────────────────────────────────────────────────

/** `config.saml` as stored. Never a secret. */
export interface StoredSaml {
  idpEntityId?: string
  ssoUrl?: string
  sloUrl?: string | null
  sloResponseUrl?: string | null
  metadataUrl?: string | null
  /** When the metadata URL last answered something we could use. */
  metadataFetchedAt?: string | null
  /** A fixed code for why the last refresh failed, or null. */
  metadataError?: string | null
  nameIdFormat?: string
  signRequests?: boolean
  requireEncryption?: boolean
  /**
   * ⚠ IdP-INITIATED SIGN-IN, OFF UNLESS AN OWNER TURNS IT ON. An unsolicited
   * response answers no request of ours, so nothing ties it to the browser it
   * lands in; see `finishSaml`'s safeguards.
   */
  idpInitiated?: boolean
  /**
   * An attribute to use as the subject instead of the NameID, for IdPs whose
   * NameID is mutable (Google's is the primary email).
   *
   * ⚠ THE nOAuth RISK IS THE ADMIN'S CHOICE HERE. Whatever value this names is
   * what the account is linked by from then on; naming an email attribute
   * makes an address the identifier, so whoever holds that address at the IdP
   * next holds the account. Only an owner may set it on a live connection.
   */
  subjectAttribute?: string | null
  /** AuthnContextClassRef values that prove MFA, listed by an admin. */
  mfaContextClasses?: string[]
  /** Newest first: the first signs and decrypts, the second stays for a rotation. */
  spCertificates?: SpCertificate[]
}

/** `secrets.saml` once opened. */
export interface SealedSaml {
  spKeys?: SpPrivateKey[]
}

export interface SamlSettings {
  preset: SamlPreset
  idpEntityId: string
  ssoUrl: string
  sloUrl: string | null
  sloResponseUrl: string | null
  nameIdFormat: string
  signRequests: boolean
  requireEncryption: boolean
  idpInitiated: boolean
  subjectAttribute: string | null
  mfaContextClasses: string[]
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []

export function storedSaml(connection: Pick<Connection, "config">): StoredSaml {
  const raw = connection.config.saml
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as StoredSaml)
    : {}
}

export function sealedSaml(secrets: Record<string, unknown> | null): SealedSaml {
  const raw = secrets?.saml
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as SealedSaml)
    : {}
}

/** What the engine runs with, or null when the connection is not configured. */
export function samlSettings(
  connection: Pick<Connection, "config" | "provider">,
): SamlSettings | null {
  const preset = samlPresetOf(connection.provider)
  const s = storedSaml(connection)
  if (!preset || !s.idpEntityId || !s.ssoUrl) return null
  return {
    preset,
    idpEntityId: s.idpEntityId,
    ssoUrl: s.ssoUrl,
    sloUrl: s.sloUrl ?? null,
    sloResponseUrl: s.sloResponseUrl ?? null,
    nameIdFormat: s.nameIdFormat ?? preset.nameIdFormat,
    signRequests: s.signRequests === true,
    requireEncryption: s.requireEncryption === true,
    idpInitiated: s.idpInitiated === true,
    subjectAttribute: s.subjectAttribute ?? null,
    mfaContextClasses: strings(s.mfaContextClasses),
  }
}

/**
 * Whether the connection could sign somebody in: settings, a certificate that
 * verifies today, and our key when it signs requests or wants encryption.
 */
export function samlReady(
  connection: Pick<Connection, "config" | "provider">,
  certificates: readonly Pick<SamlCertificateRow, "notBefore" | "notAfter">[],
  now: Date = new Date(),
): boolean {
  const settings = samlSettings(connection)
  if (!settings) return false
  const live = certificates.some(
    (c) =>
      c.notBefore.getTime() <= now.getTime() && now.getTime() < c.notAfter.getTime(),
  )
  const keyed = (storedSaml(connection).spCertificates?.length ?? 0) > 0
  return live && (keyed || (!settings.signRequests && !settings.requireEncryption))
}

export interface SamlEndpoints {
  /** Our SP entity id, which is also where our metadata is. */
  entityId: string
  acsUrl: string
  sloUrl: string
}

export function samlEndpoints(authOrigin: string, connectionId: string): SamlEndpoints {
  const base = authOrigin.replace(/\/$/, "")
  return {
    entityId: `${base}/sso/saml/metadata/${connectionId}`,
    acsUrl: `${base}/sso/saml/acs/${connectionId}`,
    sloUrl: `${base}/sso/saml/slo/${connectionId}`,
  }
}

/**
 * The connection cannot be used as configured: no IdP settings, signing asked
 * for with no key. A 503 at sign-in (fail closed), a message in the console.
 */
export class SamlMisconfigured extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SamlMisconfigured"
  }
}

const oktaHost = (hostname: string): boolean =>
  /(^|\.)(okta|oktapreview|okta-emea|okta-gov)\.com$/i.test(hostname) ||
  hostname.endsWith(".okta.mil")

function publicOktaHost(hostname: string): string {
  const labels = hostname.split(".")
  labels[0] = labels[0]!.replace(/-admin$/i, "")
  return labels.join(".")
}

function oktaMetadataRemedy(hostname: string): string {
  return `Use the Metadata URL from the app's Sign On tab. It looks like https://${publicOktaHost(hostname)}/app/exk.../sso/saml/metadata.`
}

/** Explains Okta metadata addresses that are valid URLs but not public metadata endpoints. */
export function oktaMetadataUrlProblem(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (!oktaHost(parsed.hostname)) return null
  const path = parsed.pathname
  if (/^\/api\/v1\/apps\/[^/]+\/sso\/saml\/metadata\/?$/i.test(path))
    return `That is Okta's admin API address, which needs an Okta API token. ${oktaMetadataRemedy(parsed.hostname)}`
  if (/^\/app\/0oa[^/]+\/sso\/saml\/metadata\/?$/i.test(path))
    return `That address uses the app id (0oa...), which Okta answers with a 404. ${oktaMetadataRemedy(parsed.hostname)}`
  if (parsed.hostname.split(".")[0]!.endsWith("-admin") || path.startsWith("/admin/"))
    return `That is an Okta admin console address. ${oktaMetadataRemedy(parsed.hostname)}`
  return null
}

/** A URL that answered 404 or 410 is wrong, not unreachable: the admin can fix it. */
function metadataGoneProblem(url: string, status: number): string {
  const { hostname } = new URL(url)
  return oktaHost(hostname)
    ? `Okta answered ${status} for that metadata address. ${oktaMetadataRemedy(hostname)}`
    : `That metadata URL answered ${status}. Check the address with your identity provider.`
}

/** Redis could not say whether an assertion was seen. Always a 503. */
export class ReplayUnavailable extends Error {
  constructor() {
    super("the replay cache is unavailable")
    this.name = "ReplayUnavailable"
  }
}

/** The replay cache on our Redis: `SET key 1 PX ttl NX`. */
export function redisReplayCache(redis: {
  set(key: string, value: string, px: "PX", ttl: number, nx: "NX"): Promise<unknown>
  del(key: string): Promise<unknown>
}): ReplayCache {
  return {
    async release(key) {
      try {
        await redis.del(key)
      } catch {
        throw new ReplayUnavailable()
      }
    },
    async claim(key, ttlMs) {
      try {
        const done = await redis.set(
          key,
          "1",
          "PX",
          Math.max(1000, Math.round(ttlMs)),
          "NX",
        )
        return done === "OK"
      } catch {
        throw new ReplayUnavailable()
      }
    },
  }
}

/**
 * An IdP's metadata from its URL, through the egress guard: https, a vetted
 * public address, no redirects, 5 s, 256 KiB (identity/oidc-fetch.ts).
 * Unreachable is IdpUnreachable; unusable is SamlMisconfigured.
 */
export async function fetchIdpMetadata(
  fetch: OidcFetch,
  url: string,
): Promise<IdpMetadata> {
  const problem = oktaMetadataUrlProblem(url)
  if (problem) throw new SamlMisconfigured(problem)
  const response = await fetch(url, {
    method: "GET",
    headers: { accept: "application/samlmetadata+xml, application/xml, text/xml" },
    redirect: "manual",
  })
  if (response.status >= 300 && response.status < 400)
    throw new SamlMisconfigured("The metadata URL redirects; give the final URL.")
  if (response.status === 404 || response.status === 410)
    throw new SamlMisconfigured(metadataGoneProblem(url, response.status))
  if (!response.ok)
    throw new IdpUnreachable(`metadata answered ${response.status}`, "network")
  const parsed = parseIdpMetadata(await response.text())
  if ("error" in parsed) throw new SamlMisconfigured(parsed.error)
  return parsed
}

// ── The engine ───────────────────────────────────────────────────────────

export type SamlVerified =
  | { ok: true; verified: VerifiedAssertion; assertion: Assertion }
  | { ok: false; reason: Refusal; extra: Record<string, unknown> }

export interface SamlEngine extends Engine {
  protocol: "saml"
  endpoints(connectionId: string): SamlEndpoints
  /** Our SP metadata for a connection, as XML. */
  metadata(connection: Connection): string
  /** IdP metadata from a URL, through the egress guard. */
  fetchMetadata(url: string): Promise<IdpMetadata>
  verify(
    connection: Connection,
    input: { samlResponse: string; inResponseTo: string | null },
  ): Promise<SamlVerified>
}

export interface SamlEngineDeps {
  store: Pick<IdentityStore, "connectionSecrets">
  saml: SamlStore
  /** `guardedFetch(...)`. Never the global fetch. */
  fetch: OidcFetch
  replay: ReplayCache
  /**
   * Re-reads a connection's metadata after a signature failed (saml-refresh.ts
   * `forceRefresh`). Null: nothing new to try. Absent: never refreshes.
   */
  forceRefresh?: (
    connection: Connection,
    before: SamlCertificateRow[],
  ) => Promise<ForcedRefresh | null>
  /** apps/auth's origin: every URL we give an IdP is on it. */
  authOrigin: string
  log: Logger
  now?: () => Date
}

/** New certificates for a response that failed, and the way to report how the retry went. */
export interface ForcedRefresh {
  certificates: SamlCertificateRow[]
  settle(retrySucceeded: boolean): Promise<void>
}

export function samlEngine(deps: SamlEngineDeps): SamlEngine {
  const now = () => (deps.now ?? (() => new Date()))()
  const endpoints = (id: string) => samlEndpoints(deps.authOrigin, id)

  async function keys(connection: Connection): Promise<KeyObject[]> {
    const sealed = sealedSaml(
      await deps.store.connectionSecrets(connection.tenantId, connection.id),
    )
    return (sealed.spKeys ?? []).map(privateKeyOf)
  }

  return {
    protocol: "saml",
    pkce: false,
    endpoints,

    async begin(connection, attempt) {
      const settings = samlSettings(connection)
      if (!settings) throw new SamlMisconfigured("The connection is not configured.")
      const id = newRequestId()
      const at = endpoints(connection.id)
      const xml = authnRequest({
        id,
        now: now(),
        destination: settings.ssoUrl,
        acsUrl: at.acsUrl,
        spEntityId: at.entityId,
        nameIdFormat: settings.nameIdFormat,
        forceAuthn: attempt.purpose === "step_up" || attempt.forceLogin === true,
        // ⚠ NOT TO ENTRA IN THE XML: it answers an AuthnRequest that carries a Subject
        // with an error instead of ignoring it. Entra accepts login_hint on the SSO URL instead.
        ...(attempt.loginHint && connection.provider !== "entra"
          ? { subjectNameId: attempt.loginHint }
          : {}),
      })
      let key: KeyObject | null = null
      if (settings.signRequests) {
        key = (await keys(connection))[0] ?? null
        if (!key)
          throw new SamlMisconfigured("Signed requests need the connection's SP key.")
      }
      let ssoUrl = settings.ssoUrl
      if (attempt.loginHint && connection.provider === "entra") {
        try {
          const u = new URL(ssoUrl)
          u.searchParams.set("login_hint", attempt.loginHint)
          ssoUrl = u.toString()
        } catch {
          const sep = ssoUrl.includes("?") ? "&" : "?"
          ssoUrl = `${ssoUrl}${sep}login_hint=${encodeURIComponent(attempt.loginHint)}`
        }
      }
      return {
        redirectUrl: redirectUrl(ssoUrl, "SAMLRequest", xml, attempt.state, key),
        requestId: id,
      }
    },

    metadata(connection) {
      const at = endpoints(connection.id)
      const settings = samlSettings(connection)
      const stored = storedSaml(connection)
      const preset = samlPresetOf(connection.provider)
      return spMetadata({
        entityId: at.entityId,
        acsUrl: at.acsUrl,
        sloUrl: at.sloUrl,
        nameIdFormat:
          settings?.nameIdFormat ?? preset?.nameIdFormat ?? NAMEID.persistent,
        certificates: stored.spCertificates ?? [],
        signsRequests: settings?.signRequests === true,
      })
    },

    fetchMetadata: (url) => fetchIdpMetadata(deps.fetch, url),

    async verify(connection, input) {
      const settings = samlSettings(connection)
      if (!settings) throw new SamlMisconfigured("The connection is not configured.")
      const at = endpoints(connection.id)
      const certificates = await deps.saml.certificates(
        connection.tenantId,
        connection.id,
      )
      const decryptionKeys = await keys(connection)
      const t = now()
      const run = (certs: SamlCertificateRow[]) =>
        verifySamlResponse(input.samlResponse, {
          idpEntityId: settings.idpEntityId,
          spEntityId: at.entityId,
          acsUrl: at.acsUrl,
          certificates: certs,
          decryptionKeys,
          requireEncryption: settings.requireEncryption,
          inResponseTo: input.inResponseTo,
          now: t,
        })
      let verdict = run(certificates)
      /*
       * ⚠ A ROTATED IdP CERTIFICATE: only a failed SIGNATURE earns one fresh
       * read of the metadata URL, then the SAME response is checked again
       * against the new list. Everything else (audience, destination, times,
       * replay) is asked as before, and the replay cache is still asked only
       * below, for what verified, so the retry cannot be refused as a replay
       * of itself and cannot be accepted twice.
       */
      if (
        !verdict.ok &&
        (verdict.failure === "bad_signature" ||
          verdict.failure === "no_usable_certificate") &&
        deps.forceRefresh
      ) {
        const forced = await deps.forceRefresh(connection, certificates)
        if (forced) {
          verdict = run(forced.certificates)
          await forced.settle(verdict.ok)
        }
      }
      if (!verdict.ok) {
        // ⚠ THE IdP SAID NO (a non-Success status) is its answer, not a forgery.
        if (verdict.failure === "status")
          return {
            ok: false,
            reason: "idp_error",
            extra: { status: verdict.status ?? "unknown" },
          }
        return {
          ok: false,
          reason: "invalid_response",
          extra: { failure: verdict.failure },
        }
      }
      const verified = verdict.assertion
      const assertion = toSamlAssertion(verified, connection, settings)
      if (!assertion)
        return {
          ok: false,
          reason: "invalid_response",
          extra: { failure: "bad_subject" },
        }
      /*
       * ⚠ THE REPLAY CACHE IS ASKED LAST, ONLY FOR WHAT VERIFIED. Keyed by the
       * connection and the assertion's ID, kept until the assertion could no
       * longer be presented. Redis down throws ReplayUnavailable: a 503.
       */
      const key = `sso:saml:assertion:${connection.id}:${createHash("sha256").update(verified.id).digest("hex")}`
      const ttl = Math.min(
        REPLAY_MAX_MS,
        Math.max(60_000, verified.validUntil.getTime() - t.getTime()),
      )
      if (!(await deps.replay.claim(key, ttl)))
        return { ok: false, reason: "invalid_response", extra: { failure: "replayed" } }
      return { ok: true, verified, assertion }
    },
  }
}

// ── Assertions ───────────────────────────────────────────────────────────

const SHORT_FORMAT: Record<string, string> = {
  [NAMEID.persistent]: "persistent",
  [NAMEID.email]: "email",
  [NAMEID.unspecified]: "unspecified",
}

/**
 * The subject a SAML identity is linked by: the NameID with its format, or
 * the connection's subject attribute.
 *
 * ⚠ THE FORMAT IS PART OF IT. `persistent:abc` and `email:abc` are different
 * people; an IdP switching its NameID format breaks the link (the person is
 * refused, then claimed again by verified address) rather than silently
 * matching something else.
 */
export function subjectOf(
  verified: Pick<VerifiedAssertion, "nameId" | "nameIdFormat" | "attributes">,
  subjectAttribute: string | null,
): string | null {
  if (subjectAttribute) {
    const values = verified.attributes[subjectAttribute] ?? []
    const value = values.length === 1 ? values[0]!.trim() : ""
    return value && value.length <= 240 ? `attribute:${value}` : null
  }
  const short = SHORT_FORMAT[verified.nameIdFormat]
  return short ? `${short}:${verified.nameId}` : null
}

/** A subject back into the NameID an SP-initiated LogoutRequest must name. */
export function nameIdOfSubject(
  subject: string,
): { nameId: string; format: string } | null {
  const at = subject.indexOf(":")
  const kind = subject.slice(0, at)
  const value = subject.slice(at + 1)
  const format = Object.entries(SHORT_FORMAT).find(([, s]) => s === kind)?.[0]
  return at > 0 && format && value ? { nameId: value, format } : null
}

/** The first attribute among the mapping's and the preset's names that has a value. */
function firstOf(
  verified: VerifiedAssertion,
  mapping: Record<string, string>,
  field: "email" | "givenName" | "familyName" | "groups",
  defaults: readonly string[],
): string[] {
  const mapped = Object.entries(mapping)
    .filter(([, ours]) => ours === field)
    .map(([name]) => name)
  for (const name of mapped.length ? mapped : defaults) {
    const values = verified.attributes[name]
    if (values && values.length) return values
  }
  return []
}

/** The attribute Entra puts the user principal name in (its `name` claim). */
export const ENTRA_UPN_ATTRIBUTE =
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name"

/** Entra's SAML group overage attribute past 150 groups (sso.md 2.15). */
export const SAML_GROUPS_OVERAGE_ATTRIBUTE =
  "http://schemas.microsoft.com/claims/groups.link"

/**
 * Whether the SAML assertion carried the person's groups (P0 #3, sso.md 2.15).
 *
 *   - `overage`: Entra omits the groups attribute past 150 groups and sends
 *     `http://schemas.microsoft.com/claims/groups.link` pointing at Microsoft
 *     Graph instead.
 *   - `present`: a mapped or default groups attribute was present in the
 *     assertion (even with zero `<AttributeValue>` children: an explicit empty
 *     list).
 *   - `absent`: no groups attribute arrived at all (Google SAML with no group
 *     mapping, or an Okta filter that matched no group).
 *
 * ⚠ WE DO NOT CALL MICROSOFT GRAPH TO RESOLVE `groups.link`: we hold no Graph
 * credentials for the customer's tenant. An optional Graph app permission per
 * Entra connection is the future option; until then the role is kept and the
 * sign-in is audited.
 */
export function samlGroupsStateOf(
  attributes: Record<string, string[]>,
  mapping: Record<string, string>,
  defaults: readonly string[],
): GroupsState {
  if (Object.hasOwn(attributes, SAML_GROUPS_OVERAGE_ATTRIBUTE)) return "overage"
  const mapped = Object.entries(mapping)
    .filter(([, ours]) => ours === "groups")
    .map(([name]) => name)
  const candidates = mapped.length ? mapped : defaults
  return candidates.some((name) => Object.hasOwn(attributes, name))
    ? "present"
    : "absent"
}

function samlAmrProvesMfa(
  attributes: Record<string, string[]>,
  amr: NonNullable<SamlPreset["amr"]>,
): boolean {
  const raw = [
    ...(attributes[amr.attribute] ?? []),
    ...(amr.attribute === "amr" ? (attributes["session.amr"] ?? []) : []),
  ]
  for (const value of raw) {
    if (amr.mfa.includes(value)) return true
    const tokens = value
      .replace(/^\[|\]$/g, "")
      .split(/[\s,]+/)
      .map((t) => t.replace(/^["']|["']$/g, "").toLowerCase())
      .filter(Boolean)
    if (tokens.some((t) => amr.mfa.includes(t))) return true
  }
  return false
}

/**
 * A verified assertion as the bridge's `Assertion`, or null without a subject.
 *
 * ⚠ `emailVerified` IS TRUE BY POLICY WHEN THE ASSERTION CARRIES AN ADDRESS.
 * SAML has no `email_verified`; the connection is pinned to one IdP entity
 * whose admins run the directory for the domains this workspace proved, and
 * the bridge still claims an account only on those live domains. The address
 * is a hint for claiming; the subject above is the identity.
 */
export function toSamlAssertion(
  verified: VerifiedAssertion,
  connection: Pick<Connection, "attributeMapping"> &
    Partial<Pick<Connection, "provider" | "upnAsEmail">>,
  settings: Pick<SamlSettings, "preset" | "subjectAttribute" | "mfaContextClasses">,
): Assertion | null {
  const subject = subjectOf(verified, settings.subjectAttribute)
  if (!subject) return null
  const mapping = connection.attributeMapping
  const preset = settings.preset
  const [mailAttribute] = firstOf(verified, mapping, "email", preset.attributes.email)
  const claimed = normaliseEmail(mailAttribute) ?? normaliseEmail(verified.nameId)
  /*
   * ⚠ ENTRA SENDS NO `emailaddress` ATTRIBUTE FOR A MEMBER WHOSE `mail` IS
   * EMPTY, only `name`, the UPN. On an Entra connection that opted in
   * (`upnAsEmail`) it stands in, and only when no email came at all. It is not
   * marked verified here: the bridge accepts it only on a proved domain.
   */
  const upn =
    claimed === null && connection.provider === "entra" && connection.upnAsEmail
      ? upnAsAddress(verified.attributes[ENTRA_UPN_ATTRIBUTE]?.[0])
      : null
  const email = claimed ?? upn
  const one = (values: string[]) =>
    values[0] && values[0].length <= 256 ? values[0] : null
  const amr =
    preset.amr && samlAmrProvesMfa(verified.attributes, preset.amr) ? ["mfa"] : []
  const groupsState = samlGroupsStateOf(
    verified.attributes,
    mapping,
    preset.attributes.groups,
  )
  const attributes: Record<string, unknown> = {}
  for (const [name, values] of Object.entries(verified.attributes).slice(0, 50))
    attributes[name] = values.length === 1 ? values[0] : values.slice(0, 50)
  return {
    subject,
    email,
    emailVerified: claimed !== null,
    ...(upn ? { emailSource: "upn" as const } : {}),
    givenName: one(
      firstOf(verified, mapping, "givenName", preset.attributes.givenName),
    ),
    familyName: one(
      firstOf(verified, mapping, "familyName", preset.attributes.familyName),
    ),
    groups: firstOf(verified, mapping, "groups", preset.attributes.groups)
      .filter((g) => g.length <= 256)
      .slice(0, 500),
    groupsState,
    attributes,
    authTime: verified.authnInstant,
    amr,
    acr: verified.authnContextClassRef,
    mfaByAcr:
      verified.authnContextClassRef !== null &&
      settings.mfaContextClasses.includes(verified.authnContextClassRef),
    idpSession: verified.sessionIndex,
  }
}

// ── The ACS ──────────────────────────────────────────────────────────────

export type SamlAcsOutcome =
  | (CompleteOutcome & { unsolicited?: boolean; confirmAs?: string | null })
  | { outcome: "unavailable" }

const outage = (error: unknown) =>
  error instanceof IdpUnreachable ||
  error instanceof SamlMisconfigured ||
  error instanceof ReplayUnavailable

/**
 * `POST /sso/saml/acs`: from the IdP's POST to `completeLogin`.
 *
 * SP-initiated (RelayState names an attempt):
 *
 *   ⚠ THE BROWSER BINDING IS CHECKED BEFORE A BYTE OF XML IS LOOKED AT, as
 *   for OIDC. The binding arrives in its own `SameSite=None` cookie
 *   (`__Host-i10_sso_saml`, apps/auth), because a SAML POST is cross-site
 *   and the Lax binding cookie is not sent on it; see sso.md 2.16.
 *
 * IdP-initiated (no attempt), ONLY when the connection opts in, and then:
 *
 *   - the response must answer no request (no InResponseTo anywhere) and be
 *     issued within UNSOLICITED_MAX_AGE_MS;
 *   - the same signature, audience, recipient, replay and time checks;
 *   - only a plain sign-in: never a step-up and never a test run;
 *   - never a return path from the IdP's RelayState (it goes nowhere);
 *   - an attempt is made here, bound to a binding apps/auth just drew for
 *     this browser, so the rest of the bridge (handoff, ticket, bind) is the
 *     usual one;
 *   - and apps/auth makes the person confirm "continue as <address>" before
 *     the code is swapped, because nothing proves THIS browser asked: a
 *     colleague's own valid assertion, auto-posted from another site, would
 *     otherwise sign this browser in as them (login CSRF), the risk every
 *     IdP-initiated SP accepts.
 *
 * ⚠ AN OUTAGE DOES NOT SPEND THE ATTEMPT: 503, audited, the attempt left to
 * expire.
 */
export async function finishSaml(
  d: BridgeDeps,
  engine: SamlEngine,
  input: {
    connectionId: string
    samlResponse: string
    relayState: string | null
    /** From `__Host-i10_sso_saml`; null when the browser sent none. */
    binding: string | null
    /** A binding apps/auth drew for this browser, used only when unsolicited. */
    freshBinding: string
  },
): Promise<SamlAcsOutcome> {
  const now = (d.now ?? (() => new Date()))()
  const state = readSecret(input.relayState)
  const attempt = state ? await attemptForCallback(d, state) : null

  if (attempt && state) {
    const binding = input.binding ?? ""
    const base = { state, binding }
    const early = precheckAttempt(attempt, binding, now)
    if (early) return refuseLogin(d, { ...base, reason: early })
    if (attempt.connectionId !== input.connectionId)
      return refuseLogin(d, {
        ...base,
        reason: "engine_mismatch",
        extra: { failure: "acs" },
      })
    const connection = await d.store.connection(attempt.tenantId, attempt.connectionId)
    const usable =
      connection &&
      (attempt.purpose === "test_run"
        ? connection.status === "testing" || connection.status === "active"
        : connection.status === "active")
    if (!connection || !usable)
      return refuseLogin(d, { ...base, reason: "connection_inactive" })
    if (connection.protocol !== "saml")
      return refuseLogin(d, { ...base, reason: "engine_mismatch" })
    if (!attempt.requestId)
      return refuseLogin(d, {
        ...base,
        reason: "invalid_response",
        extra: { failure: "no_request" },
      })
    let verified: SamlVerified
    try {
      verified = await engine.verify(connection, {
        samlResponse: input.samlResponse,
        inResponseTo: attempt.requestId,
      })
    } catch (error) {
      if (!outage(error)) throw error
      return unavailable(d, attempt.tenantId, connection.id, error, attempt.id)
    }
    if (!verified.ok)
      return refuseLogin(d, {
        ...base,
        reason: verified.reason,
        extra: { ...verified.extra, provider: connection.provider, protocol: "saml" },
      })
    return completeLogin(d, {
      ...base,
      assertion: verified.assertion,
      protocol: "saml",
    })
  }

  // ── Unsolicited ──
  const connection = await d.store.connectionForStart(input.connectionId)
  if (!connection || connection.protocol !== "saml" || connection.status !== "active")
    return { outcome: "refused", reason: "connection_inactive" }
  const settings = samlSettings(connection)
  const refuse = async (reason: Refusal, extra: Record<string, unknown>) => {
    await d.store.record(connection.tenantId, {
      type: "sign_in.failed",
      connectionId: connection.id,
      reason,
      data: { unsolicited: true, ...extra },
    })
    return { outcome: "refused" as const, reason }
  }
  if (!settings?.idpInitiated)
    return refuse("invalid_response", {
      failure: state ? "attempt_unknown" : "unsolicited_off",
    })
  let verified: SamlVerified
  try {
    verified = await engine.verify(connection, {
      samlResponse: input.samlResponse,
      inResponseTo: null,
    })
  } catch (error) {
    if (!outage(error)) throw error
    return unavailable(d, connection.tenantId, connection.id, error, null)
  }
  if (!verified.ok) return refuse(verified.reason, verified.extra)

  const fresh = newSecret()
  const { id } = await d.store.createAttempt({
    tenantId: connection.tenantId,
    connectionId: connection.id,
    purpose: "sign_in",
    stateHash: hashSecret(fresh),
    bindingHash: hashSecret(input.freshBinding),
    expiresAt: new Date(now.getTime() + ATTEMPT_TTL_MS),
  })
  await d.store.record(connection.tenantId, {
    type: "sign_in.unsolicited",
    connectionId: connection.id,
    data: { attemptId: id },
  })
  const done = await completeLogin(d, {
    state: fresh,
    binding: input.freshBinding,
    assertion: verified.assertion,
    protocol: "saml",
  })
  return done.outcome === "signed_in"
    ? { ...done, unsolicited: true, confirmAs: verified.assertion.email }
    : done
}

async function unavailable(
  d: Pick<BridgeDeps, "store" | "log">,
  tenantId: string,
  connectionId: string,
  error: unknown,
  attemptId: string | null,
): Promise<{ outcome: "unavailable" }> {
  const kind =
    error instanceof IdpUnreachable
      ? error.kind
      : error instanceof ReplayUnavailable
        ? "replay_cache"
        : "misconfigured"
  d.log.warn({ connectionId, kind }, "a SAML sign-in could not be finished")
  await d.store.record(tenantId, {
    type: "sign_in.idp_unavailable",
    connectionId,
    reason: kind,
    data: { attemptId },
  })
  return { outcome: "unavailable" }
}

// ── Single logout ────────────────────────────────────────────────────────

export interface SloDeps {
  store: IdentityStore
  saml: SamlStore
  clerk: Pick<ClerkIdentity, "revokeSession">
  replay: ReplayCache
  /** The gate's cache, so a revoked session is refused at once. */
  forget(input: { userId?: string; sessionId?: string }): void
  log: Logger
  now?: () => Date
}

export type SloOutcome =
  | { outcome: "logged_out"; revoked: number; redirectUrl: string | null }
  | { outcome: "done" }
  | { outcome: "refused"; failure: string }
  | { outcome: "unavailable" }

/**
 * An IdP's logout message at `/sso/saml/slo/<id>` (sso.md 2.5).
 *
 * ⚠ A LogoutRequest ENDS ONLY WHAT IT NAMES, AND ONLY WHEN SIGNED. The
 * subject on this connection, narrowed to the SessionIndexes it lists (each
 * bound session keeps its SessionIndex as `idp_session`); all of that
 * subject's sessions here when it lists none. Clerk first, then our row,
 * then the gate's cache. A LogoutResponse changes nothing: our side ended
 * before we sent the request.
 */
export async function finishSlo(
  d: SloDeps,
  engine: SamlEngine,
  input:
    | { connectionId: string; binding: "redirect"; rawQuery: string }
    | {
        connectionId: string
        binding: "post"
        parameter: "SAMLRequest" | "SAMLResponse"
        message: string
        relayState: string | null
      },
): Promise<SloOutcome> {
  const now = (d.now ?? (() => new Date()))()
  const connection = await d.store.connectionForStart(input.connectionId)
  if (!connection || connection.protocol !== "saml")
    return { outcome: "refused", failure: "unknown_connection" }
  const settings = samlSettings(connection)
  if (!settings) return { outcome: "refused", failure: "not_configured" }
  const at = engine.endpoints(connection.id)
  const certificates = await d.saml.certificates(connection.tenantId, connection.id)
  const expect = {
    idpEntityId: settings.idpEntityId,
    sloUrl: at.sloUrl,
    certificates,
    now,
  }
  const read: SloRead =
    input.binding === "redirect"
      ? readRedirectLogout(input.rawQuery, expect)
      : readPostLogout(input.parameter, input.message, expect)
  if (!read.ok) {
    await d.store.record(connection.tenantId, {
      type: "logout.failed",
      connectionId: connection.id,
      reason: read.failure,
    })
    return { outcome: "refused", failure: read.failure }
  }
  if (read.kind === "response") return { outcome: "done" }

  const logout = read.logout
  const key = `sso:saml:logout:${connection.id}:${createHash("sha256").update(logout.id).digest("hex")}`
  try {
    if (!(await d.replay.claim(key, 10 * 60 * 1000))) {
      await d.store.record(connection.tenantId, {
        type: "logout.failed",
        connectionId: connection.id,
        reason: "replayed",
      })
      return { outcome: "refused", failure: "replayed" }
    }
  } catch (error) {
    if (error instanceof ReplayUnavailable) return { outcome: "unavailable" }
    throw error
  }

  const short = SHORT_FORMAT[logout.nameIdFormat]
  const subject = settings.subjectAttribute
    ? null
    : short
      ? `${short}:${logout.nameId}`
      : null
  /*
   * ⚠ WITH A SUBJECT ATTRIBUTE, THE NameID DOES NOT NAME THE LINK, so only the
   * SessionIndexes can: a request without any ends nothing rather than guess.
   */
  let revoked = 0
  try {
    const sessions =
      subject || logout.sessionIndexes.length
        ? await d.saml.sessionsForLogout(connection.tenantId, connection.id, {
            subject,
            sessionIndexes: logout.sessionIndexes,
          })
        : []
    for (const session of sessions) {
      await d.clerk.revokeSession(session.sessionId)
      if (
        await d.store.revokeSessionRow(
          connection.tenantId,
          session.sessionId,
          "idp_logout",
          now,
        )
      ) {
        revoked++
        await d.store.record(connection.tenantId, {
          type: "session.revoked",
          subjectUserId: session.clerkUserId,
          sessionId: session.sessionId,
          connectionId: connection.id,
          reason: "idp_logout",
        })
      }
      d.forget({ userId: session.clerkUserId, sessionId: session.sessionId })
    }
    await d.store.record(connection.tenantId, {
      type: "logout.idp",
      connectionId: connection.id,
      data: { revoked, sessionIndexes: logout.sessionIndexes.length },
    })
  } catch (error) {
    // Revoking again is harmless, so the IdP's retry must be allowed in.
    await d.replay
      .release(key)
      .catch(() =>
        d.log.warn(
          { connectionId: connection.id },
          "could not release a logout request",
        ),
      )
    throw error
  }

  const answerTo = settings.sloResponseUrl ?? settings.sloUrl
  let redirect: string | null = null
  if (answerTo) {
    const key = await spSigningKey(d.store, connection)
    redirect = redirectUrl(
      answerTo,
      "SAMLResponse",
      logoutResponse({
        id: newRequestId(),
        now,
        destination: answerTo,
        spEntityId: at.entityId,
        inResponseTo: logout.id,
        success: true,
      }),
      input.binding === "post" ? input.relayState : relayStateOf(input.rawQuery),
      key,
    )
  }
  return { outcome: "logged_out", revoked, redirectUrl: redirect }
}

function relayStateOf(rawQuery: string): string | null {
  for (const part of rawQuery.replace(/^\?/, "").split("&"))
    if (part.startsWith("RelayState=")) {
      try {
        const value = decodeURIComponent(part.slice(11).replace(/\+/g, "%20"))
        return value.length <= 80 ? value : null
      } catch {
        return null
      }
    }
  return null
}

async function spSigningKey(
  store: Pick<IdentityStore, "connectionSecrets">,
  connection: Connection,
): Promise<KeyObject | null> {
  const sealed = sealedSaml(
    await store.connectionSecrets(connection.tenantId, connection.id),
  )
  const first = sealed.spKeys?.[0]
  return first ? privateKeyOf(first) : null
}

/**
 * SP-initiated logout (sso.md 2.5): the person signs out of i10, we end the
 * session here and at Clerk, then send the browser to the IdP with a
 * LogoutRequest so its session ends too.
 *
 * ⚠ OURS ENDS FIRST, WHATEVER THE IdP DOES. The IdP may be down, refuse, or
 * never answer; the i10 session is already gone by then.
 */
export async function startLogout(
  d: SloDeps,
  engine: SamlEngine,
  input: { tenantId: string; userId: string; sessionId: string },
): Promise<
  | { outcome: "redirect"; redirectUrl: string }
  | { outcome: "done" }
  | { outcome: "not_saml" }
> {
  const now = (d.now ?? (() => new Date()))()
  const session = await d.saml.boundSession(input.tenantId, input.sessionId)
  if (!session || session.clerkUserId !== input.userId) return { outcome: "not_saml" }
  const connection = await d.store.connection(input.tenantId, session.connectionId)
  if (!connection || connection.protocol !== "saml") return { outcome: "not_saml" }

  await d.clerk.revokeSession(input.sessionId)
  if (
    await d.store.revokeSessionRow(input.tenantId, input.sessionId, "signed_out", now)
  )
    await d.store.record(input.tenantId, {
      type: "session.revoked",
      subjectUserId: input.userId,
      sessionId: input.sessionId,
      connectionId: connection.id,
      reason: "signed_out",
    })
  d.forget({ userId: input.userId, sessionId: input.sessionId })

  const settings = samlSettings(connection)
  const name = session.subject ? nameIdOfSubject(session.subject) : null
  if (!settings?.sloUrl || !name) return { outcome: "done" }
  const at = engine.endpoints(connection.id)
  return {
    outcome: "redirect",
    redirectUrl: redirectUrl(
      settings.sloUrl,
      "SAMLRequest",
      logoutRequest({
        id: newRequestId(),
        now,
        destination: settings.sloUrl,
        spEntityId: at.entityId,
        nameId: name.nameId,
        nameIdFormat: name.format,
        sessionIndex: session.idpSession,
      }),
      null,
      await spSigningKey(d.store, connection),
    ),
  }
}
