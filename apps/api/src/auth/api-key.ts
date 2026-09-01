import { createHash } from "node:crypto"
import type { APIKey } from "@clerk/backend"

/**
 * Customer-facing API keys.
 *
 * Clerk issues and verifies them; the format is ours. `apiKeys.create()` returns
 * a secret shaped `ak_…`, and Clerk publishes no way to change that prefix — so
 * the key a customer holds is that secret rewritten under our own prefix, and
 * the rewrite is reversed before it is handed back to Clerk.
 *
 * ⚠ THE PREFIX IS COSMETIC AND MUST BE TREATED AS SUCH. `i10_live_` and
 * `i10_test_` are the same length, so `i10_live_X` and `i10_test_X` unwrap to
 * one identical Clerk secret. Reading the mode off the string a caller sent
 * would let anyone promote a test key to a live key by editing one character.
 * The mode comes from Clerk's `claims` on the verified key, always.
 */

const CLERK_PREFIX = "ak_"
const OUR_PREFIXES = ["i10_live_", "i10_test_"] as const

/**
 * The shape of a key we will even ask Clerk about.
 *
 * ⚠ THIS IS A COST GATE, NOT A SECURITY CONTROL. Verification is a network call
 * to Clerk, so anything obviously malformed has to be refused here — otherwise
 * a stream of garbage in the Authorization header becomes a stream of billed
 * requests against Clerk, and a way to exhaust our quota from outside.
 */
const KEY_PATTERN = /^i10_(live|test)_[A-Za-z0-9_-]{16,512}$/

export type Mode = "live" | "test"

/** What the rest of the request needs to know about the caller. */
export interface ResolvedKey {
  apiKeyId: string
  tenantId: string
  scopes: readonly string[]
  mode: Mode
}

export type VerifyOutcome =
  /** Clerk answered, and the key is good. */
  | { status: "verified"; key: ResolvedKey }
  /** Clerk answered, and the key is not. Malformed, unknown, revoked, expired. */
  | { status: "rejected"; reason: string }
  /**
   * Clerk did not answer, or answered with a tenant we cannot resolve.
   *
   * ⚠ NEVER COLLAPSE THIS INTO `rejected`. A 401 tells a customer their key is
   * wrong, and the customer's next move is to rotate a key that was fine — the
   * same reasoning that makes services/authd answer LDAP `unavailable` rather
   * than `invalidCredentials` when Clerk is unreachable. An outage must look
   * like an outage.
   */
  | { status: "unavailable"; reason: string }

/** `ak_abc` → `i10_live_abc`. */
export function wrapSecret(clerkSecret: string, mode: Mode): string {
  // ⚠ Assert rather than tolerate. If Clerk ever changes its prefix, minting a
  // key we cannot unwrap produces a credential that authenticates nothing and
  // fails only in the customer's hands. Failing at creation is recoverable.
  if (!clerkSecret.startsWith(CLERK_PREFIX)) {
    throw new Error(
      `Clerk returned a secret that does not start with "${CLERK_PREFIX}"; ` +
        `the wrapping in api-key.ts assumes it does and must be updated.`,
    )
  }
  return `i10_${mode}_${clerkSecret.slice(CLERK_PREFIX.length)}`
}

/**
 * `i10_live_abc` → `ak_abc`, or null if it is not one of ours.
 *
 * Note what this deliberately does NOT return: the mode. Both prefixes are nine
 * characters and strip to the same secret, so the string cannot be evidence of
 * anything but shape.
 */
export function unwrapKey(key: string): string | null {
  if (!KEY_PATTERN.test(key)) return null

  const prefix = OUR_PREFIXES.find((p) => key.startsWith(p))
  if (!prefix) return null

  return CLERK_PREFIX + key.slice(prefix.length)
}

/** The cache key. A hash, so the secret itself never reaches Redis. */
export function cacheKeyFor(key: string): string {
  return `apikey:${createHash("sha256").update(key).digest("hex")}`
}

export interface KeyCache {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlSeconds: number): Promise<void>
}

export interface VerifyDeps {
  /** `clerkClient.apiKeys.verify`, or a fake. */
  verify: (secret: string) => Promise<APIKey>
  cache: KeyCache
  /** Seconds a verified key stays cached. Bounds how long a revocation lags. */
  ttlSeconds: number
}

/**
 * Resolves a customer's key to the tenant behind it.
 *
 * ⚠ ONLY SUCCESSES ARE CACHED. Caching a rejection would mean a key created a
 * moment ago stays refused for the whole TTL because something probed it first
 * — and it would let one bad request poison a good one. The cost of not caching
 * failures is that malformed keys reach Clerk, which is what KEY_PATTERN is for.
 */
export async function verifyApiKey(
  key: string,
  deps: VerifyDeps,
): Promise<VerifyOutcome> {
  const secret = unwrapKey(key)
  if (!secret) return { status: "rejected", reason: "malformed key" }

  const cacheKey = cacheKeyFor(key)

  // A cache read must never be able to fail the request: Redis being down is a
  // reason to ask Clerk, not a reason to refuse a customer.
  let cached: string | null = null
  try {
    cached = await deps.cache.get(cacheKey)
  } catch {
    cached = null
  }
  if (cached) {
    const parsed = parseCached(cached)
    if (parsed) return { status: "verified", key: parsed }
  }

  let verified: APIKey
  try {
    verified = await deps.verify(secret)
  } catch (error) {
    return classify(error)
  }

  // ⚠ Checked even though verify() is documented to throw for these. The flags
  // are on the returned object, so trusting the throw alone makes us depend on
  // undocumented behaviour to refuse a revoked key — which is precisely the
  // check that must not be the one that quietly stops happening.
  if (verified.revoked) return { status: "rejected", reason: "key revoked" }
  if (verified.expired) return { status: "rejected", reason: "key expired" }

  const resolved = resolve(verified)
  if (!resolved) {
    // Clerk knows the key; we cannot map it to a tenant. That is our data being
    // wrong, not the customer's key, so it is not a 401.
    return {
      status: "unavailable",
      reason: `key ${verified.id} carries no usable tenant claim`,
    }
  }

  try {
    await deps.cache.set(cacheKey, JSON.stringify(resolved), deps.ttlSeconds)
  } catch {
    // A cache write that fails costs a Clerk call next time. Nothing more.
  }

  return { status: "verified", key: resolved }
}

/**
 * Reads the tenant and mode off Clerk's `claims`.
 *
 * `subject` is a Clerk user or organization id, and our tenant is neither — it
 * is our own row that may reference either. Stamping `tenantId` into the claims
 * at creation keeps the resolution off the request path entirely, so a send does
 * not pay for a database lookup to learn who is sending.
 */
function resolve(key: APIKey): ResolvedKey | null {
  const claims = key.claims ?? {}
  const tenantId = claims.tenantId
  const mode = claims.mode

  if (typeof tenantId !== "string" || tenantId.length === 0) return null
  if (mode !== "live" && mode !== "test") return null

  return { apiKeyId: key.id, tenantId, scopes: key.scopes ?? [], mode }
}

function parseCached(raw: string): ResolvedKey | null {
  try {
    const value = JSON.parse(raw) as Partial<ResolvedKey>
    if (typeof value.apiKeyId !== "string") return null
    if (typeof value.tenantId !== "string") return null
    if (value.mode !== "live" && value.mode !== "test") return null
    return {
      apiKeyId: value.apiKeyId,
      tenantId: value.tenantId,
      scopes: Array.isArray(value.scopes) ? value.scopes : [],
      mode: value.mode,
    }
  } catch {
    // A malformed cache entry is a cache miss, never an error.
    return null
  }
}

/**
 * Separates "Clerk says no" from "Clerk did not say".
 *
 * The same table as services/authd's Clerk client, for the same reason: a 4xx is
 * an answer about the credential, and everything else is an answer about Clerk.
 */
function classify(error: unknown): VerifyOutcome {
  const status = statusOf(error)

  if (status !== null && status >= 400 && status < 500 && status !== 429) {
    return { status: "rejected", reason: `clerk rejected the key (${status})` }
  }

  return {
    status: "unavailable",
    reason: status === null ? "clerk unreachable" : `clerk returned ${status}`,
  }
}

function statusOf(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null
  const status = (error as { status?: unknown }).status
  return typeof status === "number" ? status : null
}
