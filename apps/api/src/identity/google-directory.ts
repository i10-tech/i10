import { createPrivateKey, randomUUID, sign, type KeyObject } from "node:crypto"
import { z } from "zod"
import { safeError } from "./directory.js"
import {
  GOOGLE_WATCH_EVENTS,
  type Directory,
  type DirectoryGroupRow,
  type DirectoryStore,
  type DirectoryUserRow,
  type GoogleWatchEvent,
  type OutboxEntry,
} from "./directory-ports.js"
import { hashSecret, newSecret, normaliseEmail } from "./model.js"
import { IdpUnreachable, type OidcFetch } from "./oidc-fetch.js"
import type { AuditEvent, Logger } from "./ports.js"
import {
  LIMITS,
  readGroup,
  readUser,
  type StoredGroup,
  type StoredUser,
} from "./scim.js"

/**
 * Google Workspace directory sync (#343, sso.md 2.7 and 2.9).
 *
 * Google Workspace does not push SCIM, so i10 pulls users, groups and group
 * memberships with our own service account under domain-wide delegation and
 * writes them through `DirectoryStore` - the same user, group, outbox and
 * audit transactions `routes/scim.ts` uses. Everything downstream (the outbox,
 * `applyDirectoryUser`, conflicts, role exemption and deprovisioning) is
 * shared unchanged.
 *
 * ⚠ DELETIONS ONLY AFTER A COMPLETE PULL. Every page of users, groups and
 * group members is fetched, bounded and parsed in memory before a single store
 * write runs. Any HTTP error, timeout, egress refusal, page loop, count cap or
 * schema error aborts the run, records `lastSyncStatus = "failed"` with a
 * fixed error code, and touches no person or group.
 */

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
export const GOOGLE_DIRECTORY_API_BASE =
  "https://admin.googleapis.com/admin/directory/v1"

export const GOOGLE_DIRECTORY_SCOPES = [
  "https://www.googleapis.com/auth/admin.directory.user.readonly",
  "https://www.googleapis.com/auth/admin.directory.group.readonly",
] as const

export const GOOGLE_PAGE_SIZE = 200
export const GOOGLE_MAX_USERS = 10_000
export const GOOGLE_MAX_GROUPS = 2_000
export const GOOGLE_MAX_GROUP_MEMBERS = 10_000
export const GOOGLE_FETCH_TIMEOUT_MS = 15_000
export const GOOGLE_CHECK_TIMEOUT_MS = 5_000
export const GOOGLE_FETCH_MAX_BYTES = 4 * 1024 * 1024

/** Shrink guard: refuse a pull that removes more than both 20% and 5 live users. */
export const GOOGLE_MAX_DROP_PERCENT = 20
export const GOOGLE_MAX_DROP_USERS = 5
/** An owner's go-ahead past the shrink guard is good for this long. */
export const GOOGLE_DROP_ALLOWANCE_MS = 24 * 60 * 60_000

const MAX_GOOGLE_PAGES = 1_000

/** Refresh cached access tokens five minutes before Google expires them. */
export const TOKEN_REFRESH_SKEW_MS = 5 * 60_000
/** Google Admin SDK `users.watch` channels live at most six hours (21,600s). */
export const GOOGLE_WATCH_TTL_MS = 6 * 60 * 60_000
/** Renew a watch channel once less than forty-five minutes remain on it. */
export const GOOGLE_WATCH_RENEW_BEFORE_MS = 45 * 60_000

const DOMAIN_NAME =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/

export const GOOGLE_DIRECTORY_ERRORS = [
  "not_configured",
  "domain_not_verified",
  "unauthorized_client",
  "delegation_missing",
  "scope_missing",
  "missing_scope",
  "admin_not_found",
  "subject_not_admin",
  "unknown_customer",
  "rate_limited",
  "too_many_users",
  "too_many_groups",
  "empty_directory",
  "large_drop",
  "user_conflict",
  "invalid_response",
  "unreachable",
] as const

export type GoogleDirectoryErrorCode = (typeof GOOGLE_DIRECTORY_ERRORS)[number]

/** The part after the last `@` of an already-normalised address. */
export function emailDomain(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1)
}

export function normaliseDomain(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const trimmed = raw.trim().toLowerCase()
  return DOMAIN_NAME.test(trimmed) ? trimmed : null
}

// ── Service account credentials ─────────────────────────────────────────────

const serviceAccountSchema = z.looseObject({
  type: z.literal("service_account").default("service_account"),
  client_email: z.string().trim().min(3).max(320),
  client_id: z.string().trim().min(1).max(128).optional(),
  private_key_id: z.string().trim().min(1).max(128).optional(),
  private_key: z.string().min(32).max(32_768),
})

export interface GoogleServiceAccount {
  readonly clientEmail: string
  readonly clientId: string | null
  readonly privateKeyId: string | null
  /** Signs the JWT `<header>.<payload>` input with RS256; never exposes the PEM. */
  signAssertion(signingInput: string): string
}

/**
 * Parses `GOOGLE_DIRECTORY_SERVICE_ACCOUNT` once at boot.
 *
 * ⚠ NEVER INCLUDES THE RAW VALUE OR PRIVATE KEY IN AN ERROR. Boot errors go
 * to stderr and Sentry, so every thrown message is a fixed description of
 * which field failed.
 */
export function parseGoogleServiceAccount(raw: string): GoogleServiceAccount {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new Error("GOOGLE_DIRECTORY_SERVICE_ACCOUNT must be valid JSON.")
  }
  const parsed = serviceAccountSchema.safeParse(json)
  if (!parsed.success) {
    throw new Error(
      "GOOGLE_DIRECTORY_SERVICE_ACCOUNT must be a Google service_account JSON key with client_email and private_key.",
    )
  }
  const clientEmail = normaliseEmail(parsed.data.client_email)
  if (!clientEmail) {
    throw new Error(
      "GOOGLE_DIRECTORY_SERVICE_ACCOUNT client_email is not a valid email address.",
    )
  }
  let key: KeyObject
  try {
    key = createPrivateKey(parsed.data.private_key)
  } catch {
    throw new Error(
      "GOOGLE_DIRECTORY_SERVICE_ACCOUNT private_key is not a valid PEM private key.",
    )
  }
  if (key.asymmetricKeyType !== "rsa") {
    throw new Error(
      "GOOGLE_DIRECTORY_SERVICE_ACCOUNT private_key must be an RSA key for RS256.",
    )
  }
  const clientId = parsed.data.client_id ?? null
  const privateKeyId = parsed.data.private_key_id ?? null
  return {
    clientEmail,
    clientId,
    privateKeyId,
    signAssertion(signingInput: string) {
      return sign("RSA-SHA256", Buffer.from(signingInput, "utf8"), key).toString(
        "base64url",
      )
    },
  }
}

// ── JWT bearer grant and token cache ────────────────────────────────────────

const base64UrlJson = (value: Record<string, unknown>): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url")

/** Mints the RS256 JWT assertion sent to `https://oauth2.googleapis.com/token`. */
export function buildGoogleJwtAssertion(
  account: GoogleServiceAccount,
  adminEmail: string,
  now: Date,
  scopes: readonly string[] = GOOGLE_DIRECTORY_SCOPES,
): string {
  const iat = Math.floor(now.getTime() / 1000)
  const header: Record<string, unknown> = {
    alg: "RS256",
    typ: "JWT",
    ...(account.privateKeyId ? { kid: account.privateKeyId } : {}),
  }
  const payload = {
    iss: account.clientEmail,
    sub: adminEmail,
    scope: scopes.join(" "),
    aud: GOOGLE_TOKEN_URL,
    iat,
    exp: iat + 3600,
  }
  const input = `${base64UrlJson(header)}.${base64UrlJson(payload)}`
  return `${input}.${account.signAssertion(input)}`
}

const tokenResponseSchema = z.looseObject({
  access_token: z.string().min(1).max(4096),
  expires_in: z.number().int().positive().max(86_400),
  token_type: z.string().max(64).optional(),
})

const oauthErrorSchema = z.looseObject({
  error: z.string().max(128).optional(),
  error_description: z.string().max(1024).optional(),
})

const googleApiErrorSchema = z.looseObject({
  error: z
    .looseObject({
      code: z.number().int().optional(),
      status: z.string().max(128).optional(),
      errors: z
        .array(
          z.looseObject({
            reason: z.string().max(128).optional(),
            domain: z.string().max(128).optional(),
          }),
        )
        .max(20)
        .optional(),
      details: z
        .array(
          z.looseObject({
            reason: z.string().max(128).optional(),
          }),
        )
        .max(20)
        .optional(),
    })
    .optional(),
})

export class GoogleFailure extends Error {
  readonly missingScopes?: readonly string[]
  readonly retryAfterMs?: number

  constructor(
    readonly code: GoogleDirectoryErrorCode,
    readonly retryable: boolean,
    missingScopes?: readonly string[],
    retryAfterMs?: number,
  ) {
    super(code)
    this.name = "GoogleFailure"
    if (missingScopes && missingScopes.length > 0) {
      this.missingScopes = [...missingScopes]
    }
    if (
      typeof retryAfterMs === "number" &&
      Number.isFinite(retryAfterMs) &&
      retryAfterMs > 0
    ) {
      this.retryAfterMs = retryAfterMs
    }
  }
}

export function parseRetryAfterMs(header: string | null | undefined): number | null {
  if (!header) return null
  const trimmed = header.trim()
  if (!trimmed) return null
  const seconds = Number(trimmed)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000)
  }
  const date = Date.parse(trimmed)
  if (Number.isFinite(date)) {
    return Math.max(0, date - Date.now())
  }
  return null
}

export async function withGoogleRetry<T>(
  operation: () => Promise<T>,
  options?: {
    maxAttempts?: number
    baseDelayMs?: number
    maxDelayMs?: number
    sleep?: (ms: number) => Promise<void>
  },
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? 4
  const baseDelayMs = options?.baseDelayMs ?? 500
  const maxDelayMs = options?.maxDelayMs ?? 15_000
  const sleepFn =
    options?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))

  for (let attempt = 1; ; attempt++) {
    try {
      return await operation()
    } catch (error) {
      const isRetryable =
        (error instanceof GoogleFailure && error.retryable) ||
        error instanceof IdpUnreachable

      if (!isRetryable || attempt >= maxAttempts) {
        throw error
      }

      let delayMs: number
      if (
        error instanceof GoogleFailure &&
        typeof error.retryAfterMs === "number" &&
        error.retryAfterMs > 0
      ) {
        delayMs = Math.min(error.retryAfterMs, maxDelayMs)
      } else {
        const exp = baseDelayMs * Math.pow(2, attempt - 1)
        const jitter = Math.random() * (exp * 0.2)
        delayMs = Math.min(Math.round(exp + jitter), maxDelayMs)
      }

      await sleepFn(delayMs)
    }
  }
}

function parseOauthError(rawBody: string): { error?: string; description: string } {
  let body: unknown = null
  try {
    body = JSON.parse(rawBody)
  } catch {
    body = null
  }
  const parsed = oauthErrorSchema.safeParse(body)
  if (!parsed.success) return { description: "" }
  const err = parsed.data.error?.toLowerCase()
  return {
    ...(err !== undefined ? { error: err } : {}),
    description: parsed.data.error_description?.toLowerCase() ?? "",
  }
}

function classifyTokenFailure(
  status: number,
  rawBody: string,
  retryAfterMs?: number,
): GoogleFailure {
  if (status === 429)
    return new GoogleFailure("rate_limited", true, undefined, retryAfterMs)
  if (status >= 500)
    return new GoogleFailure("unreachable", true, undefined, retryAfterMs)
  const { error: err, description: desc } = parseOauthError(rawBody)
  if (err === "invalid_scope" || err === "access_denied")
    return new GoogleFailure("missing_scope", false)
  if (err === "unauthorized_client") {
    if (desc.includes("missing scope") || desc.includes("insufficient"))
      return new GoogleFailure("missing_scope", false)
    return new GoogleFailure("unauthorized_client", false)
  }
  if (err === "invalid_grant") {
    if (desc.includes("invalid email") || desc.includes("user id"))
      return new GoogleFailure("admin_not_found", false)
    if (desc.includes("not exist") || desc.includes("unknown"))
      return new GoogleFailure("unknown_customer", false)
    return new GoogleFailure("unauthorized_client", false)
  }
  return new GoogleFailure("unauthorized_client", false)
}

function classifyApiFailure(
  status: number,
  rawBody: string,
  options?: { firstUsersList?: boolean },
  retryAfterMs?: number,
): GoogleFailure {
  if (status === 429)
    return new GoogleFailure("rate_limited", true, undefined, retryAfterMs)
  if (status >= 500)
    return new GoogleFailure("unreachable", true, undefined, retryAfterMs)
  if (status === 404 || status === 400)
    return new GoogleFailure("unknown_customer", false)
  if (status === 401) return new GoogleFailure("unauthorized_client", false)
  let body: unknown = null
  try {
    body = JSON.parse(rawBody)
  } catch {
    body = null
  }
  const parsed = googleApiErrorSchema.safeParse(body)
  const reasons = new Set<string>()
  if (parsed.success && parsed.data.error) {
    for (const item of parsed.data.error.errors ?? [])
      if (item.reason) reasons.add(item.reason)
    for (const detail of parsed.data.error.details ?? [])
      if (detail.reason) reasons.add(detail.reason)
  }
  if (
    reasons.has("rateLimitExceeded") ||
    reasons.has("userRateLimitExceeded") ||
    reasons.has("quotaExceeded")
  )
    return new GoogleFailure("rate_limited", true, undefined, retryAfterMs)
  if (
    reasons.has("insufficientPermissions") ||
    reasons.has("ACCESS_TOKEN_SCOPE_INSUFFICIENT")
  )
    return new GoogleFailure("missing_scope", false)
  if (reasons.has("notFound") || reasons.has("invalid"))
    return new GoogleFailure("unknown_customer", false)
  if (status === 403 && options?.firstUsersList && reasons.has("forbidden"))
    return new GoogleFailure("subject_not_admin", false)
  return new GoogleFailure("unauthorized_client", false)
}

/**
 * Probes each scope in `GOOGLE_DIRECTORY_SCOPES` individually (no retries,
 * never cached) after Google rejects the combined request with
 * `unauthorized_client`, distinguishing no delegation from partial scopes.
 */
async function diagnoseUnauthorizedScopes(
  deps: { serviceAccount: GoogleServiceAccount; fetch: OidcFetch },
  adminEmail: string,
  now: Date,
  timeoutMs: number,
): Promise<GoogleFailure> {
  const worked: string[] = []
  const rejected: string[] = []
  for (const scope of GOOGLE_DIRECTORY_SCOPES) {
    const assertion = buildGoogleJwtAssertion(deps.serviceAccount, adminEmail, now, [
      scope,
    ])
    const form = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString()
    let response: Response
    try {
      response = await deps.fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      if (error instanceof IdpUnreachable)
        return new GoogleFailure("unauthorized_client", false)
      throw error
    }
    const text = await response.text()
    if (response.status === 200) {
      let json: unknown
      try {
        json = JSON.parse(text)
      } catch {
        return new GoogleFailure("unauthorized_client", false)
      }
      if (!tokenResponseSchema.safeParse(json).success)
        return new GoogleFailure("unauthorized_client", false)
      worked.push(scope)
      continue
    }
    if (response.status === 429 || response.status >= 500)
      return new GoogleFailure("unauthorized_client", false)
    const err = parseOauthError(text).error
    if (
      err === "unauthorized_client" ||
      err === "invalid_scope" ||
      err === "access_denied"
    ) {
      rejected.push(scope)
      continue
    }
    return new GoogleFailure("unauthorized_client", false)
  }
  if (worked.length === 0 && rejected.length === GOOGLE_DIRECTORY_SCOPES.length)
    return new GoogleFailure("delegation_missing", false)
  if (worked.length > 0 && rejected.length > 0)
    return new GoogleFailure("scope_missing", false, rejected)
  return new GoogleFailure("unauthorized_client", false)
}

export interface GoogleTokenSource {
  tokenFor(adminEmail: string, timeoutMs?: number): Promise<string>
  forget(adminEmail: string): void
}

export function createGoogleTokenSource(deps: {
  serviceAccount: GoogleServiceAccount
  fetch: OidcFetch
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
}): GoogleTokenSource {
  const clock = deps.now ?? (() => new Date())
  const cache = new Map<string, { token: string; refreshAtMs: number }>()
  const inflight = new Map<string, Promise<string>>()

  const keyOf = (adminEmail: string) =>
    `${deps.serviceAccount.clientEmail}\n${adminEmail.toLowerCase()}`

  return {
    forget(adminEmail: string) {
      cache.delete(keyOf(adminEmail))
    },

    async tokenFor(adminEmail: string, timeoutMs = GOOGLE_FETCH_TIMEOUT_MS) {
      const clean = normaliseEmail(adminEmail)
      if (!clean) throw new GoogleFailure("not_configured", false)
      const key = keyOf(clean)
      const now = clock()
      const hit = cache.get(key)
      if (hit && now.getTime() < hit.refreshAtMs) return hit.token

      const pending = inflight.get(key)
      if (pending) return pending

      const task = (async () => {
        const issuedAt = clock()
        const assertion = buildGoogleJwtAssertion(deps.serviceAccount, clean, issuedAt)
        const form = new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }).toString()

        return await withGoogleRetry(
          async () => {
            let response: Response
            try {
              response = await deps.fetch(GOOGLE_TOKEN_URL, {
                method: "POST",
                headers: {
                  "content-type": "application/x-www-form-urlencoded",
                  accept: "application/json",
                },
                body: form,
                signal: AbortSignal.timeout(timeoutMs),
              })
            } catch (error) {
              if (error instanceof IdpUnreachable)
                throw new GoogleFailure("unreachable", true)
              throw error
            }

            const text = await response.text()
            const retryAfterMs =
              parseRetryAfterMs(response.headers.get("retry-after")) ?? undefined
            if (response.status !== 200) {
              if (
                response.status !== 429 &&
                response.status < 500 &&
                parseOauthError(text).error === "unauthorized_client"
              ) {
                throw await diagnoseUnauthorizedScopes(deps, clean, clock(), timeoutMs)
              }
              throw classifyTokenFailure(response.status, text, retryAfterMs)
            }

            let json: unknown
            try {
              json = JSON.parse(text)
            } catch {
              throw new GoogleFailure("invalid_response", false)
            }
            const parsed = tokenResponseSchema.safeParse(json)
            if (!parsed.success) throw new GoogleFailure("invalid_response", false)

            const ttlMs = parsed.data.expires_in * 1000
            const skewMs = Math.min(TOKEN_REFRESH_SKEW_MS, Math.floor(ttlMs / 2))
            if (cache.size >= 1_000) cache.delete(cache.keys().next().value!)
            cache.set(key, {
              token: parsed.data.access_token,
              refreshAtMs: issuedAt.getTime() + ttlMs - skewMs,
            })
            return parsed.data.access_token
          },
          { sleep: deps.sleep },
        )
      })()

      inflight.set(key, task)
      try {
        return await task
      } finally {
        inflight.delete(key)
      }
    },
  }
}

// ── Google Directory API wire schemas ───────────────────────────────────────

const googleUserSchema = z.looseObject({
  id: z.string().trim().min(1).max(LIMITS.name),
  primaryEmail: z.string().trim().min(1).max(320),
  suspended: z.boolean().optional(),
  archived: z.boolean().optional(),
  name: z
    .looseObject({
      givenName: z.string().max(1024).nullable().optional(),
      familyName: z.string().max(1024).nullable().optional(),
      fullName: z.string().max(1024).nullable().optional(),
    })
    .nullable()
    .optional(),
  emails: z
    .array(
      z.looseObject({
        address: z.string().max(320).optional(),
        type: z.string().max(128).optional(),
        primary: z.boolean().optional(),
      }),
    )
    .max(200)
    .optional(),
  aliases: z.array(z.string().max(320)).max(200).optional(),
  nonEditableAliases: z.array(z.string().max(320)).max(200).optional(),
})

const usersPageSchema = z
  .looseObject({
    users: z.array(googleUserSchema).max(500).optional(),
    nextPageToken: z.string().max(2048).optional(),
  })
  .refine((p) => !("error" in p), { message: "error envelope on 200" })

const googleGroupSchema = z.looseObject({
  id: z.string().trim().min(1).max(LIMITS.name),
  email: z.string().trim().min(1).max(320).optional(),
  name: z.string().max(1024).optional(),
  aliases: z.array(z.string().max(320)).max(200).optional(),
  nonEditableAliases: z.array(z.string().max(320)).max(200).optional(),
})

const groupsPageSchema = z
  .looseObject({
    groups: z.array(googleGroupSchema).max(500).optional(),
    nextPageToken: z.string().max(2048).optional(),
  })
  .refine((p) => !("error" in p), { message: "error envelope on 200" })

const googleMemberSchema = z.looseObject({
  id: z.string().trim().min(1).max(LIMITS.name).optional(),
  email: z.string().trim().max(320).optional(),
  type: z.string().max(64).optional(),
  status: z.string().max(64).optional(),
})

const membersPageSchema = z
  .looseObject({
    members: z.array(googleMemberSchema).max(500).optional(),
    nextPageToken: z.string().max(2048).optional(),
  })
  .refine((p) => !("error" in p), { message: "error envelope on 200" })

const watchResponseSchema = z.looseObject({
  id: z.string().trim().min(1).max(128).optional(),
  resourceId: z.string().trim().min(1).max(256),
  expiration: z
    .union([z.string().regex(/^\d+$/), z.number().int().positive()])
    .optional(),
})

export type GoogleUserPayload = z.infer<typeof googleUserSchema>
type GoogleGroupPayload = z.infer<typeof googleGroupSchema>
type GoogleMemberPayload = z.infer<typeof googleMemberSchema>

// ── Mapping and canonical diffing ───────────────────────────────────────────

const trimmedBounded = (
  value: string | null | undefined,
  max: number,
): string | null => {
  if (typeof value !== "string") return null
  const t = value.trim().slice(0, max).trim()
  return t.length > 0 ? t : null
}

/** The first address, in order, that is on a domain this workspace proved. */
function firstOnProvedDomain(
  addresses: readonly (string | undefined)[],
  provedDomains: ReadonlySet<string>,
): string | null {
  for (const raw of addresses) {
    const addr = normaliseEmail(raw)
    if (addr && addr.length <= LIMITS.name && provedDomains.has(emailDomain(addr)))
      return addr
  }
  return null
}

/**
 * The address we keep someone under: their primary when it is on a proved
 * domain, else their first alias (`aliases`, then `nonEditableAliases`) on
 * one, or null when none of their Google addresses is ours to hold.
 */
function pickProvedUserEmail(
  user: GoogleUserPayload,
  provedDomains: ReadonlySet<string>,
): string | null {
  const primary = normaliseEmail(user.primaryEmail)
  if (!primary || primary.length > LIMITS.name)
    throw new GoogleFailure("invalid_response", false)
  return firstOnProvedDomain(
    [primary, ...(user.aliases ?? []), ...(user.nonEditableAliases ?? [])],
    provedDomains,
  )
}

function pickProvedGroupEmail(
  group: GoogleGroupPayload,
  provedDomains: ReadonlySet<string>,
): string | null {
  return firstOnProvedDomain(
    [group.email, ...(group.aliases ?? []), ...(group.nonEditableAliases ?? [])],
    provedDomains,
  )
}

/**
 * Maps one Google Directory user to the exact `StoredUser` shape `scim.ts`
 * produces (`readUser`), so downstream provisioning behaves identically.
 */
export function mapGoogleUser(
  user: GoogleUserPayload,
  chosenEmail?: string,
): StoredUser {
  const googlePrimary = normaliseEmail(user.primaryEmail)
  if (!googlePrimary || googlePrimary.length > LIMITS.name)
    throw new GoogleFailure("invalid_response", false)
  const primary =
    chosenEmail !== undefined ? normaliseEmail(chosenEmail) : googlePrimary
  if (!primary || primary.length > LIMITS.name)
    throw new GoogleFailure("invalid_response", false)

  const givenName = trimmedBounded(user.name?.givenName, LIMITS.name)
  const familyName = trimmedBounded(user.name?.familyName, LIMITS.name)
  const fullName =
    trimmedBounded(user.name?.fullName, LIMITS.name) ??
    trimmedBounded([givenName, familyName].filter(Boolean).join(" "), LIMITS.name)

  const seenEmails = new Set<string>([primary])
  const emails: { value: string; type?: string; primary?: boolean }[] = [
    { value: primary, type: "work", primary: true },
  ]

  const addEmail = (raw: string | undefined, type: string | undefined) => {
    if (emails.length >= LIMITS.multi) return
    const addr = normaliseEmail(raw)
    if (!addr || seenEmails.has(addr)) return
    seenEmails.add(addr)
    const cleanType = trimmedBounded(type, 64)
    emails.push({
      value: addr,
      ...(cleanType ? { type: cleanType } : {}),
    })
  }

  if (googlePrimary !== primary) addEmail(googlePrimary, "work")
  for (const entry of user.emails ?? []) addEmail(entry.address, entry.type)
  for (const alias of user.aliases ?? []) addEmail(alias, "alias")
  for (const alias of user.nonEditableAliases ?? []) addEmail(alias, "alias")

  const scimDoc: Record<string, unknown> = {
    userName: primary,
    externalId: user.id,
    active: user.suspended !== true && user.archived !== true,
    emails,
    ...(fullName ? { displayName: fullName } : {}),
    ...(givenName || familyName || fullName
      ? {
          name: {
            ...(givenName ? { givenName } : {}),
            ...(familyName ? { familyName } : {}),
            ...(fullName ? { formatted: fullName } : {}),
          },
        }
      : {}),
  }

  try {
    return readUser(scimDoc)
  } catch {
    throw new GoogleFailure("invalid_response", false)
  }
}

/**
 * Key-order-independent JSON representation.
 *
 * ⚠ POSTGRES `jsonb` REORDERS OBJECT KEYS ON READ. Comparing `JSON.stringify`
 * directly would report every person changed on every 15-minute pull against a
 * real database and flood the outbox and audit log.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`
}

export function sameStoredUser(row: DirectoryUserRow, next: StoredUser): boolean {
  return (
    row.userName === next.userName &&
    row.externalId === next.externalId &&
    row.displayName === next.displayName &&
    row.givenName === next.givenName &&
    row.familyName === next.familyName &&
    row.email === next.email &&
    row.active === next.active &&
    canonicalJson(row.resource) === canonicalJson(next.resource)
  )
}

export function sameStoredGroup(
  row: DirectoryGroupRow,
  currentMemberIds: readonly string[],
  next: StoredGroup,
): boolean {
  if (
    row.displayName !== next.displayName ||
    row.externalId !== next.externalId ||
    canonicalJson(row.resource) !== canonicalJson(next.resource)
  )
    return false
  const left = [...new Set(currentMemberIds.map((id) => id.toLowerCase()))].sort()
  const right = [...new Set(next.members.map((id) => id.toLowerCase()))].sort()
  return left.length === right.length && left.every((id, i) => id === right[i])
}

// ── Authenticated Directory API client helpers ──────────────────────────────

async function googleRequest(
  deps: {
    tokens: GoogleTokenSource
    fetch: OidcFetch
    sleep?: (ms: number) => Promise<void>
  },
  adminEmail: string,
  url: string,
  init: {
    method: "GET" | "POST"
    body?: string
    timeoutMs: number
    firstUsersList?: boolean
  },
): Promise<unknown> {
  return withGoogleRetry(
    async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const token = await deps.tokens.tokenFor(adminEmail, init.timeoutMs)
        let response: Response
        try {
          response = await deps.fetch(url, {
            method: init.method,
            headers: {
              authorization: `Bearer ${token}`,
              accept: "application/json",
              ...(init.body !== undefined
                ? { "content-type": "application/json" }
                : {}),
            },
            ...(init.body !== undefined ? { body: init.body } : {}),
            signal: AbortSignal.timeout(init.timeoutMs),
          })
        } catch (error) {
          if (error instanceof IdpUnreachable)
            throw new GoogleFailure("unreachable", true)
          throw error
        }
        const text = await response.text()
        if (response.status === 401 && attempt === 0) {
          deps.tokens.forget(adminEmail)
          continue
        }
        const retryAfterMs =
          parseRetryAfterMs(response.headers.get("retry-after")) ?? undefined
        if (response.status < 200 || response.status >= 300)
          throw classifyApiFailure(
            response.status,
            text,
            init.firstUsersList ? { firstUsersList: true } : undefined,
            retryAfterMs,
          )
        if (text.trim() === "") return {}
        try {
          return JSON.parse(text)
        } catch {
          throw new GoogleFailure("invalid_response", false)
        }
      }
      throw new GoogleFailure("unauthorized_client", false)
    },
    { sleep: deps.sleep },
  )
}

export type CheckAccessResult =
  | { ok: true }
  | {
      ok: false
      error: GoogleDirectoryErrorCode
      missingScopes?: readonly string[]
    }

/**
 * One cheap Directory API call (`users.list` with `maxResults=1`) for the
 * console's "Check access" action. Never returns Google's raw error message.
 */
export async function checkGoogleDirectoryAccess(
  deps: {
    tokens: GoogleTokenSource | null
    fetch: OidcFetch
    store: Pick<DirectoryStore, "liveDomains">
    timeoutMs?: number
  },
  input: { tenantId: string; adminEmail: string | null; domain: string | null },
): Promise<CheckAccessResult> {
  if (!deps.tokens) return { ok: false, error: "not_configured" }
  const adminEmail = normaliseEmail(input.adminEmail)
  const domain = normaliseDomain(input.domain)
  if (!adminEmail || !domain) return { ok: false, error: "not_configured" }
  const live = await deps.store.liveDomains(input.tenantId)
  if (!live.includes(domain) || !live.includes(emailDomain(adminEmail)))
    return { ok: false, error: "domain_not_verified" }

  const params = new URLSearchParams({
    customer: "my_customer",
    domain,
    maxResults: "1",
  })
  try {
    const raw = await googleRequest(
      { tokens: deps.tokens, fetch: deps.fetch },
      adminEmail,
      `${GOOGLE_DIRECTORY_API_BASE}/users?${params.toString()}`,
      {
        method: "GET",
        timeoutMs: deps.timeoutMs ?? GOOGLE_CHECK_TIMEOUT_MS,
        firstUsersList: true,
      },
    )
    const parsed = usersPageSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, error: "invalid_response" }
    return { ok: true }
  } catch (error) {
    if (error instanceof GoogleFailure) {
      return {
        ok: false,
        error: error.code,
        ...(error.missingScopes ? { missingScopes: error.missingScopes } : {}),
      }
    }
    throw error
  }
}

// ── Complete pull & store reconciliation ────────────────────────────────────

export interface PullBounds {
  pageSize?: number
  maxUsers?: number
  maxGroups?: number
  maxGroupMembers?: number
  timeoutMs?: number
}

export interface PullGoogleDeps {
  store: DirectoryStore
  tokens: GoogleTokenSource | null
  fetch: OidcFetch
  schedule(tenantId: string, entries: readonly OutboxEntry[]): Promise<void>
  record(tenantId: string, event: AuditEvent): Promise<void>
  log: Pick<Logger, "info" | "warn" | "error">
  bounds?: PullBounds
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
}

export type PullGoogleOutcome =
  | {
      outcome: "ok"
      users: { created: number; updated: number; deleted: number; unchanged: number }
      groups: { created: number; updated: number; deleted: number; unchanged: number }
    }
  | { outcome: "skipped"; reason: "no_directory" | "directory_disabled" }
  | {
      outcome: "failed"
      error: GoogleDirectoryErrorCode
      retryable: boolean
      missingScopes?: readonly string[]
    }

async function loadAllLiveUsers(
  store: DirectoryStore,
  tenantId: string,
  directoryId: string,
): Promise<DirectoryUserRow[]> {
  const all: DirectoryUserRow[] = []
  for (let startIndex = 1; ; startIndex += 500) {
    const page = await store.listUsers(tenantId, directoryId, {
      filter: null,
      startIndex,
      count: 500,
    })
    all.push(...page.rows)
    if (page.rows.length === 0 || all.length >= page.total) return all
  }
}

async function hasLiveUsers(
  store: DirectoryStore,
  tenantId: string,
  directoryId: string,
): Promise<boolean> {
  const page = await store.listUsers(tenantId, directoryId, {
    filter: null,
    startIndex: 1,
    count: 1,
  })
  return page.rows.length > 0
}

async function loadAllGroups(
  store: DirectoryStore,
  tenantId: string,
  directoryId: string,
): Promise<{ rows: DirectoryGroupRow[]; members: Map<string, string[]> }> {
  const rows: DirectoryGroupRow[] = []
  for (let startIndex = 1; ; startIndex += 500) {
    const page = await store.listGroups(tenantId, directoryId, {
      filter: null,
      startIndex,
      count: 500,
    })
    rows.push(...page.rows)
    if (page.rows.length === 0 || rows.length >= page.total) break
  }
  const members = new Map<string, string[]>()
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500).map((r) => r.id)
    const found = await store.membersOf(tenantId, batch)
    for (const [gid, list] of found)
      members.set(
        gid,
        list.map((m) => m.id),
      )
  }
  return { rows, members }
}

export const GOOGLE_GROUP_MEMBERS_CONCURRENCY = 6

export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []
  const results: R[] = new Array(items.length)
  let nextIndex = 0
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const idx = nextIndex++
        results[idx] = await fn(items[idx]!)
      }
    },
  )
  await Promise.all(workers)
  return results
}

async function fetchGoogleSnapshot(
  deps: {
    tokens: GoogleTokenSource
    fetch: OidcFetch
    sleep?: (ms: number) => Promise<void>
  },
  adminEmail: string,
  provedDomains: ReadonlySet<string>,
  bounds: Required<PullBounds>,
): Promise<{
  users: StoredUser[]
  groups: { group: GoogleGroupPayload; members: GoogleMemberPayload[] }[]
}> {
  const users: StoredUser[] = []
  const seenRawUserIds = new Set<string>()
  const seenExternalIds = new Set<string>()
  const seenUserNames = new Set<string>()
  const userTokens = new Set<string>()
  let nextUserToken: string | undefined
  let userPages = 0

  for (;;) {
    if (++userPages > MAX_GOOGLE_PAGES) throw new GoogleFailure("too_many_users", false)
    const params = new URLSearchParams({
      customer: "my_customer",
      maxResults: String(bounds.pageSize),
      ...(nextUserToken ? { pageToken: nextUserToken } : {}),
    })
    const raw = await googleRequest(
      deps,
      adminEmail,
      `${GOOGLE_DIRECTORY_API_BASE}/users?${params.toString()}`,
      {
        method: "GET",
        timeoutMs: bounds.timeoutMs,
        firstUsersList: !nextUserToken,
      },
    )
    const parsed = usersPageSchema.safeParse(raw)
    if (!parsed.success) throw new GoogleFailure("invalid_response", false)

    for (const u of parsed.data.users ?? []) {
      if (seenRawUserIds.has(u.id)) throw new GoogleFailure("invalid_response", false)
      seenRawUserIds.add(u.id)
      const chosenEmail = pickProvedUserEmail(u, provedDomains)
      if (!chosenEmail) continue
      if (users.length >= bounds.maxUsers)
        throw new GoogleFailure("too_many_users", false)
      const mapped = mapGoogleUser(u, chosenEmail)
      const lower = mapped.userName.toLowerCase()
      if (
        (mapped.externalId && seenExternalIds.has(mapped.externalId)) ||
        seenUserNames.has(lower)
      )
        throw new GoogleFailure("invalid_response", false)
      if (mapped.externalId) seenExternalIds.add(mapped.externalId)
      seenUserNames.add(lower)
      users.push(mapped)
    }

    const token = parsed.data.nextPageToken?.trim()
    if (!token) break
    if (userTokens.has(token)) throw new GoogleFailure("invalid_response", false)
    userTokens.add(token)
    nextUserToken = token
  }

  const rawGroups: GoogleGroupPayload[] = []
  const seenGroupIds = new Set<string>()
  const groupTokens = new Set<string>()
  let nextGroupToken: string | undefined
  let groupPages = 0

  for (;;) {
    if (++groupPages > MAX_GOOGLE_PAGES)
      throw new GoogleFailure("too_many_groups", false)
    const params = new URLSearchParams({
      customer: "my_customer",
      maxResults: String(bounds.pageSize),
      ...(nextGroupToken ? { pageToken: nextGroupToken } : {}),
    })
    const raw = await googleRequest(
      deps,
      adminEmail,
      `${GOOGLE_DIRECTORY_API_BASE}/groups?${params.toString()}`,
      { method: "GET", timeoutMs: bounds.timeoutMs },
    )
    const parsed = groupsPageSchema.safeParse(raw)
    if (!parsed.success) throw new GoogleFailure("invalid_response", false)

    for (const g of parsed.data.groups ?? []) {
      if (seenGroupIds.has(g.id)) throw new GoogleFailure("invalid_response", false)
      seenGroupIds.add(g.id)
      if (!pickProvedGroupEmail(g, provedDomains)) continue
      if (rawGroups.length >= bounds.maxGroups)
        throw new GoogleFailure("too_many_groups", false)
      rawGroups.push(g)
    }

    const token = parsed.data.nextPageToken?.trim()
    if (!token) break
    if (groupTokens.has(token)) throw new GoogleFailure("invalid_response", false)
    groupTokens.add(token)
    nextGroupToken = token
  }

  const groups = await mapConcurrent(
    rawGroups,
    GOOGLE_GROUP_MEMBERS_CONCURRENCY,
    async (group) => {
      const members: GoogleMemberPayload[] = []
      const memberTokens = new Set<string>()
      let nextMemberToken: string | undefined
      let memberPages = 0

      for (;;) {
        if (++memberPages > MAX_GOOGLE_PAGES)
          throw new GoogleFailure("too_many_groups", false)
        const params = new URLSearchParams({
          maxResults: String(bounds.pageSize),
          ...(nextMemberToken ? { pageToken: nextMemberToken } : {}),
        })
        const raw = await googleRequest(
          deps,
          adminEmail,
          `${GOOGLE_DIRECTORY_API_BASE}/groups/${encodeURIComponent(group.id)}/members?${params.toString()}`,
          { method: "GET", timeoutMs: bounds.timeoutMs },
        )
        const parsed = membersPageSchema.safeParse(raw)
        if (!parsed.success) throw new GoogleFailure("invalid_response", false)

        for (const m of parsed.data.members ?? []) {
          if (members.length >= bounds.maxGroupMembers)
            throw new GoogleFailure("too_many_groups", false)
          members.push(m)
        }

        const token = parsed.data.nextPageToken?.trim()
        if (!token) break
        if (memberTokens.has(token)) throw new GoogleFailure("invalid_response", false)
        memberTokens.add(token)
        nextMemberToken = token
      }
      return { group, members }
    },
  )

  return { users, groups }
}

function buildStoredGroups(
  fetched: readonly { group: GoogleGroupPayload; members: GoogleMemberPayload[] }[],
  provedDomains: ReadonlySet<string>,
  byExternalId: ReadonlyMap<string, string>,
  byEmail: ReadonlyMap<string, string>,
  allUserIds: readonly string[],
): StoredGroup[] {
  const byGroupId = new Map<
    string,
    { group: GoogleGroupPayload; members: GoogleMemberPayload[] }
  >()
  const byGroupEmail = new Map<string, string>()
  for (const entry of fetched) {
    byGroupId.set(entry.group.id, entry)
    const addGroupAddr = (raw: string | undefined) => {
      const addr = normaliseEmail(raw)
      if (addr && !byGroupEmail.has(addr)) byGroupEmail.set(addr, entry.group.id)
    }
    addGroupAddr(entry.group.email)
    for (const alias of entry.group.aliases ?? []) addGroupAddr(alias)
    for (const alias of entry.group.nonEditableAliases ?? []) addGroupAddr(alias)
  }

  const resolvedCache = new Map<string, string[]>()
  const resolveMembers = (groupId: string, stack: Set<string>): string[] => {
    const hit = resolvedCache.get(groupId)
    if (hit) return hit
    if (stack.has(groupId)) return []
    const entry = byGroupId.get(groupId)
    if (!entry) return []

    stack.add(groupId)
    const ids = new Set<string>()
    for (const m of entry.members) {
      if (m.status && m.status.toUpperCase() !== "ACTIVE") continue
      const kind = m.type?.toUpperCase()
      if (kind === "CUSTOMER") {
        for (const uid of allUserIds) ids.add(uid)
        continue
      }
      if (kind === "GROUP") {
        const nestedId =
          m.id && byGroupId.has(m.id)
            ? m.id
            : (byGroupEmail.get(normaliseEmail(m.email) ?? "") ?? null)
        if (nestedId) {
          for (const uid of resolveMembers(nestedId, stack)) ids.add(uid)
        }
        continue
      }
      const userId =
        (m.id ? byExternalId.get(m.id) : undefined) ??
        byEmail.get(normaliseEmail(m.email) ?? "")
      if (userId) ids.add(userId)
    }
    stack.delete(groupId)

    const out = [...ids].slice(0, LIMITS.members)
    resolvedCache.set(groupId, out)
    return out
  }

  const addressOf = (group: GoogleGroupPayload) =>
    pickProvedGroupEmail(group, provedDomains) ?? group.email
  const baseName = (group: GoogleGroupPayload) =>
    trimmedBounded(group.name, LIMITS.name) ??
    trimmedBounded(addressOf(group), LIMITS.name) ??
    group.id
  const nameCounts = new Map<string, number>()
  for (const { group } of fetched) {
    const key = baseName(group).toLowerCase()
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1)
  }

  return fetched.map(({ group }) => {
    // ⚠ GOOGLE ONLY MAKES A GROUP'S ADDRESS UNIQUE, AND WE KEEP ONE NAME PER
    // DIRECTORY: two groups called "Sales" must both arrive, or the second one's
    // members lose whatever its group rule gives them.
    const base = baseName(group)
    const displayName =
      (nameCounts.get(base.toLowerCase()) ?? 0) > 1
        ? (trimmedBounded(`${base} (${addressOf(group) ?? group.id})`, LIMITS.name) ??
          base)
        : base
    const memberIds = resolveMembers(group.id, new Set())
    try {
      return readGroup({
        displayName,
        externalId: group.id,
        members: memberIds.map((value) => ({ value })),
      })
    } catch {
      throw new GoogleFailure("invalid_response", false)
    }
  })
}

export async function pullGoogleDirectory(
  deps: PullGoogleDeps,
  input: { tenantId: string; directoryId: string },
): Promise<PullGoogleOutcome> {
  const clock = deps.now ?? (() => new Date())
  const { tenantId, directoryId } = input

  const directory = await deps.store.directory(tenantId, directoryId)
  if (!directory || directory.provider !== "google")
    return { outcome: "skipped", reason: "no_directory" }
  if (!directory.enabled) return { outcome: "skipped", reason: "directory_disabled" }

  // Re-read after the network pages, so a go-ahead given mid-pull is seen.
  let current = directory

  const failPull = async (
    code: GoogleDirectoryErrorCode,
    retryable: boolean,
    extra?: {
      missingScopes?: readonly string[]
      existingUsers?: number
      removedUsers?: number
      keptUsers?: number
    },
  ): Promise<PullGoogleOutcome> => {
    const at = clock()
    await deps.store.noteDirectorySync(tenantId, directoryId, {
      status: "failed",
      error: code,
      at,
      // A pull that reached the guard has spent any go-ahead, applied or not:
      // a refusal again needs the owner to look at the new numbers.
      clearDropAllowance: code === "large_drop" || code === "user_conflict",
    })
    if (
      directory.lastSyncStatus !== "failed" ||
      directory.lastSyncError !== code ||
      // The counts may differ from the ones the owner confirmed, so say them again.
      (code === "large_drop" && current.allowDropUpTo !== null)
    ) {
      await deps.record(tenantId, {
        type: "directory.sync_failed",
        reason: code,
        data: {
          directoryId,
          ...(extra?.missingScopes && extra.missingScopes.length > 0
            ? { missingScopes: [...extra.missingScopes] }
            : {}),
          ...(extra?.existingUsers !== undefined
            ? { existingUsers: extra.existingUsers }
            : {}),
          ...(extra?.removedUsers !== undefined
            ? { removedUsers: extra.removedUsers }
            : {}),
          ...(extra?.keptUsers !== undefined ? { keptUsers: extra.keptUsers } : {}),
        },
      })
    }
    return {
      outcome: "failed",
      error: code,
      retryable,
      ...(extra?.missingScopes && extra.missingScopes.length > 0
        ? { missingScopes: extra.missingScopes }
        : {}),
    }
  }

  if (!deps.tokens) return failPull("not_configured", false)
  const adminEmail = normaliseEmail(directory.adminEmail)
  const domain = normaliseDomain(directory.domain)
  if (!adminEmail || !domain) return failPull("not_configured", false)

  const liveDomains = await deps.store.liveDomains(tenantId)
  const provedDomains = new Set(liveDomains)
  // ⚠ THE ADMIN WE IMPERSONATE MUST BE OF A DOMAIN THIS WORKSPACE PROVED. Any
  // Workspace customer can authorise our client id, so an unchecked address
  // would let a workspace point the delegation at another company's admin.
  if (!provedDomains.has(domain) || !provedDomains.has(emailDomain(adminEmail)))
    return failPull("domain_not_verified", false)

  const bounds: Required<PullBounds> = {
    pageSize: Math.min(Math.max(1, deps.bounds?.pageSize ?? GOOGLE_PAGE_SIZE), 500),
    maxUsers: deps.bounds?.maxUsers ?? GOOGLE_MAX_USERS,
    maxGroups: deps.bounds?.maxGroups ?? GOOGLE_MAX_GROUPS,
    maxGroupMembers: deps.bounds?.maxGroupMembers ?? GOOGLE_MAX_GROUP_MEMBERS,
    timeoutMs: deps.bounds?.timeoutMs ?? GOOGLE_FETCH_TIMEOUT_MS,
  }

  let snapshot: Awaited<ReturnType<typeof fetchGoogleSnapshot>>
  let storedGroupsDraft: { group: GoogleGroupPayload; members: GoogleMemberPayload[] }[]
  try {
    snapshot = await fetchGoogleSnapshot(
      { tokens: deps.tokens, fetch: deps.fetch, sleep: deps.sleep },
      adminEmail,
      provedDomains,
      bounds,
    )
    storedGroupsDraft = snapshot.groups
    // Validate group display names and shapes before touching any user row.
    buildStoredGroups(storedGroupsDraft, provedDomains, new Map(), new Map(), [])
  } catch (error) {
    if (error instanceof GoogleFailure) {
      return failPull(
        error.code,
        error.retryable,
        error.missingScopes ? { missingScopes: error.missingScopes } : undefined,
      )
    }
    throw error
  }

  // ⚠ A "COMPLETE" PULL OF ZERO PEOPLE IS NOT BELIEVED. Every Workspace has at
  // least its admin, so an empty list over a directory we already hold means
  // a wrong domain or a Google-side fault, and acting on it would deprovision
  // everybody.
  if (
    snapshot.users.length === 0 &&
    (await hasLiveUsers(deps.store, tenantId, directoryId))
  )
    return failPull("empty_directory", false)

  // Re-check enabled after the network pages complete, so disabling mid-pull writes nothing.
  const latest = await deps.store.directory(tenantId, directoryId)
  if (!latest || latest.provider !== "google")
    return { outcome: "skipped", reason: "no_directory" }
  if (!latest.enabled) return { outcome: "skipped", reason: "directory_disabled" }
  current = latest

  const existingUsers = await loadAllLiveUsers(deps.store, tenantId, directoryId)
  const matchedRowIds = new Set<string>()
  const userMatches: { row: DirectoryUserRow; next: StoredUser }[] = []
  const toCreateUsers: StoredUser[] = []

  const existingByExternalId = new Map<string, DirectoryUserRow>()
  const existingByUserName = new Map<string, DirectoryUserRow>()
  for (const row of existingUsers) {
    if (row.externalId && !existingByExternalId.has(row.externalId))
      existingByExternalId.set(row.externalId, row)
    existingByUserName.set(row.userName.toLowerCase(), row)
  }

  for (const next of snapshot.users) {
    const byExt = next.externalId
      ? existingByExternalId.get(next.externalId)
      : undefined
    const candidate =
      byExt && !matchedRowIds.has(byExt.id)
        ? byExt
        : (() => {
            const byName = existingByUserName.get(next.userName.toLowerCase())
            return byName && !matchedRowIds.has(byName.id) ? byName : undefined
          })()
    if (candidate) {
      matchedRowIds.add(candidate.id)
      userMatches.push({ row: candidate, next })
    } else {
      toCreateUsers.push(next)
    }
  }

  const toDeleteUsers = existingUsers.filter((row) => !matchedRowIds.has(row.id))
  // ⚠ THE GO-AHEAD COVERS AT MOST THE COUNT THE OWNER CONFIRMED, FOR A DAY. A
  // pull that would remove more (the directory changed since) is refused again.
  const allowedDrop =
    latest.allowDropUpTo !== null &&
    latest.allowDropAt !== null &&
    clock().getTime() - latest.allowDropAt.getTime() < GOOGLE_DROP_ALLOWANCE_MS
      ? latest.allowDropUpTo
      : 0
  if (
    toDeleteUsers.length > GOOGLE_MAX_DROP_USERS &&
    toDeleteUsers.length * 100 > existingUsers.length * GOOGLE_MAX_DROP_PERCENT &&
    toDeleteUsers.length > allowedDrop
  ) {
    return failPull("large_drop", false, {
      existingUsers: existingUsers.length,
      removedUsers: toDeleteUsers.length,
      keptUsers: snapshot.users.length,
    })
  }

  const emittedOutbox: OutboxEntry[] = []
  const userCounts = { created: 0, updated: 0, deleted: 0, unchanged: 0 }

  // 1. Delete removed users first (only reached after every Google page succeeded).
  for (const row of toDeleteUsers) {
    const done = await deps.store.deleteUser(tenantId, directoryId, row.id, {
      type: "scim.user.deleted",
      data: { directoryId, directoryUserId: row.id, source: "google" },
    })
    if (done) {
      userCounts.deleted += 1
      emittedOutbox.push(...done.outbox)
    }
  }

  // 2. Edit changed users; unchanged rows write nothing at all.
  const finalUsers: DirectoryUserRow[] = []
  let deferredEdits: { row: DirectoryUserRow; next: StoredUser }[] = []
  let unresolvedConflicts = 0

  const userAudit = (before: DirectoryUserRow, after: StoredUser): AuditEvent => ({
    type:
      before.active && !after.active
        ? "scim.user.deactivated"
        : !before.active && after.active
          ? "scim.user.reactivated"
          : "scim.user.updated",
    data: { directoryId, directoryUserId: before.id, source: "google" },
  })

  for (const pair of userMatches) {
    if (sameStoredUser(pair.row, pair.next)) {
      userCounts.unchanged += 1
      finalUsers.push(pair.row)
      continue
    }
    const edited = await deps.store.editUser(
      tenantId,
      directoryId,
      pair.row.id,
      () => pair.next,
      userAudit,
    )
    if (edited === "taken") {
      deferredEdits.push(pair)
      continue
    }
    if (edited) {
      userCounts.updated += 1
      finalUsers.push(edited.row)
      emittedOutbox.push(...edited.outbox)
    }
  }

  if (deferredEdits.length > 0) {
    const stillTaken: { row: DirectoryUserRow; next: StoredUser }[] = []
    for (const pair of deferredEdits) {
      const edited = await deps.store.editUser(
        tenantId,
        directoryId,
        pair.row.id,
        () => pair.next,
        userAudit,
      )
      if (edited === "taken") {
        stillTaken.push(pair)
        continue
      }
      if (edited) {
        userCounts.updated += 1
        finalUsers.push(edited.row)
        emittedOutbox.push(...edited.outbox)
      }
    }
    // ⚠ NO PLACEHOLDER PARKING: an edit that parks a user on a made-up address
    // would reach the outbox and be applied downstream. A userName that is
    // still taken after the second pass is left as it is, reported as a failed
    // sync, and settles on a later pull once its holder has moved.
    unresolvedConflicts += stillTaken.length
    for (const pair of stillTaken) finalUsers.push(pair.row)
    deferredEdits = []
  }

  // 3. Create new users.
  for (const next of toCreateUsers) {
    const made = await deps.store.createUser(tenantId, directoryId, next, {
      type: "scim.user.created",
      data: { directoryId, source: "google" },
    })
    if (made === "taken") {
      unresolvedConflicts += 1
      continue
    }
    userCounts.created += 1
    finalUsers.push(made.row)
    emittedOutbox.push(...made.outbox)
  }

  // 4. Reconcile groups and memberships against the live directory users.
  const userIdByExternalId = new Map<string, string>()
  const userIdByEmail = new Map<string, string>()
  for (const u of finalUsers) {
    if (u.externalId) userIdByExternalId.set(u.externalId, u.id)
    if (u.email) userIdByEmail.set(u.email.toLowerCase(), u.id)
    userIdByEmail.set(u.userName.toLowerCase(), u.id)
  }
  for (const u of finalUsers) {
    const rawEmails = u.resource.emails
    if (!Array.isArray(rawEmails)) continue
    for (const entry of rawEmails) {
      if (
        entry &&
        typeof entry === "object" &&
        "value" in entry &&
        typeof entry.value === "string"
      ) {
        const addr = normaliseEmail(entry.value)
        if (addr && !userIdByEmail.has(addr)) userIdByEmail.set(addr, u.id)
      }
    }
  }
  const desiredGroups = buildStoredGroups(
    storedGroupsDraft,
    provedDomains,
    userIdByExternalId,
    userIdByEmail,
    finalUsers.map((u) => u.id),
  )

  const existingGroups = await loadAllGroups(deps.store, tenantId, directoryId)
  const matchedGroupIds = new Set<string>()
  const groupMatches: { row: DirectoryGroupRow; next: StoredGroup }[] = []
  const toCreateGroups: StoredGroup[] = []

  const groupByExt = new Map<string, DirectoryGroupRow>()
  const groupByName = new Map<string, DirectoryGroupRow>()
  for (const g of existingGroups.rows) {
    if (g.externalId && !groupByExt.has(g.externalId)) groupByExt.set(g.externalId, g)
    if (!groupByName.has(g.displayName.toLowerCase()))
      groupByName.set(g.displayName.toLowerCase(), g)
  }

  for (const next of desiredGroups) {
    const byExt = next.externalId ? groupByExt.get(next.externalId) : undefined
    const candidate =
      byExt && !matchedGroupIds.has(byExt.id)
        ? byExt
        : (() => {
            const byName = groupByName.get(next.displayName.toLowerCase())
            return byName && !matchedGroupIds.has(byName.id) ? byName : undefined
          })()
    if (candidate) {
      matchedGroupIds.add(candidate.id)
      groupMatches.push({ row: candidate, next })
    } else {
      toCreateGroups.push(next)
    }
  }

  const groupCounts = { created: 0, updated: 0, deleted: 0, unchanged: 0 }

  for (const row of existingGroups.rows) {
    if (matchedGroupIds.has(row.id)) continue
    const done = await deps.store.deleteGroup(tenantId, directoryId, row.id, {
      type: "scim.group.deleted",
      data: { directoryId, source: "google" },
    })
    if (done) {
      groupCounts.deleted += 1
      emittedOutbox.push(...done.outbox)
    }
  }

  for (const { row, next } of groupMatches) {
    const currentMembers = existingGroups.members.get(row.id) ?? []
    if (sameStoredGroup(row, currentMembers, next)) {
      groupCounts.unchanged += 1
      continue
    }
    const done = await deps.store.editGroup(tenantId, directoryId, row.id, () => next, {
      type: "scim.group.updated",
      data: { directoryId, source: "google" },
    })
    // Two groups swapping names in one pull: the next pull settles it.
    if (done && done.kind === "duplicate") {
      deps.log.warn({ directoryId }, "a Google group kept its old name for now")
      continue
    }
    if (done) {
      groupCounts.updated += 1
      emittedOutbox.push(...done.outbox)
    }
  }

  for (const next of toCreateGroups) {
    const made = await deps.store.createGroup(tenantId, directoryId, next, {
      type: "scim.group.created",
      data: { directoryId, source: "google" },
    })
    // Only an old row still holding the name, renamed earlier in this pull or by
    // the next one. Names are made unique above.
    if (made.kind === "duplicate") {
      deps.log.warn({ directoryId }, "a Google group waits for its name to free up")
      continue
    }
    groupCounts.created += 1
    emittedOutbox.push(...made.outbox)
  }

  if (emittedOutbox.length > 0) await deps.schedule(tenantId, emittedOutbox)

  if (unresolvedConflicts > 0) {
    return failPull("user_conflict", false)
  }

  await deps.store.noteDirectorySync(tenantId, directoryId, {
    status: "ok",
    error: null,
    at: clock(),
  })

  return { outcome: "ok", users: userCounts, groups: groupCounts }
}

// ── Push notification watch channels (`users.watch` and `channels.stop`) ────

async function stopRemoteChannel(
  deps: {
    tokens: GoogleTokenSource
    fetch: OidcFetch
    log: Pick<Logger, "warn">
    sleep?: (ms: number) => Promise<void>
  },
  adminEmail: string,
  channel: { id: string; resourceId: string },
  timeoutMs: number,
): Promise<void> {
  try {
    await googleRequest(
      deps,
      adminEmail,
      `${GOOGLE_DIRECTORY_API_BASE}/channels/stop`,
      {
        method: "POST",
        body: JSON.stringify({ id: channel.id, resourceId: channel.resourceId }),
        timeoutMs,
      },
    )
  } catch (error) {
    // 404/400 on stop means the channel already expired at Google.
    if (error instanceof GoogleFailure && error.code === "unknown_customer") return
    deps.log.warn(
      { ...safeError(error), channelId: channel.id },
      "could not stop a Google directory watch channel",
    )
  }
}

/**
 * Ensures one live `users.watch` channel per event (`add`, `update`, `delete`,
 * `undelete`), renewing any channel within `GOOGLE_WATCH_RENEW_BEFORE_MS` of
 * expiry and storing ONLY the SHA-256 hash of its per-channel secret.
 */
export async function ensureGoogleWatchChannels(
  deps: {
    store: DirectoryStore
    tokens: GoogleTokenSource | null
    fetch: OidcFetch
    notifyUrl: string | null
    log: Pick<Logger, "warn">
    record?: (tenantId: string, event: AuditEvent) => Promise<void>
    timeoutMs?: number
    now?: () => Date
    sleep?: (ms: number) => Promise<void>
  },
  directory: Pick<Directory, "id" | "tenantId" | "enabled" | "adminEmail" | "domain">,
): Promise<number> {
  if (!directory.enabled || !deps.tokens || !deps.notifyUrl) return 0
  let parsedNotify: URL
  try {
    parsedNotify = new URL(deps.notifyUrl)
  } catch {
    return 0
  }
  if (parsedNotify.protocol !== "https:") return 0

  const adminEmail = normaliseEmail(directory.adminEmail)
  const domain = normaliseDomain(directory.domain)
  if (!adminEmail || !domain) return 0

  const clock = deps.now ?? (() => new Date())
  const now = clock()
  const timeoutMs = deps.timeoutMs ?? GOOGLE_FETCH_TIMEOUT_MS
  const existing = await deps.store.watchChannels(directory.tenantId, directory.id)

  let registered = 0
  for (const event of GOOGLE_WATCH_EVENTS) {
    const forEvent = existing
      .filter((c) => c.event === event)
      .sort((a, b) => b.expiresAt.getTime() - a.expiresAt.getTime())
    const freshest = forEvent[0]
    if (
      freshest &&
      freshest.expiresAt.getTime() - now.getTime() > GOOGLE_WATCH_RENEW_BEFORE_MS
    ) {
      const extras = forEvent.slice(1)
      if (extras.length > 0) {
        await deps.store.deleteWatchChannels(
          directory.tenantId,
          directory.id,
          extras.map((e) => e.id),
        )
        for (const old of extras)
          if (old.expiresAt.getTime() > now.getTime())
            await stopRemoteChannel(
              {
                tokens: deps.tokens,
                fetch: deps.fetch,
                log: deps.log,
                sleep: deps.sleep,
              },
              adminEmail,
              old,
              timeoutMs,
            )
      }
      continue
    }

    const channelId = randomUUID()
    const secret = newSecret()
    const requestedExp = now.getTime() + GOOGLE_WATCH_TTL_MS
    const params = new URLSearchParams({
      customer: "my_customer",
      domain,
      event,
    })

    let parsed: z.infer<typeof watchResponseSchema>
    try {
      const raw = await googleRequest(
        { tokens: deps.tokens, fetch: deps.fetch, sleep: deps.sleep },
        adminEmail,
        `${GOOGLE_DIRECTORY_API_BASE}/users/watch?${params.toString()}`,
        {
          method: "POST",
          body: JSON.stringify({
            id: channelId,
            type: "web_hook",
            address: parsedNotify.href,
            token: secret,
            params: { ttl: String(Math.floor(GOOGLE_WATCH_TTL_MS / 1000)) },
            expiration: requestedExp,
          }),
          timeoutMs,
        },
      )
      const ok = watchResponseSchema.safeParse(raw)
      if (!ok.success) {
        deps.log.warn(
          { directoryId: directory.id, event },
          "Google users.watch returned an unexpected payload",
        )
        if (deps.record) {
          await deps
            .record(directory.tenantId, {
              type: "directory.watch_failed",
              reason: "invalid_response",
              data: { directoryId: directory.id, event },
            })
            .catch(() => {})
        }
        continue
      }
      parsed = ok.data
    } catch (error) {
      deps.log.warn(
        { ...safeError(error), directoryId: directory.id, event },
        "could not register a Google directory watch channel",
      )
      if (deps.record) {
        await deps
          .record(directory.tenantId, {
            type: "directory.watch_failed",
            reason:
              error instanceof GoogleFailure ? error.code : "watch_registration_failed",
            data: { directoryId: directory.id, event },
          })
          .catch(() => {})
      }
      continue
    }

    const remoteExpMs =
      parsed.expiration !== undefined ? Number(parsed.expiration) : requestedExp
    const clampedExpMs =
      Number.isFinite(remoteExpMs) && remoteExpMs > now.getTime()
        ? Math.min(remoteExpMs, now.getTime() + 7 * 24 * 3600_000)
        : requestedExp

    await deps.store.saveWatchChannel(directory.tenantId, {
      id: channelId,
      directoryId: directory.id,
      event: event satisfies GoogleWatchEvent,
      resourceId: parsed.resourceId,
      tokenHash: hashSecret(secret),
      expiresAt: new Date(clampedExpMs),
    })
    registered += 1

    if (forEvent.length > 0) {
      await deps.store.deleteWatchChannels(
        directory.tenantId,
        directory.id,
        forEvent.map((e) => e.id),
      )
      for (const old of forEvent)
        if (old.expiresAt.getTime() > now.getTime())
          await stopRemoteChannel(
            { tokens: deps.tokens, fetch: deps.fetch, log: deps.log },
            adminEmail,
            old,
            timeoutMs,
          )
    }
  }

  return registered
}

/**
 * Deletes every watch channel of a directory from our store at once and tells
 * Google `channels.stop` best-effort so no further notifications are sent.
 */
export async function stopGoogleWatchChannels(
  deps: {
    store: DirectoryStore
    tokens: GoogleTokenSource | null
    fetch: OidcFetch
    log: Pick<Logger, "warn">
    timeoutMs?: number
    now?: () => Date
  },
  input: { tenantId: string; directoryId: string; adminEmail?: string | null },
): Promise<number> {
  const clock = deps.now ?? (() => new Date())
  const now = clock()
  const directory =
    input.adminEmail !== undefined
      ? { adminEmail: input.adminEmail }
      : await deps.store.directory(input.tenantId, input.directoryId)
  const gone = await deps.store.deleteWatchChannels(input.tenantId, input.directoryId)
  if (gone.length === 0) return 0

  const adminEmail = normaliseEmail(directory?.adminEmail)
  if (deps.tokens && adminEmail) {
    const timeoutMs = deps.timeoutMs ?? GOOGLE_CHECK_TIMEOUT_MS
    for (const ch of gone) {
      if (ch.expiresAt.getTime() <= now.getTime()) continue
      await stopRemoteChannel(
        { tokens: deps.tokens, fetch: deps.fetch, log: deps.log },
        adminEmail,
        ch,
        timeoutMs,
      )
    }
  }
  return gone.length
}
