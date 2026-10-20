import { createHash, generateKeyPair, type JsonWebKey } from "node:crypto"
import { promisify } from "node:util"
import * as oidc from "openid-client"
import {
  attemptForCallback,
  completeLogin,
  precheckAttempt,
  refuseLogin,
  type BridgeDeps,
  type CompleteOutcome,
  type Engine,
} from "./bridge.js"
import type { Assertion, Connection, Refusal } from "./model.js"
import type { AttemptRow, IdentityStore, Logger } from "./ports.js"
import { IdpUnreachable, type OidcFetch } from "./oidc-fetch.js"
import {
  GOOGLE_ISSUER,
  presetOf,
  type ClientAuthMethod,
  type OidcPreset,
} from "./oidc-presets.js"

/**
 * The OIDC engine (#338, sso.md Option A): openid-client 6 doing the protocol,
 * the bridge (identity/bridge.ts) doing everything after "the IdP said this".
 *
 *   begin:   discovery (cached), then an authorization URL with PKCE S256,
 *            `state`, `nonce`, and for a step-up `prompt=login max_age=0`.
 *   verify:  the callback's `code` exchanged at the token endpoint with the
 *            attempt's verifier; RFC 9207 `iss` checked; the ID token's
 *            signature (JWKS), `iss`, `aud`, `exp` and `nonce` checked by
 *            openid-client; claims mapped to an `Assertion`.
 *
 * ⚠ EVERY REQUEST GOES THROUGH THE EGRESS GUARD (identity/oidc-fetch.ts), and
 * an IdP that cannot be reached is a 503, never a sign-in and never a "no".
 *
 * Where things live on a connection:
 *
 *   config.oidc   issuer, discoveryUrl, clientId, clientAuth, scopes,
 *                 acrValues, mfaAcrValues, clientSecretSet, keys (PUBLIC JWKs)
 *   secrets.oidc  clientSecret, privateKeys - sealed (store.ts)
 */

// ── Settings ─────────────────────────────────────────────────────────────

export interface OidcPublicKey {
  kid: string
  jwk: JsonWebKey & { kid: string }
  createdAt: string
}

/** `config.oidc` as stored. Never a secret. */
export interface StoredOidc {
  issuer?: string
  discoveryUrl?: string | null
  clientId?: string
  clientAuth?: ClientAuthMethod
  scopes?: string[]
  acrValues?: string[]
  mfaAcrValues?: string[]
  clientSecretSet?: boolean
  /** Newest first: the first signs, the second stays published for a rotation. */
  keys?: OidcPublicKey[]
}

/** `secrets.oidc` once opened. */
export interface SealedOidc {
  clientSecret?: string
  privateKeys?: { kid: string; jwk: JsonWebKey }[]
}

export interface OidcSettings {
  provider: OidcPreset
  issuer: string
  discoveryUrl: string | null
  clientId: string
  clientAuth: ClientAuthMethod
  scopes: string[]
  acrValues: string[]
  mfaAcrValues: string[]
}

export interface GoogleClient {
  clientId: string
  clientSecret: string
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []

export function storedOidc(connection: Pick<Connection, "config">): StoredOidc {
  const raw = connection.config.oidc
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as StoredOidc)
    : {}
}

export function sealedOidc(secrets: Record<string, unknown> | null): SealedOidc {
  const raw = secrets?.oidc
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as SealedOidc)
    : {}
}

/**
 * What the engine runs with, or null when the connection is not configured.
 *
 * ⚠ GOOGLE IS NOT CONFIGURED BY THE CUSTOMER AT ALL. Issuer and client are
 * ours (`GOOGLE_SSO_CLIENT_ID`); what is stored on the connection cannot point
 * a `google` connection anywhere else.
 */
export function settingsFor(
  connection: Pick<Connection, "config" | "provider">,
  google: GoogleClient | null,
): OidcSettings | null {
  const preset = presetOf(connection.provider)
  if (!preset) return null
  const stored = storedOidc(connection)
  const scopes = strings(stored.scopes)
  if (preset.id === "google") {
    if (!google) return null
    return {
      provider: preset,
      issuer: GOOGLE_ISSUER,
      discoveryUrl: null,
      clientId: google.clientId,
      clientAuth: "client_secret_basic",
      scopes: [...preset.scopes],
      acrValues: [],
      mfaAcrValues: [],
    }
  }
  if (!stored.issuer || !stored.clientId || !stored.clientAuth) return null
  return {
    provider: preset,
    issuer: stored.issuer,
    discoveryUrl: stored.discoveryUrl ?? null,
    clientId: stored.clientId,
    clientAuth: stored.clientAuth,
    scopes: scopes.length ? scopes : [...preset.scopes],
    acrValues: strings(stored.acrValues),
    mfaAcrValues: strings(stored.mfaAcrValues),
  }
}

/**
 * Whether the connection could sign somebody in: settings and the credential
 * its method needs. A `google` connection needs only our Google client.
 */
export function oidcReady(
  connection: Pick<Connection, "config" | "provider">,
  google: boolean,
): boolean {
  if (connection.provider === "google") return google
  const settings = settingsFor(connection, null)
  if (!settings) return false
  const stored = storedOidc(connection)
  return settings.clientAuth === "private_key_jwt"
    ? (stored.keys?.length ?? 0) > 0
    : stored.clientSecretSet === true
}

// ── Keys for private_key_jwt ─────────────────────────────────────────────

const generate = promisify(generateKeyPair)

/** RFC 7638 thumbprint of an RSA public key. */
function thumbprint(jwk: { e?: string; kty?: string; n?: string }): string {
  return createHash("sha256")
    .update(JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n }))
    .digest("base64url")
}

/**
 * A new RS256 key pair for one connection's client assertions.
 *
 * ⚠ RS256, NOT ES256: it is the one algorithm every preset's IdP accepts for
 * private_key_jwt. The private half is only ever stored sealed.
 */
export async function newSigningKey(now: Date = new Date()): Promise<{
  publicKey: OidcPublicKey
  privateKey: { kid: string; jwk: JsonWebKey }
}> {
  const pair = await generate("rsa", { modulusLength: 2048 })
  const pub = pair.publicKey.export({ format: "jwk" })
  const kid = thumbprint(pub)
  return {
    publicKey: {
      kid,
      jwk: { kty: pub.kty, n: pub.n, e: pub.e, kid, use: "sig", alg: "RS256" },
      createdAt: now.toISOString(),
    },
    privateKey: { kid, jwk: pair.privateKey.export({ format: "jwk" }) },
  }
}

/** The JWKS an IdP fetches to check our client assertions. Public keys only. */
export function publicJwks(connection: Pick<Connection, "config">): {
  keys: OidcPublicKey["jwk"][]
} {
  return { keys: (storedOidc(connection).keys ?? []).map((k) => k.jwk) }
}

// ── Discovery ────────────────────────────────────────────────────────────

/**
 * The IdP's own metadata is not usable: the issuer it names is not the one
 * configured, an endpoint is not https, PKCE S256 is not offered. For a
 * sign-in that is a 503 like an outage (fail closed); for the console it is
 * the message.
 */
export class OidcMisconfigured extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OidcMisconfigured"
  }
}

export function wellKnown(issuer: string): string {
  return `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`
}

const httpsUrl = (value: unknown): value is string => {
  if (typeof value !== "string") return false
  try {
    return new URL(value).protocol === "https:"
  } catch {
    return false
  }
}

/**
 * ⚠ ASYMMETRIC SIGNATURES ONLY. `none` and the HS family are dropped from what
 * the IdP says it signs with, whatever it says: an HS256 ID token is signed
 * with the client secret, which the IdP's admins and we both hold.
 */
const ASYMMETRIC = new Set([
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
  "Ed25519",
])

const DISCOVERY_TTL_MS = 10 * 60 * 1000
const CACHE_LIMIT = 1000

function remember<V>(cache: Map<string, V>, key: string, value: V) {
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!)
  cache.set(key, value)
}

// ── The engine ───────────────────────────────────────────────────────────

export interface CallbackQuery {
  code: string | null
  iss: string | null
  error: string | null
}

export type Verified =
  | { ok: true; assertion: Assertion }
  | { ok: false; reason: Refusal; extra: Record<string, unknown> }

export interface OidcEngine extends Engine {
  protocol: "oidc"
  /** Whether our Google client is configured, so the `google` preset exists. */
  google: boolean
  /** The redirect URI every customer IdP is given: apps/auth's `/sso/callback`. */
  redirectUri: string
  /**
   * Where a Google connection's callback lands: `/sso/callback/google`, the
   * only redirect URI registered on OUR Google client.
   *
   * ⚠ A SEPARATE ONE ON PURPOSE (OAuth mix-up, RFC 9700 4.4). Our Google
   * client is shared by every workspace; were its callback the same URL as a
   * customer IdP's, a hostile IdP on one workspace could send a person through
   * Google with our client and have their Google code delivered to a callback
   * it then exchanges at its own token endpoint. A Google code can only arrive
   * at this URL, and `finishOidc` refuses a callback that arrived at the wrong
   * one for its connection.
   */
  googleRedirectUri: string
  /** Discovery through the guard and the cache, for the console's check. */
  discover(input: {
    issuer: string
    discoveryUrl: string | null
  }): Promise<oidc.ServerMetadata>
  verify(
    connection: Connection,
    attempt: AttemptRow,
    state: string,
    query: CallbackQuery,
  ): Promise<Verified>
}

export interface OidcEngineDeps {
  store: Pick<IdentityStore, "connectionSecrets" | "liveDomains">
  /** `guardedFetch(...)`. Never the global fetch. */
  fetch: OidcFetch
  redirectUri: string
  google: GoogleClient | null
  log: Logger
  now?: () => Date
}

export function oidcEngine(deps: OidcEngineDeps): OidcEngine {
  const discovered = new Map<string, { at: number; meta: oidc.ServerMetadata }>()
  const jwks = new Map<string, oidc.ExportedJWKSCache>()
  const now = () => (deps.now ?? (() => new Date()))().getTime()

  async function discover(input: {
    issuer: string
    discoveryUrl: string | null
  }): Promise<oidc.ServerMetadata> {
    const url = input.discoveryUrl ?? wellKnown(input.issuer)
    const key = `${url}\n${input.issuer}`
    const hit = discovered.get(key)
    if (hit && now() - hit.at < DISCOVERY_TTL_MS) return hit.meta

    const response = await deps.fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "manual",
    })
    if (response.status >= 300 && response.status < 400)
      throw new OidcMisconfigured("The discovery URL redirects; give the final URL.")
    if (!response.ok)
      throw new IdpUnreachable(`discovery answered ${response.status}`, "network")
    let doc: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(await response.text())
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error()
      doc = parsed as Record<string, unknown>
    } catch {
      throw new OidcMisconfigured("The discovery document is not JSON.")
    }
    /*
     * ⚠ THE ISSUER IS CHECKED HERE BECAUSE WE FETCH DISCOVERY OURSELVES.
     * openid-client's `discovery()` checks it too, but not when it is handed a
     * discovery URL (it says so); doing it in one place covers both forms. An
     * IdP that names another issuer would have every token it signs checked
     * against that other issuer.
     */
    if (doc.issuer !== input.issuer)
      throw new OidcMisconfigured(
        "The discovery document names a different issuer. Use the exact issuer it lists.",
      )
    for (const field of ["authorization_endpoint", "token_endpoint", "jwks_uri"])
      if (!httpsUrl(doc[field]))
        throw new OidcMisconfigured(`The discovery document has no https ${field}.`)
    const pkce = doc.code_challenge_methods_supported
    if (Array.isArray(pkce) && !pkce.includes("S256"))
      throw new OidcMisconfigured("The IdP does not offer PKCE with S256.")
    const types = doc.response_types_supported
    if (Array.isArray(types) && !types.includes("code"))
      throw new OidcMisconfigured("The IdP does not offer the authorization code flow.")
    const algs = doc.id_token_signing_alg_values_supported
    const signing = Array.isArray(algs)
      ? algs.filter((a): a is string => typeof a === "string" && ASYMMETRIC.has(a))
      : ["RS256"]
    if (signing.length === 0)
      throw new OidcMisconfigured(
        "The IdP signs ID tokens with no algorithm we accept.",
      )

    const meta = {
      ...doc,
      issuer: input.issuer,
      id_token_signing_alg_values_supported: signing,
    } as oidc.ServerMetadata
    remember(discovered, key, { at: now(), meta })
    return meta
  }

  function configure(
    meta: oidc.ServerMetadata,
    clientId: string,
    auth: oidc.ClientAuth,
  ): oidc.Configuration {
    const config = new oidc.Configuration(meta, clientId, undefined, auth)
    config[oidc.customFetch] = deps.fetch as oidc.CustomFetch
    config.timeout = 5
    /*
     * ⚠ WITHOUT THIS openid-client DOES NOT CHECK THE ID TOKEN'S SIGNATURE.
     * A token straight from the token endpoint over TLS may skip it (OIDC Core
     * 3.1.3.7), and oauth4webapi does; we do not rely on TLS to the IdP alone,
     * so the signature is checked against the IdP's JWKS every time.
     */
    oidc.enableNonRepudiationChecks(config)
    return config
  }

  async function clientAuth(
    connection: Connection,
    settings: OidcSettings,
    meta: oidc.ServerMetadata,
  ): Promise<oidc.ClientAuth> {
    if (settings.provider.id === "google") {
      if (!deps.google) throw new OidcMisconfigured("Google sign-in is not configured.")
      return oidc.ClientSecretBasic(deps.google.clientSecret)
    }
    const sealed = sealedOidc(
      await deps.store.connectionSecrets(connection.tenantId, connection.id),
    )
    if (settings.clientAuth === "private_key_jwt") {
      const key = sealed.privateKeys?.[0]
      if (!key) throw new OidcMisconfigured("No signing key is set.")
      const imported = await crypto.subtle.importKey(
        "jwk",
        key.jwk,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"],
      )
      return oidc.PrivateKeyJwt(
        { key: imported, kid: key.kid },
        settings.provider.assertionAudience === "token_endpoint" && meta.token_endpoint
          ? {
              [oidc.modifyAssertion]: (_header, payload) => {
                payload.aud = meta.token_endpoint
              },
            }
          : undefined,
      )
    }
    if (!sealed.clientSecret) throw new OidcMisconfigured("No client secret is set.")
    return settings.clientAuth === "client_secret_post"
      ? oidc.ClientSecretPost(sealed.clientSecret)
      : oidc.ClientSecretBasic(sealed.clientSecret)
  }

  const google = deps.google !== null
  const googleRedirect = `${deps.redirectUri.replace(/\/$/, "")}/google`
  const redirectFor = (settings: OidcSettings) =>
    settings.provider.id === "google" ? googleRedirect : deps.redirectUri

  return {
    protocol: "oidc",
    pkce: true,
    google,
    redirectUri: deps.redirectUri,
    googleRedirectUri: googleRedirect,
    discover,

    async begin(connection, attempt) {
      const settings = settingsFor(connection, deps.google)
      if (!settings) throw new OidcMisconfigured("The connection is not configured.")
      if (!attempt.pkceVerifier)
        throw new Error("an OIDC attempt needs a PKCE verifier")
      const meta = await discover(settings)
      const config = configure(meta, settings.clientId, oidc.None())
      const params: Record<string, string> = {
        redirect_uri: redirectFor(settings),
        response_type: "code",
        scope: settings.scopes.join(" "),
        state: attempt.state,
        nonce: attempt.nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(attempt.pkceVerifier),
        code_challenge_method: "S256",
      }
      if (settings.acrValues.length) params.acr_values = settings.acrValues.join(" ")
      /*
       * ⚠ A STEP-UP MAKES THE IdP ASK AGAIN (sso.md 2.4). `max_age=0` is not
       * also passed to openid-client as `maxAge`: it would demand `auth_time`
       * within its 30 second tolerance of the token exchange. The bridge holds
       * `auth_time` to STEP_UP_MAX_AGE_MS instead, and refuses none at all.
       */
      if (attempt.purpose === "step_up") {
        // Google documents `prompt` as none/consent/select_account only, so it
        // gets `max_age=0` alone (inferred: unverified against Google itself).
        if (settings.provider.id !== "google") params.prompt = "login"
        params.max_age = "0"
      }
      // A hint for Google's account chooser, never a check: `hd` is checked in `verify`.
      if (settings.provider.id === "google") {
        const live = await deps.store.liveDomains(connection.tenantId, connection.id)
        if (live.length === 1) params.hd = live[0]!
      }
      return { redirectUrl: oidc.buildAuthorizationUrl(config, params).href }
    },

    async verify(connection, attempt, state, query) {
      const refuse = (
        reason: Refusal,
        extra: Record<string, unknown> = {},
      ): Verified => ({
        ok: false,
        reason,
        extra,
      })
      const settings = settingsFor(connection, deps.google)
      if (!settings) throw new OidcMisconfigured("The connection is not configured.")
      if (!query.code) return refuse("invalid_response", { failure: "no_code" })
      if (!attempt.pkceVerifier || !attempt.nonce)
        return refuse("invalid_response", { failure: "attempt_incomplete" })
      const meta = await discover(settings)
      const config = configure(
        meta,
        settings.clientId,
        await clientAuth(connection, settings, meta),
      )
      const jwksKey = `${connection.id}\n${String(meta.jwks_uri)}`
      const cached = jwks.get(jwksKey)
      if (cached) oidc.setJwksCache(config, cached)

      // The callback as openid-client reads it: our redirect URI plus what the
      // IdP put on it, and nothing else.
      const current = new URL(redirectFor(settings))
      current.searchParams.set("code", query.code)
      current.searchParams.set("state", state)
      if (query.iss !== null) current.searchParams.set("iss", query.iss)

      let tokens: Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>
      try {
        tokens = await oidc.authorizationCodeGrant(config, current, {
          pkceCodeVerifier: attempt.pkceVerifier,
          expectedState: state,
          expectedNonce: attempt.nonce,
          idTokenExpected: true,
        })
      } catch (error) {
        if (isOutage(error)) throw outageOf(error)
        return refuse("invalid_response", failureOf(error))
      } finally {
        const fresh = oidc.getJwksCache(config)
        if (fresh) remember(jwks, jwksKey, fresh)
      }
      const claims = tokens.claims()
      if (!claims) return refuse("invalid_response", { failure: "no_id_token" })

      /*
       * ⚠ GOOGLE: `hd`, NEVER THE EMAIL'S DOMAIN (Google's own guidance). Any
       * Google account can carry an address on any domain; only `hd` says the
       * account belongs to that domain's Workspace. No `hd` is a consumer
       * account, refused even when the address looks right.
       */
      if (settings.provider.id === "google") {
        const hd = typeof claims.hd === "string" ? claims.hd.toLowerCase() : null
        const live = await deps.store.liveDomains(connection.tenantId, connection.id)
        if (!hd || !live.includes(hd))
          return refuse("hosted_domain", { hd, subject: claims.sub })
      }

      const assertion = toAssertion(claims, connection, settings)
      if (!assertion) return refuse("invalid_response", { failure: "bad_subject" })
      return { ok: true, assertion }
    },
  }
}

// ── Claims ───────────────────────────────────────────────────────────────

/** The claim an IdP sends for one of our fields: the mapping's, or the standard one. */
function claimFor(
  mapping: Record<string, string>,
  field: "email" | "emailVerified" | "givenName" | "familyName" | "groups",
  fallback: string,
): string {
  for (const [claim, ours] of Object.entries(mapping)) if (ours === field) return claim
  return fallback
}

/** Claims we never keep as attributes: protocol plumbing, not facts about the person. */
const PLUMBING = new Set([
  "iss",
  "aud",
  "exp",
  "iat",
  "nbf",
  "jti",
  "nonce",
  "azp",
  "at_hash",
  "c_hash",
  "s_hash",
  "sid",
  "auth_time",
  "amr",
  "acr",
])

const short = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= max ? value : null

/**
 * A verified ID token's claims as an `Assertion`, or null without a usable
 * `sub`.
 *
 * ⚠ THE SUBJECT IS ALWAYS `sub`, AND THE MAPPING CANNOT CHANGE IT. `sub` is the
 * one claim an IdP promises never to reassign; an address or a username is
 * mutable, and using one as the identifier is the "nOAuth" account takeover.
 */
export function toAssertion(
  claims: oidc.IDToken,
  connection: Pick<Connection, "attributeMapping">,
  settings: Pick<OidcSettings, "provider" | "mfaAcrValues">,
): Assertion | null {
  const subject = short(claims.sub, 255)
  if (!subject) return null
  const mapping = connection.attributeMapping
  const email = short(claims[claimFor(mapping, "email", "email")], 320)
  const verifiedClaim = claimFor(
    mapping,
    "emailVerified",
    settings.provider.emailVerifiedClaim ?? "email_verified",
  )
  const verified = claims[verifiedClaim]
  const groupsClaim = claims[claimFor(mapping, "groups", "groups")]
  const groups = (
    typeof groupsClaim === "string" ? [groupsClaim] : strings(groupsClaim)
  )
    .filter((g) => g.length <= 256)
    .slice(0, 500)
  const amr = strings(claims.amr).slice(0, 16)
  const acr = short(claims.acr, 256)
  const attributes: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(claims)) {
    if (PLUMBING.has(name) || Object.keys(attributes).length >= 50) continue
    if (typeof value === "string" && value.length <= 1024) attributes[name] = value
    else if (typeof value === "number" || typeof value === "boolean")
      attributes[name] = value
    else if (Array.isArray(value)) attributes[name] = strings(value).slice(0, 50)
  }
  return {
    subject,
    email,
    // ⚠ ONLY A REAL true. A missing claim is "not vouched for", never "yes".
    emailVerified: verified === true || verified === "true",
    givenName: short(claims[claimFor(mapping, "givenName", "given_name")], 256),
    familyName: short(claims[claimFor(mapping, "familyName", "family_name")], 256),
    attributes,
    groups,
    authTime:
      typeof claims.auth_time === "number" ? new Date(claims.auth_time * 1000) : null,
    amr,
    acr,
    mfaByAcr: acr !== null && settings.mfaAcrValues.includes(acr),
    idpSession: short(claims.sid, 256),
  }
}

// ── Failures ─────────────────────────────────────────────────────────────

function* causes(error: unknown): Generator<unknown> {
  let current: unknown = error
  for (let depth = 0; depth < 6 && current; depth += 1) {
    yield current
    current = (current as { cause?: unknown }).cause
  }
}

/**
 * Whether openid-client failed because the IdP could not be asked, rather
 * than because what it said was wrong: the guard refused or timed out, the
 * IdP answered 5xx. Those are 503s.
 */
function isOutage(error: unknown): boolean {
  for (const e of causes(error)) {
    if (e instanceof IdpUnreachable || e instanceof OidcMisconfigured) return true
    const name = (e as { name?: unknown }).name
    if (name === "TimeoutError" || name === "AbortError") return true
    const code = (e as { code?: unknown }).code
    if (code === "OAUTH_TIMEOUT" || code === "OAUTH_ABORT") return true
    const status = (e as { status?: unknown }).status
    if (typeof status === "number" && status >= 500) return true
  }
  return false
}

function outageOf(error: unknown): Error {
  for (const e of causes(error))
    if (e instanceof IdpUnreachable || e instanceof OidcMisconfigured) return e
  return new IdpUnreachable("the IdP failed", "network")
}

const CODE = /^[A-Za-z0-9_.:-]{1,80}$/

/**
 * What the audit log keeps of a verification failure: openid-client's error
 * code, the OAuth `error` the token endpoint sent, and the claim NAME that
 * failed. Never the parameters or the claims themselves - they carry the code.
 */
function failureOf(error: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const e of causes(error)) {
    const code = (e as { code?: unknown }).code
    if (out.failure === undefined && typeof code === "string" && CODE.test(code))
      out.failure = code
    const oauthError = (e as { error?: unknown }).error
    if (
      out.oauthError === undefined &&
      typeof oauthError === "string" &&
      CODE.test(oauthError)
    )
      out.oauthError = oauthError
    const claim = (e as { cause?: { claim?: unknown } }).cause?.claim
    if (out.claim === undefined && typeof claim === "string" && CODE.test(claim))
      out.claim = claim
  }
  if (out.failure === undefined) out.failure = "unverified"
  return out
}

// ── The callback ─────────────────────────────────────────────────────────

/** The query the IdP put on our redirect URI, as apps/auth forwards it. */
export function readCallbackQuery(value: unknown): CallbackQuery | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const q = value as Record<string, unknown>
  const text = (v: unknown, max: number) =>
    typeof v === "string" && v.length > 0 && v.length <= max ? v : null
  const code = text(q.code, 4096)
  const iss = text(q.iss, 512)
  const rawError = text(q.error, 256)
  // ⚠ THE IdP's `error` IS AUDITED, SO ONLY A WELL-FORMED CODE IS KEPT AS IS.
  const error = rawError
    ? /^[a-z0-9_]{1,64}$/.test(rawError)
      ? rawError
      : "invalid"
    : null
  if (!code && !error) return null
  return { code, iss, error }
}

export type OidcCallbackOutcome = CompleteOutcome | { outcome: "unavailable" }

/**
 * `POST /sso/oidc/callback`: from the IdP's redirect to `completeLogin`.
 *
 * ⚠ THE ATTEMPT IS CHECKED BEFORE THE IdP IS ASKED. A callback from another
 * browser, a replay, or an expired attempt is refused without exchanging the
 * code, so a forwarded callback URL cannot spend somebody else's login; the
 * bridge checks the same things again when it spends the attempt.
 *
 * ⚠ AN OUTAGE DOES NOT SPEND THE ATTEMPT. It is a 503 and an audit event; the
 * attempt stays as it was, and the bridge's own expiry ends it.
 */
export async function finishOidc(
  d: BridgeDeps,
  engine: OidcEngine,
  input: {
    state: string
    binding: string
    query: CallbackQuery
    /** Which redirect URI the browser came back to: `/sso/callback[/google]`. */
    via: "oidc" | "google"
  },
): Promise<OidcCallbackOutcome> {
  const now = (d.now ?? (() => new Date()))()
  const base = { state: input.state, binding: input.binding }
  const attempt = await attemptForCallback(d, input.state)
  if (!attempt) return refuseLogin(d, { ...base, reason: "attempt_unknown" })
  const early = precheckAttempt(attempt, input.binding, now)
  if (early) return refuseLogin(d, { ...base, reason: early })
  if (input.query.error)
    return refuseLogin(d, {
      ...base,
      reason: "idp_error",
      extra: { error: input.query.error },
    })

  const connection = await d.store.connection(attempt.tenantId, attempt.connectionId)
  const usable =
    connection &&
    (attempt.purpose === "test_run"
      ? connection.status === "testing" || connection.status === "active"
      : connection.status === "active")
  if (!connection || !usable)
    return refuseLogin(d, { ...base, reason: "connection_inactive" })
  if (connection.protocol !== "oidc")
    return refuseLogin(d, { ...base, reason: "engine_mismatch" })
  // ⚠ THE MIX-UP DEFENCE (see `googleRedirectUri`): a Google connection's
  // callback only at the Google URL, every other one never there.
  if ((connection.provider === "google") !== (input.via === "google"))
    return refuseLogin(d, {
      ...base,
      reason: "engine_mismatch",
      extra: { failure: "redirect_uri" },
    })

  let verified: Verified
  try {
    verified = await engine.verify(connection, attempt, input.state, input.query)
  } catch (error) {
    if (!(error instanceof IdpUnreachable || error instanceof OidcMisconfigured))
      throw error
    const kind = error instanceof IdpUnreachable ? error.kind : "misconfigured"
    d.log.warn(
      { connectionId: connection.id, kind },
      "the IdP could not be asked to finish an SSO sign-in",
    )
    await d.store.record(attempt.tenantId, {
      type: "sign_in.idp_unavailable",
      connectionId: connection.id,
      reason: kind,
      data: { attemptId: attempt.id },
    })
    return { outcome: "unavailable" }
  }
  if (!verified.ok)
    return refuseLogin(d, { ...base, reason: verified.reason, extra: verified.extra })
  return completeLogin(d, { ...base, assertion: verified.assertion, protocol: "oidc" })
}
