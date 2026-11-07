import { createHash } from "node:crypto"
import {
  createLocalJWKSet,
  decodeProtectedHeader,
  errors,
  importX509,
  jwtVerify,
  type JWTPayload,
} from "jose"
import { z } from "zod"
import { normaliseEmail, onLiveDomain, type Connection } from "./model.js"
import { OidcMisconfigured, settingsFor, type OidcEngine } from "./oidc.js"
import { IdpUnreachable, type OidcFetch } from "./oidc-fetch.js"
import {
  jwksReader,
  LOGOUT_MAX_AGE_MS,
  LOGOUT_SKEW_MS,
  LOGOUT_STATUSES,
  REPLAY_TTL_MS,
  rateLimitedAuditor,
  revokeBoundSessions,
} from "./oidc-logout.js"
import type {
  ClerkIdentity,
  IdentityStore,
  Logger,
  ReplayCache,
  SamlStore,
} from "./ports.js"
import { ReplayUnavailable, storedSaml } from "./saml.js"
import { pemOf, usableAt } from "./saml-crypto.js"

/**
 * Okta Universal Logout (#23, sso.md 2.5): Okta sends a server-to-server POST
 * to end a person's sessions across applications when an identity threat is
 * detected or an administrator ends their access.
 *
 * Spec: https://developer.okta.com/docs/guides/oin-universal-logout-overview/
 *
 * ⚠ OKTA CONNECTIONS ONLY. Entra and Google have no server-to-server equivalent.
 *
 * ⚠ AUTHENTICATED VIA A SIGNED JWT (typ: global-token-revocation+jwt) in the
 * Authorization: Bearer <JWT> header. For OIDC, signed with the key from
 * discovery's JWKS; for SAML, signed with the connection's stored IdP certificate.
 *
 * ⚠ EMAIL LOOKUP NARROWED TO LIVE DOMAINS AND EXISTING IDENTITIES: only people
 * on this connection's live domains who have an identity on this connection,
 * never a workspace-wide match.
 */

const MAX_TOKEN_LENGTH = 8192

const ALLOWED_ALGORITHMS = [
  "RS256",
  "RS384",
  "RS512",
  "ES256",
  "ES384",
  "ES512",
  "PS256",
  "PS384",
  "PS512",
] as const

const EmailSubId = z.object({
  format: z.literal("email"),
  email: z.string().min(1).max(255),
})

const IssSubSubId = z.object({
  format: z.literal("iss_sub"),
  iss: z.string().min(1).max(1024),
  sub: z.string().min(1).max(1024),
})

export const UniversalLogoutBody = z.object({
  sub_id: z.discriminatedUnion("format", [EmailSubId, IssSubSubId]),
})

export type UniversalLogoutBodyType = z.infer<typeof UniversalLogoutBody>

export type UniversalLogoutFailure =
  | "malformed"
  | "bad_signature"
  | "issuer"
  | "audience"
  | "expired"
  | "iat"
  | "replayed"
  | "typ"
  | "subject"
  | "unknown_connection"
  | "not_configured"

export type UniversalLogoutOutcome =
  | { outcome: "logged_out"; revoked: number }
  | { outcome: "bad_auth"; failure: UniversalLogoutFailure }
  | { outcome: "malformed" }
  | { outcome: "not_found" }
  | { outcome: "cannot_log_out" }
  | { outcome: "unavailable" }

export interface UniversalLogoutDeps {
  store: Pick<
    IdentityStore,
    | "connectionForStart"
    | "revokeSessionRow"
    | "record"
    | "liveDomains"
    | "identityBySubject"
    | "identityByUser"
  > & {
    identityByEmail?: (
      tenantId: string,
      connectionId: string,
      email: string,
    ) => Promise<{ id: string; clerkUserId: string; subject: string } | null>
  }
  sessions: Pick<SamlStore, "sessionsForLogout">
  samlStore?: Pick<SamlStore, "certificates">
  clerk: Pick<ClerkIdentity, "revokeSession" | "usersByEmail">
  replay: ReplayCache
  forget(input: { userId?: string; sessionId?: string }): void
  fetch?: OidcFetch
  log: Logger
  endpointUrl?: (connectionId: string) => string
  now?: () => Date
}

const text = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= max ? value : null

function cleanUrl(raw: string): string {
  try {
    const u = new URL(raw)
    return `${u.origin}${u.pathname}`
  } catch {
    return raw
  }
}

export function universalLogout(
  d: UniversalLogoutDeps,
  engine?: Pick<OidcEngine, "discover">,
) {
  const now = () => (d.now ?? (() => new Date()))()
  const keysOf = d.fetch ? jwksReader(d.fetch, () => now().getTime()) : null
  const auditFail = rateLimitedAuditor(d.store.record, () => now().getTime())

  async function fail(
    connection: Connection,
    failure: UniversalLogoutFailure,
  ): Promise<UniversalLogoutOutcome> {
    await auditFail(connection, failure)
    return { outcome: "bad_auth", failure }
  }

  return async (input: {
    connectionId: string
    authHeader?: string | null
    body: unknown
  }): Promise<UniversalLogoutOutcome> => {
    // 1. Authorization header: must be Bearer <token>
    if (!input.authHeader || !/^Bearer\s+/i.test(input.authHeader)) {
      return { outcome: "bad_auth", failure: "malformed" }
    }
    const token = input.authHeader.replace(/^Bearer\s+/i, "").trim()
    if (
      token.length > MAX_TOKEN_LENGTH ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
    ) {
      return { outcome: "bad_auth", failure: "malformed" }
    }

    // 2. Load connection. Okta connections only.
    const connection = await d.store.connectionForStart(input.connectionId)
    if (
      !connection ||
      connection.provider !== "okta" ||
      !LOGOUT_STATUSES.includes(connection.status)
    ) {
      return { outcome: "bad_auth", failure: "unknown_connection" }
    }

    // 3. Inspect JWT protected header
    let header: ReturnType<typeof decodeProtectedHeader>
    try {
      header = decodeProtectedHeader(token)
    } catch {
      return fail(connection, "malformed")
    }

    if (header.typ !== "global-token-revocation+jwt") {
      return fail(connection, "typ")
    }

    if (
      !header.alg ||
      !ALLOWED_ALGORITHMS.includes(header.alg as (typeof ALLOWED_ALGORITHMS)[number])
    ) {
      return fail(connection, "bad_signature")
    }

    // 4. Expected audience and issuer
    const allowedAudiences: string[] = []
    // ⚠ OUR OWN PUBLIC URL, NEVER THE REQUEST'S: the Host header is the caller's
    // to set, and on SAML `aud` and the certificate are all that bind the token.
    if (d.endpointUrl) allowedAudiences.push(cleanUrl(d.endpointUrl(connection.id)))
    if (allowedAudiences.length === 0) return fail(connection, "not_configured")

    let expectedIssuer: string
    let payload: JWTPayload

    if (connection.protocol === "oidc") {
      const settings = settingsFor(connection, null)
      if (!settings || !settings.issuer || !settings.clientId || !engine || !keysOf) {
        return fail(connection, "not_configured")
      }
      expectedIssuer = settings.issuer.replace(/\/+$/, "")

      try {
        const meta = await engine.discover(settings)
        const jwksUri = String(meta.jwks_uri)
        const attempt = async (refresh: boolean) =>
          jwtVerify(token, createLocalJWKSet(await keysOf(jwksUri, refresh)), {
            issuer: [expectedIssuer, `${expectedIssuer}/`],
            audience: allowedAudiences,
            algorithms: meta.id_token_signing_alg_values_supported ?? [
              ...ALLOWED_ALGORITHMS,
            ],
            clockTolerance: LOGOUT_SKEW_MS / 1000,
            currentDate: now(),
            requiredClaims: ["iat", "exp", "jti"],
          })

        try {
          payload = (await attempt(false)).payload
        } catch (error) {
          if (!(error instanceof errors.JWKSNoMatchingKey)) throw error
          payload = (await attempt(true)).payload
        }
      } catch (error) {
        if (error instanceof IdpUnreachable || error instanceof OidcMisconfigured) {
          d.log.warn(
            {
              connectionId: connection.id,
              kind: error instanceof IdpUnreachable ? error.kind : "misconfigured",
            },
            "the IdP could not be asked to verify a universal logout token",
          )
          return { outcome: "unavailable" }
        }
        if (error instanceof errors.JWTExpired) return fail(connection, "expired")
        if (error instanceof errors.JWTClaimValidationFailed) {
          if (error.claim === "iss") return fail(connection, "issuer")
          if (error.claim === "aud") return fail(connection, "audience")
          return fail(connection, error.reason === "missing" ? "malformed" : "iat")
        }
        if (!(error instanceof errors.JOSEError)) throw error
        return fail(connection, "bad_signature")
      }

      if (payload.sub !== settings.clientId) {
        return fail(connection, "subject")
      }
    } else if (connection.protocol === "saml") {
      const stored = storedSaml(connection)
      if (!stored.ssoUrl || !d.samlStore) {
        return fail(connection, "not_configured")
      }
      try {
        expectedIssuer = new URL(stored.ssoUrl).origin.replace(/\/+$/, "")
      } catch {
        return fail(connection, "not_configured")
      }

      const certs = await d.samlStore.certificates(connection.tenantId, connection.id)
      const usable = certs.filter((c) => usableAt(c, now()))
      if (usable.length === 0) {
        return fail(connection, "not_configured")
      }

      let verifiedPayload: JWTPayload | null = null
      let lastError: unknown = null

      for (const cert of usable) {
        try {
          const key = await importX509(pemOf(cert.certificate), header.alg)
          const res = await jwtVerify(token, key, {
            issuer: [expectedIssuer, `${expectedIssuer}/`],
            audience: allowedAudiences,
            algorithms: [...ALLOWED_ALGORITHMS],
            clockTolerance: LOGOUT_SKEW_MS / 1000,
            currentDate: now(),
            requiredClaims: ["iat", "exp", "jti"],
          })
          verifiedPayload = res.payload
          break
        } catch (err) {
          lastError = err
        }
      }

      if (!verifiedPayload) {
        if (lastError instanceof errors.JWTExpired) return fail(connection, "expired")
        if (lastError instanceof errors.JWTClaimValidationFailed) {
          if (lastError.claim === "iss") return fail(connection, "issuer")
          if (lastError.claim === "aud") return fail(connection, "audience")
          return fail(connection, "iat")
        }
        return fail(connection, "bad_signature")
      }

      payload = verifiedPayload
      if (typeof payload.sub !== "string" || !payload.sub) {
        return fail(connection, "subject")
      }
    } else {
      return fail(connection, "not_configured")
    }

    // 5. Check iat bounds
    const iat = payload.iat
    if (typeof iat !== "number") return fail(connection, "malformed")
    const age = now().getTime() - iat * 1000
    if (age > LOGOUT_MAX_AGE_MS || age < -LOGOUT_SKEW_MS) return fail(connection, "iat")

    // 6. A malformed body must not spend the token: validate it before the claim.
    const parsedBody = UniversalLogoutBody.safeParse(input.body)
    if (!parsedBody.success) {
      return { outcome: "malformed" }
    }

    // 7. Claim jti in replay cache
    const jti = text(payload.jti, 256)
    if (!jti) return fail(connection, "malformed")

    const claimKey = `sso:universal-logout:${connection.id}:${createHash("sha256").update(jti).digest("hex")}`
    try {
      if (!(await d.replay.claim(claimKey, REPLAY_TTL_MS))) {
        return fail(connection, "replayed")
      }
    } catch (error) {
      if (error instanceof ReplayUnavailable) return { outcome: "unavailable" }
      throw error
    }

    // 8. Resolve subject
    const subId = parsedBody.data.sub_id
    let resolvedSubject: string | null = null

    if (subId.format === "iss_sub") {
      const normSubIss = subId.iss.replace(/\/+$/, "")
      if (normSubIss !== expectedIssuer) {
        return { outcome: "not_found" }
      }
      const linked = await d.store.identityBySubject(
        connection.tenantId,
        connection.id,
        subId.sub,
      )
      if (!linked) return { outcome: "not_found" }
      resolvedSubject = subId.sub
    } else if (subId.format === "email") {
      const email = normaliseEmail(subId.email)
      if (!email) return { outcome: "malformed" }

      const live = await d.store.liveDomains(connection.tenantId, connection.id)
      if (!onLiveDomain(email, live)) {
        return { outcome: "not_found" }
      }

      const users = await d.clerk.usersByEmail(email)
      for (const user of users) {
        if (user.emails.some((e) => e.address.toLowerCase() === email)) {
          const idn = await d.store.identityByUser(
            connection.tenantId,
            connection.id,
            user.id,
          )
          if (idn) {
            resolvedSubject = idn.subject
            break
          }
        }
      }

      if (!resolvedSubject && d.store.identityByEmail) {
        const idn = await d.store.identityByEmail(
          connection.tenantId,
          connection.id,
          email,
        )
        if (idn) {
          resolvedSubject = idn.subject
        }
      }

      if (!resolvedSubject) return { outcome: "not_found" }
    }

    // 9. Revoke sessions for the resolved subject
    const at = now()
    try {
      const revoked = await revokeBoundSessions(d, {
        tenantId: connection.tenantId,
        connectionId: connection.id,
        subject: resolvedSubject,
        sessionIndexes: [],
        at,
        by: "universal_logout",
      })
      return { outcome: "logged_out", revoked }
    } catch (error) {
      await d.replay
        .release(claimKey)
        .catch(() =>
          d.log.warn(
            { connectionId: connection.id },
            "could not release a universal logout token",
          ),
        )
      d.log.error(
        { err: String(error), connectionId: connection.id },
        "could not revoke sessions for universal logout",
      )
      return { outcome: "cannot_log_out" }
    }
  }
}
