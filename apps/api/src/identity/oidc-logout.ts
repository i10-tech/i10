import { createHash } from "node:crypto"
import { createLocalJWKSet, errors, jwtVerify, type JSONWebKeySet } from "jose"
import type { Connection } from "./model.js"
import { OidcMisconfigured, settingsFor, type OidcEngine } from "./oidc.js"
import { IdpUnreachable, type OidcFetch } from "./oidc-fetch.js"
import type {
  ClerkIdentity,
  IdentityStore,
  Logger,
  ReplayCache,
  SamlStore,
} from "./ports.js"
import { ReplayUnavailable } from "./saml.js"

/**
 * OpenID Connect Back-Channel Logout 1.0 (#345, sso.md 2.5): the IdP's
 * server tells us a person's session there ended, with a signed Logout Token,
 * and we end the sessions we bound to it - the OIDC counterpart of SAML's
 * single logout (`finishSlo`, identity/saml.ts).
 *
 * The token is verified with the machinery an ID token gets: the connection's
 * issuer, its JWKS fetched through the egress guard, asymmetric algorithms
 * only (`none` and HS* are never in the list), our client id as `aud`. On top
 * of that the spec's own rules: an `events` claim naming the logout event, a
 * `sid` or a `sub` (or both), a `jti`, an `iat` that is recent, and NO
 * `nonce`, which is what tells a Logout Token from an ID token someone is
 * passing off as one.
 *
 * ⚠ A LOGOUT TOKEN ENDS ONLY WHAT IT NAMES, ON THIS CONNECTION. With a `sid`,
 * the sessions bound with that IdP session id (narrowed to the `sub` when both
 * are given); with only a `sub`, every session of that subject on this
 * connection. Never another connection's, never another workspace's.
 *
 * ⚠ CLERK FIRST, THEN OUR ROW, THEN THE GATE'S CACHE, as SLO does: the row is
 * what the gate trusts, and a row marked revoked over a live Clerk session
 * would be a session we refuse but Clerk keeps refreshing.
 *
 * ⚠ THE `jti` IS CLAIMED AFTER THE SIGNATURE, NOT BEFORE: an unauthenticated
 * caller must not be able to spend a real token's id. It is given back if the
 * revocations fail, so the IdP's retry is not refused as a replay of
 * something that never finished.
 */

export const BACKCHANNEL_EVENT = "http://schemas.openid.net/event/backchannel-logout"

/** How far ahead of our clock an IdP's `iat` and `exp` may be. */
export const LOGOUT_SKEW_MS = 2 * 60 * 1000
/** A Logout Token older than this is refused whatever its `exp` says. */
export const LOGOUT_MAX_AGE_MS = 10 * 60 * 1000
/** A `jti` is remembered for the whole time its token could still be accepted. */
const REPLAY_TTL_MS = LOGOUT_MAX_AGE_MS + 2 * LOGOUT_SKEW_MS + 60 * 1000
const JWKS_TTL_MS = 5 * 60 * 1000
/** A key id we have never seen is worth a refetch, but not more often than this. */
const JWKS_REFETCH_MS = 30 * 1000
const MAX_KEYS = 100
const MAX_TOKEN_LENGTH = 8192
const AUDIT_EVERY_MS = 60 * 1000
const CACHE_LIMIT = 1000

export type LogoutFailure =
  | "malformed"
  | "bad_signature"
  | "issuer"
  | "audience"
  | "expired"
  | "iat"
  | "events"
  | "nonce"
  | "no_subject"
  | "replayed"
  | "unknown_connection"
  | "not_configured"

export interface LogoutToken {
  sub: string | null
  sid: string | null
  jti: string
}

export type LogoutVerdict =
  { ok: true; token: LogoutToken } | { ok: false; failure: LogoutFailure }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const text = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= max ? value : null

/**
 * A Logout Token checked against one IdP's keys.
 *
 * `keys` is asked once, and a second time with `refresh` set when the token's
 * key is not in what it returned (a key rotation); it throws when the IdP
 * cannot be asked, which is the caller's 503, not a refusal.
 */
export async function verifyLogoutToken(input: {
  token: string
  issuer: string
  clientId: string
  /** The asymmetric algorithms the IdP signs with (discovery, `none` and HS* removed). */
  algorithms: readonly string[]
  keys(refresh: boolean): Promise<JSONWebKeySet>
  now: Date
}): Promise<LogoutVerdict> {
  const refuse = (failure: LogoutFailure): LogoutVerdict => ({ ok: false, failure })
  // Three base64url segments: a JWS. A JWE (five) or a stray string never reaches jose.
  if (
    input.token.length > MAX_TOKEN_LENGTH ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(input.token)
  )
    return refuse("malformed")

  const attempt = async (refresh: boolean) =>
    jwtVerify(input.token, createLocalJWKSet(await input.keys(refresh)), {
      issuer: input.issuer,
      audience: input.clientId,
      algorithms: [...input.algorithms],
      clockTolerance: LOGOUT_SKEW_MS / 1000,
      currentDate: input.now,
      requiredClaims: ["iat", "exp", "jti"],
    })

  let payload: Record<string, unknown>
  try {
    try {
      payload = (await attempt(false)).payload
    } catch (error) {
      if (!(error instanceof errors.JWKSNoMatchingKey)) throw error
      payload = (await attempt(true)).payload
    }
  } catch (error) {
    if (error instanceof IdpUnreachable || error instanceof OidcMisconfigured)
      throw error
    if (error instanceof errors.JWTExpired) return refuse("expired")
    if (error instanceof errors.JWTClaimValidationFailed) {
      if (error.claim === "iss") return refuse("issuer")
      if (error.claim === "aud") return refuse("audience")
      return refuse(error.reason === "missing" ? "malformed" : "iat")
    }
    // Not a JOSE error at all (a bug, or a runtime fault) is not a verdict: let it surface.
    if (!(error instanceof errors.JOSEError)) throw error
    if (error instanceof errors.JWSInvalid || error instanceof errors.JWTInvalid)
      return refuse("malformed")
    return refuse("bad_signature")
  }

  const iat = payload.iat
  if (typeof iat !== "number") return refuse("malformed")
  const age = input.now.getTime() - iat * 1000
  if (age > LOGOUT_MAX_AGE_MS || age < -LOGOUT_SKEW_MS) return refuse("iat")
  /*
   * ⚠ `nonce` IS REFUSED WHATEVER ITS VALUE (spec 2.4): a token that carries
   * one is an ID token, and an ID token is not a request to end a session.
   */
  if ("nonce" in payload) return refuse("nonce")
  const events = payload.events
  if (!isRecord(events) || !isRecord(events[BACKCHANNEL_EVENT])) return refuse("events")
  const jti = text(payload.jti, 256)
  if (!jti) return refuse("malformed")
  const sub = payload.sub === undefined ? null : text(payload.sub, 255)
  const sid = payload.sid === undefined ? null : text(payload.sid, 255)
  if ((payload.sub !== undefined && !sub) || (payload.sid !== undefined && !sid))
    return refuse("malformed")
  if (!sub && !sid) return refuse("no_subject")
  return { ok: true, token: { sub, sid, jti } }
}

// ── The IdP's keys ───────────────────────────────────────────────────────

/**
 * The IdP's JWKS through the egress guard, cached five minutes per URI and
 * refetched on a key id we have not seen (at most every 30 seconds).
 */
export function jwksReader(fetch: OidcFetch, now: () => number = Date.now) {
  const cache = new Map<string, { at: number; set: JSONWebKeySet }>()
  return async (uri: string, refresh: boolean): Promise<JSONWebKeySet> => {
    const hit = cache.get(uri)
    if (hit && now() - hit.at < (refresh ? JWKS_REFETCH_MS : JWKS_TTL_MS))
      return hit.set
    const response = await fetch(uri, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "manual",
    })
    if (response.status >= 300 && response.status < 400)
      throw new OidcMisconfigured("The IdP's key set URL redirects.")
    if (!response.ok)
      throw new IdpUnreachable(`jwks answered ${response.status}`, "network")
    let parsed: unknown
    try {
      parsed = JSON.parse(await response.text())
    } catch {
      throw new OidcMisconfigured("The IdP's key set is not JSON.")
    }
    const keys = isRecord(parsed) ? parsed.keys : null
    if (!Array.isArray(keys) || keys.length > MAX_KEYS)
      throw new OidcMisconfigured("The IdP's key set is not usable.")
    const set = { keys: keys.filter(isRecord) } as JSONWebKeySet
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!)
    cache.set(uri, { at: now(), set })
    return set
  }
}

// ── The endpoint ─────────────────────────────────────────────────────────

export interface BackchannelDeps {
  store: Pick<IdentityStore, "connectionForStart" | "revokeSessionRow" | "record">
  /** Protocol-neutral despite where it lives: the sessions a subject or IdP session names. */
  sessions: Pick<SamlStore, "sessionsForLogout">
  clerk: Pick<ClerkIdentity, "revokeSession">
  replay: ReplayCache
  /** The gate's cache, so a revoked session is refused at once. */
  forget(input: { userId?: string; sessionId?: string }): void
  fetch: OidcFetch
  log: Logger
  now?: () => Date
}

export type BackchannelOutcome =
  | { outcome: "logged_out"; revoked: number }
  | { outcome: "refused"; failure: LogoutFailure }
  | { outcome: "unavailable" }

/** Statuses whose bound sessions an IdP may end: an active connection and a paused one. */
const LOGOUT_STATUSES: readonly Connection["status"][] = ["active", "disabled"]

export function backchannelLogout(
  d: BackchannelDeps,
  engine: Pick<OidcEngine, "discover">,
) {
  const now = () => (d.now ?? (() => new Date()))()
  const keysOf = jwksReader(d.fetch, () => now().getTime())
  /** Failures audited recently, so an unauthenticated caller cannot fill the log. */
  const audited = new Map<string, number>()

  async function fail(
    connection: Connection,
    failure: LogoutFailure,
  ): Promise<BackchannelOutcome> {
    const key = `${connection.id}:${failure}`
    const at = now().getTime()
    const last = audited.get(key)
    if (last === undefined || at - last >= AUDIT_EVERY_MS) {
      if (audited.size >= CACHE_LIMIT) audited.delete(audited.keys().next().value!)
      audited.set(key, at)
      await d.store.record(connection.tenantId, {
        type: "logout.failed",
        connectionId: connection.id,
        reason: failure,
      })
    }
    return { outcome: "refused", failure }
  }

  return async (input: {
    connectionId: string
    logoutToken: string
  }): Promise<BackchannelOutcome> => {
    const connection = await d.store.connectionForStart(input.connectionId)
    // ⚠ NOT GOOGLE: its client is ours and shared, so a token for one
    // workspace's Google connection would verify for every other.
    if (
      !connection ||
      connection.protocol !== "oidc" ||
      connection.provider === "google" ||
      !LOGOUT_STATUSES.includes(connection.status)
    )
      return { outcome: "refused", failure: "unknown_connection" }
    const settings = settingsFor(connection, null)
    if (!settings) return fail(connection, "not_configured")

    let verdict: LogoutVerdict
    try {
      const meta = await engine.discover(settings)
      const jwksUri = String(meta.jwks_uri)
      verdict = await verifyLogoutToken({
        token: input.logoutToken,
        issuer: settings.issuer,
        clientId: settings.clientId,
        algorithms: meta.id_token_signing_alg_values_supported ?? [],
        keys: (refresh) => keysOf(jwksUri, refresh),
        now: now(),
      })
    } catch (error) {
      if (!(error instanceof IdpUnreachable || error instanceof OidcMisconfigured))
        throw error
      d.log.warn(
        {
          connectionId: connection.id,
          kind: error instanceof IdpUnreachable ? error.kind : "misconfigured",
        },
        "the IdP could not be asked to verify a back-channel logout",
      )
      return { outcome: "unavailable" }
    }
    if (!verdict.ok) return fail(connection, verdict.failure)
    const { sub, sid, jti } = verdict.token

    const claimKey = `sso:oidc:logout:${connection.id}:${createHash("sha256").update(jti).digest("hex")}`
    try {
      if (!(await d.replay.claim(claimKey, REPLAY_TTL_MS)))
        return fail(connection, "replayed")
    } catch (error) {
      if (error instanceof ReplayUnavailable) return { outcome: "unavailable" }
      throw error
    }

    const at = now()
    let revoked = 0
    try {
      const sessions = await d.sessions.sessionsForLogout(
        connection.tenantId,
        connection.id,
        { subject: sub, sessionIndexes: sid ? [sid] : [] },
      )
      for (const session of sessions) {
        await d.clerk.revokeSession(session.sessionId)
        if (
          await d.store.revokeSessionRow(
            connection.tenantId,
            session.sessionId,
            "idp_logout",
            at,
          )
        ) {
          revoked += 1
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
        data: { revoked, by: sid ? (sub ? "sid_and_sub" : "sid") : "sub" },
      })
    } catch (error) {
      // Revoking again is harmless, so the IdP's retry must be allowed in.
      await d.replay
        .release(claimKey)
        .catch(() =>
          d.log.warn(
            { connectionId: connection.id },
            "could not release a logout token",
          ),
        )
      throw error
    }
    return { outcome: "logged_out", revoked }
  }
}
