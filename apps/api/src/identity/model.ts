import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

/**
 * The identity core's vocabulary and its pure decisions (#337, sso.md 2.1 to
 * 2.5). Nothing here does I/O: the bridge, the gate and the managed-account
 * rules take what they need through ports, and every rule that decides who
 * gets in is a function in this file the tests drive directly.
 */

export type Protocol = "oidc" | "saml" | "test"
export type ConnectionStatus = "draft" | "testing" | "active" | "disabled"
export type Enforcement = "off" | "optional" | "required_domain" | "required_all"
export type AttemptPurpose = "sign_in" | "test_run" | "step_up"
export type ManagedReason = "scim" | "jit" | "claimed" | "linked"
export type DeprovisionMode = "membership" | "account"

export const PROTOCOLS: readonly Protocol[] = ["oidc", "saml", "test"]
export const STATUSES: readonly ConnectionStatus[] = [
  "draft",
  "testing",
  "active",
  "disabled",
]
/**
 * Connection statuses whose TRUST settings only an owner may change: issuer,
 * client, secret, keys, domains, MFA proof, claim mapping (sso.md 2.14). A
 * disabled connection is an active one paused: its managed accounts are
 * still its own.
 */
export const OWNER_GUARDED: readonly ConnectionStatus[] = ["active", "disabled"]

export const ENFORCEMENTS: readonly Enforcement[] = [
  "off",
  "optional",
  "required_domain",
  "required_all",
]

export interface Connection {
  id: string
  tenantId: string
  name: string
  protocol: Protocol
  provider: string
  status: ConnectionStatus
  enforcement: Enforcement
  jitEnabled: boolean
  mfaRequired: boolean
  maxSessionSeconds: number | null
  idleTimeoutSeconds: number | null
  config: Record<string, unknown>
  attributeMapping: Record<string, string>
}

/**
 * What an engine hands the bridge once it has VERIFIED a response: a SAML
 * assertion's signature and conditions, an OIDC ID token's signature, nonce
 * and audience. The bridge trusts every field here and checks none of the
 * protocol; that is the engine's whole job (#338, #339).
 */
export interface Assertion {
  /** The IdP's stable identifier: OIDC `sub`, SAML NameID (persistent). */
  subject: string
  email: string | null
  /** Whether the IdP vouches for the address (`email_verified`; SAML: by policy). */
  emailVerified: boolean
  givenName?: string | null
  familyName?: string | null
  attributes?: Record<string, unknown>
  groups?: string[]
  /** When the person authenticated at the IdP. */
  authTime: Date | null
  /** OIDC `amr`, or SAML AuthnContextClassRef mapped to the same words. */
  amr?: string[]
  /** OIDC `acr` as the IdP sent it, for the record. */
  acr?: string | null
  /**
   * The engine found `acr` on the connection's own list of values that prove
   * MFA (#338). `amr` alone is not enough for IdPs that only send `acr`.
   */
  mfaByAcr?: boolean
  /** OIDC `sid` / SAML SessionIndex, for IdP logout (#345). */
  idpSession?: string | null
}

// ── Time ─────────────────────────────────────────────────────────────────

/** From the redirect to the IdP until the engine reports back. */
export const ATTEMPT_TTL_MS = 10 * 60 * 1000
/** From a verified login until the browser swaps its handoff code. */
export const HANDOFF_TTL_MS = 2 * 60 * 1000
/** Clerk's sign-in token: as short as Clerk allows us to choose (P1). */
export const TICKET_SECONDS = 60
/** From the mint until the bind: the ticket's life, plus the browser's round trips. */
export const BIND_WINDOW_MS = 5 * 60 * 1000
/** Clock skew accepted between Clerk's timestamps and ours. */
export const CLOCK_SKEW_MS = 5 * 1000
/** `requireFreshAuth`: an IdP authentication counts this long (Clerk's `strict` too). */
export const FRESH_WINDOW_MS = 10 * 60 * 1000
/** A step-up's `auth_time` must be this recent: the IdP really asked again. */
export const STEP_UP_MAX_AGE_MS = 5 * 60 * 1000
/** The gate writes `last_seen_at` at most this often per session. */
export const LAST_SEEN_EVERY_MS = 60 * 1000
/** The sweeper's grace for a ticket session to be bound (sso.md 2.2). */
export const SWEEP_AFTER_MS = 2 * 60 * 1000

// ── Secrets ──────────────────────────────────────────────────────────────

/** A fresh secret for the browser: 32 random bytes, base64url. */
export function newSecret(): string {
  return randomBytes(32).toString("base64url")
}

/** What we store for a secret the browser holds. */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex")
}

/** Constant-time comparison of two hex digests. */
export function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex")
  const right = Buffer.from(b, "hex")
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right)
}

/** A secret as received: a base64url string of a sane length, or null. */
export function readSecret(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(value)
    ? value
    : null
}

// ── Domains ──────────────────────────────────────────────────────────────

/**
 * An address as the bridge compares it, or null.
 *
 * ⚠ STRICT, BECAUSE THE DOMAIN DECIDES WHO MAY CLAIM THE ACCOUNT. Exactly one
 * `@`, no whitespace or control characters, and an ASCII domain of plain
 * labels: `a@b@acme.com` or a look-alike Unicode domain never reaches the
 * comparison with a workspace's proved names.
 */
const isControl = (ch: string) => {
  const code = ch.charCodeAt(0)
  return code < 0x20 || code === 0x7f
}

export function normaliseEmail(email: string | null | undefined): string | null {
  if (typeof email !== "string" || email.length > 320) return null
  const trimmed = email.trim().toLowerCase()
  const at = trimmed.indexOf("@")
  if (at <= 0 || at !== trimmed.lastIndexOf("@")) return null
  const local = trimmed.slice(0, at)
  const domain = trimmed.slice(at + 1)
  if (local.length > 64 || /\s/.test(local) || [...local].some(isControl)) return null
  if (
    !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/.test(
      domain,
    )
  )
    return null
  return trimmed
}

export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1)
}

/**
 * Whether an address is on one of the connection's live domains.
 *
 * ⚠ EXACT NAMES ONLY, NOT SUBDOMAINS. A proof of `acme.com` says nothing about
 * who runs `mail.acme.com`'s users, and a connection that claims accounts by
 * domain must not reach further than what was proved. Clerk's own SSO does
 * the same by default. A subdomain is its own access domain, proved on its own.
 */
export function onLiveDomain(email: string, live: readonly string[]): boolean {
  const domain = emailDomain(email)
  return live.some((name) => name === domain)
}

// ── MFA ──────────────────────────────────────────────────────────────────

/**
 * RFC 8176 values that mean a factor beyond a password. `mfa` itself, or any
 * one of these alongside the first factor.
 */
const SECOND_FACTORS = new Set([
  "mfa",
  "otp",
  "hwk",
  "swk",
  "sms",
  "fpt",
  "face",
  "iris",
  "retina",
  "vbm",
  "tel",
])

/** Whether the IdP says it asked for more than one factor. */
export function provedMfa(amr: readonly string[] | undefined): boolean {
  return (amr ?? []).some((value) => SECOND_FACTORS.has(value.toLowerCase()))
}

/**
 * Whether an assertion proves MFA: by `amr`, or by an `acr` the engine found
 * on the connection's own list (`mfaByAcr`). An `acr` means only what the IdP
 * says it means, so no value is trusted unless an admin listed it.
 */
export function assertionProvesMfa(
  assertion: Pick<Assertion, "amr" | "mfaByAcr">,
): boolean {
  return provedMfa(assertion.amr) || assertion.mfaByAcr === true
}

// ── Refusals ─────────────────────────────────────────────────────────────

/** Why a login was refused: recorded on the attempt and in the audit log. */
export type Refusal =
  | "attempt_unknown"
  | "attempt_expired"
  | "attempt_used"
  | "wrong_browser"
  | "connection_inactive"
  | "mfa_required"
  | "no_email"
  | "email_unverified"
  | "domain_not_verified"
  | "managed_elsewhere"
  | "already_linked"
  | "no_account"
  | "ambiguous_account"
  | "account_banned"
  | "blocked"
  | "workspace_full"
  | "workspace_gone"
  | "step_up_mismatch"
  | "step_up_stale"
  | "engine_disabled"
  | "engine_mismatch"
  | "role_exempt"
  /** The IdP answered the redirect with `error=` instead of a code (#338). */
  | "idp_error"
  /** The engine could not verify the IdP's response: signature, iss, aud, exp, nonce, PKCE. */
  | "invalid_response"
  /** Google: no `hd` claim (a consumer account) or one the workspace has not verified. */
  | "hosted_domain"
  /**
   * JIT (#341) into a full workspace (#327): the person exists now and their
   * request is on the waiting list, but they are not in yet.
   */
  | "waiting_list"
  /**
   * JIT (#341): Clerk would not create the person because the IdP left out
   * something the instance requires of every user (a first or last name).
   * The admin maps the claim; nobody is made up from the address.
   */
  | "profile_incomplete"
  /**
   * Their company's directory (SCIM, #342) has switched them off: nobody
   * signs a person back in, claims them by address or makes them again by JIT
   * while the directory that deactivated them still says so.
   */
  | "deprovisioned"

/** What the person is told. Never which check failed in detail. */
export function refusalMessage(reason: Refusal): string {
  switch (reason) {
    case "attempt_unknown":
    case "attempt_expired":
    case "attempt_used":
    case "wrong_browser":
      return "This sign-in has expired. Start again."
    case "mfa_required":
      return "Your company requires multi-factor sign-in. Sign in again with it."
    case "no_account":
      return "There is no i10 account for you yet. Ask your administrator."
    case "workspace_full":
      return "This workspace has no free seats. Ask your administrator."
    case "waiting_list":
      return "This workspace is full right now. We've asked its admins to add you."
    case "profile_incomplete":
      return "Your identity provider did not send your name. Ask your administrator."
    case "deprovisioned":
      return "Your administrator has removed your access."
    case "blocked":
    case "account_banned":
      return "Your administrator has not allowed this account."
    case "role_exempt":
      return "Workspace owners and admins sign in with their own passkey or password, not SSO."
    case "idp_error":
      return "Your company's sign-in did not finish. Start again, or ask your administrator."
    case "hosted_domain":
      return "Sign in with your company's Google Workspace account, not a personal one."
    default:
      return "We could not sign you in with your company's SSO. Ask your administrator."
  }
}

// ── Sessions ─────────────────────────────────────────────────────────────

export interface BoundSession {
  sessionId: string
  clerkUserId: string
  connectionId: string
  boundAt: Date
  freshAt: Date
  lastSeenAt: Date
  revokedAt: Date | null
}

export interface SessionPolicy {
  maxSessionSeconds: number | null
  idleTimeoutSeconds: number | null
}

/**
 * A bound session against its connection's policy.
 *
 * ⚠ MEASURED FROM THE BIND, NOT FROM CLERK'S SESSION. The bind is when we
 * knew the IdP had said yes; a Clerk session cannot be older than its bind by
 * more than the bind window.
 */
export function sessionVerdict(
  session: Pick<BoundSession, "boundAt" | "lastSeenAt">,
  policy: SessionPolicy,
  now: Date,
): "ok" | "max_age" | "idle" {
  const t = now.getTime()
  if (
    policy.maxSessionSeconds !== null &&
    t - session.boundAt.getTime() > policy.maxSessionSeconds * 1000
  )
    return "max_age"
  if (
    policy.idleTimeoutSeconds !== null &&
    t - session.lastSeenAt.getTime() > policy.idleTimeoutSeconds * 1000
  )
    return "idle"
  return "ok"
}

/** Whether the gate should write `last_seen_at` now. */
export function needsTouch(lastSeenAt: Date, now: Date): boolean {
  return now.getTime() - lastSeenAt.getTime() >= LAST_SEEN_EVERY_MS
}

/** Whether an IdP authentication at `freshAt` still counts for step-up. */
export function isFresh(freshAt: Date | null, now: Date): boolean {
  if (!freshAt) return false
  const age = now.getTime() - freshAt.getTime()
  return age >= -CLOCK_SKEW_MS && age <= FRESH_WINDOW_MS
}

// ── Return paths ─────────────────────────────────────────────────────────

/**
 * A `returnTo` we will send a browser to after sign-in: a URL on one of our
 * own origins, or null.
 *
 * ⚠ AN OPEN REDIRECT IS A PHISHING KIT. Anything off our origins, any scheme
 * but https (http only for `.localhost` development hosts), anything with
 * credentials in it, is dropped, and the caller falls back to its default.
 */
export function safeReturnTo(
  value: unknown,
  origins: readonly string[],
): string | null {
  if (typeof value !== "string" || value.length > 2048) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.username || url.password) return null
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && url.hostname.endsWith(".localhost"))
  )
    return null
  return origins.includes(url.origin) ? url.href : null
}
