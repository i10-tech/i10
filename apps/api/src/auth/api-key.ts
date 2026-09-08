import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

/**
 * Customer-facing API keys. i10 mints them, stores their hashes, and verifies
 * them against its own database.
 *
 * ⚠ CLERK ISSUED THESE UNTIL 2026-09-08, AND REMOVING IT WAS A LATENCY
 * DECISION. `apiKeys.verify()` is a network call, the cache TTL is 60 seconds,
 * and a customer who sends less often than that paid it on essentially every
 * request. Measured on the live API: 1119ms cold against 353ms warm, where an
 * unauthenticated 401 costs 180ms of pure round trip. Roughly 900ms of every
 * cold send was spent asking a third party a question about a row we already
 * owned — more than the SES call it was authenticating.
 *
 * ⚠ AND CLERK WAS NEVER WHAT TIED A KEY TO A TENANT. Its `subject` is a
 * `user_…` or `org_…`; our tenant is neither. This file read `claims.tenantId`
 * — a claim we stamped ourselves at creation — and ignored `subject` entirely.
 * The link was always `core.api_keys.tenant_id`.
 *
 * ⚠ WHAT WENT AWAY WITH IT IS WORTH KNOWING. Clerk publishes no way to change
 * its `ak_` prefix, so keys were rewritten to `i10_live_…` outbound and back
 * inbound — and since both our prefixes are nine characters, `i10_live_X` and
 * `i10_test_X` stripped to ONE Clerk secret. The mode therefore could not be
 * read from the string without letting anyone promote a test key to a live one
 * by editing a character. Hashing the whole key, prefix included, makes those
 * two different credentials and deletes the hazard rather than documenting it.
 *
 * ⚠ CLERK REMAINS THE IDENTITY PROVIDER. Sessions, MFA, organizations, tenant
 * provisioning and the LDAP bind delegation services/authd depends on are all
 * still Clerk's, and none of them are on this path. This is a narrowing of what
 * Clerk is asked to do, not a move away from it.
 */

const OUR_PREFIXES = ["i10_live_", "i10_test_"] as const

/**
 * The shape of a key we will even hash.
 *
 * ⚠ THIS IS NO LONGER A COST GATE, AND IT IS STILL WORTH KEEPING. It existed to
 * stop malformed input becoming billed Clerk requests; there is no third party
 * to bill now. What it still does is keep obviously-wrong input from reaching
 * the database at all, and it documents the format in one place.
 */
const KEY_PATTERN = /^i10_(live|test)_[A-Za-z0-9_-]{16,512}$/

export type Mode = "live" | "test"

/** What the rest of the request needs to know about the caller. */
export interface ResolvedKey {
  /**
   * ⚠ i10'S OWN `core.api_keys.id`, WHERE THIS USED TO BE CLERK'S `ak_…`. It is
   * the value written to `core.messages.api_key_id`, so the send path no longer
   * has to look the row up to attribute a message — see send/accept-db.ts.
   */
  apiKeyId: string
  tenantId: string
  scopes: readonly string[]
  mode: Mode
}

export type VerifyOutcome =
  /** The key matched a live row. */
  | { status: "verified"; key: ResolvedKey }
  /** Malformed, unknown, revoked or expired. */
  | { status: "rejected"; reason: string }
  /**
   * We could not find out.
   *
   * ⚠ STILL HERE, AND STILL NOT COLLAPSIBLE INTO `rejected`, THOUGH THE THING
   * THAT CAN FAIL HAS CHANGED. It used to mean "Clerk did not answer"; it now
   * means "the database did not answer". A 401 tells a customer their key is
   * wrong, and their next move is to rotate a key that was fine — during an
   * outage that was never theirs. Same rule as services/authd answering LDAP
   * `unavailable` rather than `invalidCredentials`.
   */
  | { status: "unavailable"; reason: string }

/**
 * A new key: what the customer sees, and what we keep.
 *
 * ⚠ `secret` IS RETURNED EXACTLY ONCE AND IS NOT RECOVERABLE. Nothing stores it,
 * nothing logs it, and there is no endpoint that reads it back. A customer who
 * loses it rotates.
 */
export interface MintedKey {
  secret: string
  secretHash: string
  prefix: string
  mode: Mode
}

/**
 * ⚠ 32 BYTES FROM A CSPRNG, AND EVERY WORD OF THAT MATTERS. `randomBytes` is
 * the cryptographic generator; `Math.random` is a predictable PRNG and using it
 * here would make keys guessable from one another. 256 bits is far past any
 * brute-force concern and is what makes the fast hash below correct.
 *
 * ⚠ `base64url`, NOT `base64` OR `hex`. Base64url's alphabet is exactly the one
 * KEY_PATTERN accepts and is safe in a header, a URL and a shell; plain base64
 * emits `+` and `/`, which are neither. Hex would need 64 characters to carry
 * the same entropy.
 */
export function mintKey(mode: Mode): MintedKey {
  const secret = `i10_${mode}_${randomBytes(32).toString("base64url")}`

  return {
    secret,
    secretHash: hashKey(secret),
    prefix: prefixOf(secret),
    mode,
  }
}

/**
 * SHA-256 of the whole key.
 *
 * ⚠ SHA-256 RATHER THAN bcrypt OR argon2, AND A REVIEWER SHOULD EXPECT TO
 * FLINCH AT THAT. Slow hashes exist because passwords are low-entropy and worth
 * guessing. This input is 256 random bits: there is nothing to guess, and a
 * deliberately slow hash would move the very latency this file exists to remove
 * from the network onto the CPU of every request. Fast hashing of high-entropy
 * secrets is the correct and conventional choice.
 *
 * ⚠ AND IT COVERS THE PREFIX. That is what makes `i10_live_X` and `i10_test_X`
 * two different credentials instead of one wearing two labels.
 */
export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex")
}

/**
 * The part shown in the dashboard: `i10_live_a1b2c3d4`.
 *
 * ⚠ EIGHT CHARACTERS OF A 256-BIT SECRET, WHICH LEAVES ABOUT 208 BITS. Stored
 * in the clear, so a database read hands them over — irrelevant at this
 * entropy, and it stops being irrelevant the moment anybody shortens the
 * secret. Shorten one and not the other and this becomes a real disclosure.
 *
 * ⚠ THE LITERAL PREFIX IS THE HALF THAT EARNS ITS KEEP. `i10_live_` is what
 * makes a leaked key findable by grepping repositories, logs and paste sites —
 * showing only secret characters would identify a key to its owner and to
 * nobody scanning for one.
 */
export function prefixOf(key: string): string {
  const prefix = OUR_PREFIXES.find((p) => key.startsWith(p))
  if (!prefix) throw new Error("not an i10 key")
  return key.slice(0, prefix.length + 8)
}

/** The row as the database hands it back. */
export interface KeyRow {
  id: string
  tenantId: string
  scopes: readonly string[]
  mode: string
  revokedAt: Date | null
  expiresAt: Date | null
}

export interface KeyLookup {
  /**
   * Resolves a hash to its row, or null.
   *
   * ⚠ IT MUST NOT FILTER OUT REVOKED OR EXPIRED KEYS. Returning null for those
   * makes "withdrawn" and "never existed" indistinguishable here, and they are
   * different things to log after a leak.
   */
  byHash(hash: string): Promise<KeyRow | null>
}

export interface KeyCache {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlSeconds: number): Promise<void>
  del(key: string): Promise<void>
}

export interface VerifyDeps {
  lookup: KeyLookup
  cache: KeyCache
  /** Seconds a verified key stays cached. */
  ttlSeconds: number
  now?: () => Date
}

/**
 * The cache key.
 *
 * ⚠ DERIVED FROM THE HASH, NOT FROM THE PLAINTEXT, AND THIS IS WHAT MAKES
 * REVOCATION IMMEDIATE. Revocation happens in a route that has the key's ROW —
 * its id and its `secret_hash` — and never the secret itself, which nothing
 * stores. Keying the cache on the plaintext would leave no way to evict the
 * entry at that moment, and "instant revocation" would quietly mean "within the
 * TTL", which is the exact behaviour this change set out to remove.
 */
export function cacheKeyFor(secretHash: string): string {
  return `apikey:${secretHash}`
}

/**
 * Resolves a presented key to the tenant behind it.
 *
 * ⚠ ONLY SUCCESSES ARE CACHED. Caching a rejection would keep a key created a
 * moment ago refused for the whole TTL because something probed it first, and
 * would let one bad request poison a good one.
 */
export async function verifyApiKey(
  presented: string,
  deps: VerifyDeps,
): Promise<VerifyOutcome> {
  if (!KEY_PATTERN.test(presented)) {
    return { status: "rejected", reason: "malformed key" }
  }

  const hash = hashKey(presented)
  const cacheKey = cacheKeyFor(hash)

  // A cache read must never fail the request: Redis being down is a reason to
  // ask Postgres, not a reason to refuse a customer.
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

  let row: KeyRow | null
  try {
    row = await deps.lookup.byHash(hash)
  } catch (error) {
    return {
      status: "unavailable",
      reason: error instanceof Error ? error.message : "lookup failed",
    }
  }

  if (!row) return { status: "rejected", reason: "unknown key" }
  if (row.revokedAt) return { status: "rejected", reason: "key revoked" }

  const now = (deps.now ?? (() => new Date()))()
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) {
    return { status: "rejected", reason: "key expired" }
  }

  if (row.mode !== "live" && row.mode !== "test") {
    // Our own data is wrong, not the customer's key. Not a 401.
    return { status: "unavailable", reason: `key ${row.id} has mode ${row.mode}` }
  }

  const resolved: ResolvedKey = {
    apiKeyId: row.id,
    tenantId: row.tenantId,
    scopes: row.scopes,
    mode: row.mode,
  }

  try {
    await deps.cache.set(cacheKey, JSON.stringify(resolved), deps.ttlSeconds)
  } catch {
    // A cache write that fails costs one database lookup next time. Nothing more.
  }

  return { status: "verified", key: resolved }
}

/**
 * ⚠ CONSTANT-TIME, THOUGH THE LOOKUP ABOVE DOES NOT NEED IT. Exported for
 * comparing two hashes where one came from a request — rotation confirming a
 * caller holds the key it is replacing, say. Timing-safe comparison of the HASH
 * is free; comparing secrets themselves is what this exists to avoid.
 */
export function hashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
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
