import { describe, expect, it, vi } from "vitest"
import {
  cacheKeyFor,
  hashKey,
  hashesEqual,
  mintKey,
  prefixOf,
  verifyApiKey,
  type KeyCache,
  type KeyRow,
  type VerifyDeps,
} from "../src/auth/api-key.js"

/**
 * ⚠ THESE USED TO ASSERT A WRAPPING THAT NO LONGER EXISTS. Clerk owned the
 * secret and published no way to change its `ak_` prefix, so every key was
 * rewritten to `i10_live_…` on the way out and stripped on the way back — and
 * because both our prefixes are nine characters, the two variants unwrapped to
 * ONE Clerk secret. That is why the mode had to come from Clerk's claims and
 * never from the string a caller sent.
 *
 * Self-issued, the whole key including its prefix is hashed, so `i10_live_X`
 * and `i10_test_X` are different credentials that match different rows. The
 * hazard is gone rather than guarded, which is why the tests guarding it are.
 */

const TENANT = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6071"
const KEY_ID = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6072"

const row = (over: Partial<KeyRow> = {}): KeyRow => ({
  id: KEY_ID,
  tenantId: TENANT,
  scopes: [],
  mode: "live",
  revokedAt: null,
  expiresAt: null,
  ...over,
})

function fakeCache() {
  const store = new Map<string, string>()
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => {
      store.set(k, v)
    },
    del: async (k: string) => {
      store.delete(k)
    },
  } satisfies KeyCache & { store: Map<string, string> }
}

const deps = (
  byHash: (hash: string) => Promise<KeyRow | null>,
  over: Partial<VerifyDeps> = {},
): VerifyDeps & { cache: ReturnType<typeof fakeCache> } => {
  const cache = fakeCache()
  return { ...{ lookup: { byHash }, ttlSeconds: 60 }, ...over, cache }
}

describe("minting", () => {
  it("produces a key of our own format", () => {
    expect(mintKey("live").secret).toMatch(/^i10_live_[A-Za-z0-9_-]{16,512}$/)
    expect(mintKey("test").secret).toMatch(/^i10_test_[A-Za-z0-9_-]{16,512}$/)
  })

  /**
   * ⚠ THE ASSERTION THAT REPLACES "strips both prefixes to one identical
   * secret". That test existed because the old scheme made `i10_live_X` and
   * `i10_test_X` the same credential wearing two labels, so the string could
   * never be trusted to say which it was. Now they hash differently, so the
   * mode is simply a property of the row that matched.
   */
  it("gives live and test keys different hashes for the same body", () => {
    const body = "AAAAAAAAAAAAAAAAAAAAAAAA"
    expect(hashKey(`i10_live_${body}`)).not.toBe(hashKey(`i10_test_${body}`))
  })

  // ⚠ 32 bytes from a CSPRNG. Two mints colliding would mean the generator is
  // not one, which is the failure that makes every other guarantee void.
  it("does not repeat itself", () => {
    const seen = new Set(Array.from({ length: 200 }, () => mintKey("live").secret))
    expect(seen.size).toBe(200)
  })

  it("never stores the secret in what it hands back for persistence", () => {
    const minted = mintKey("live")
    expect(minted.secretHash).toBe(hashKey(minted.secret))
    expect(minted.secretHash).not.toContain(minted.secret)
  })
})

describe("the displayed prefix", () => {
  // Enough to tell two keys apart in a dashboard; nowhere near enough to use.
  it("is the literal prefix plus eight characters", () => {
    const key = "i10_live_abcdefghijklmnop"
    expect(prefixOf(key)).toBe("i10_live_abcdefgh")
  })

  /**
   * ⚠ THE LITERAL PREFIX IS THE HALF THAT MATTERS FOR LEAK SCANNING. Showing
   * only secret characters would identify a key to its owner and to nobody
   * grepping repositories or logs for one.
   */
  it("keeps the literal prefix so a leak scan can grep for it", () => {
    expect(prefixOf(mintKey("live").secret).startsWith("i10_live_")).toBe(true)
    expect(prefixOf(mintKey("test").secret).startsWith("i10_test_")).toBe(true)
  })

  it("refuses anything that is not one of ours", () => {
    expect(() => prefixOf("sk_live_whatever")).toThrow(/not an i10 key/)
  })
})

describe("the cache key", () => {
  /**
   * ⚠ DERIVED FROM THE HASH, WHICH IS WHAT MAKES REVOCATION IMMEDIATE. A route
   * revoking a key holds its ROW — never the secret, which nothing stores — so
   * a cache keyed on the plaintext could not be evicted at that moment, and
   * "instant revocation" would silently mean "within the TTL".
   */
  it("is computable from the stored hash alone", () => {
    const minted = mintKey("live")
    expect(cacheKeyFor(minted.secretHash)).toBe(cacheKeyFor(hashKey(minted.secret)))
  })

  it("never contains the secret", () => {
    const minted = mintKey("live")
    expect(cacheKeyFor(minted.secretHash)).not.toContain(minted.secret)
  })
})

describe("verification", () => {
  it("resolves the tenant and our own key id", async () => {
    const key = mintKey("live")
    const d = deps(async () => row())

    const outcome = await verifyApiKey(key.secret, d)

    expect(outcome).toEqual({
      status: "verified",
      key: { apiKeyId: KEY_ID, tenantId: TENANT, scopes: [], mode: "live" },
    })
  })

  // ⚠ The row decides, not the string. A caller cannot edit `test` into `live`
  // because the hash would no longer match any row at all.
  it("takes the mode from the row", async () => {
    const outcome = await verifyApiKey(
      mintKey("test").secret,
      deps(async () => row({ mode: "test" })),
    )
    expect(outcome.status === "verified" && outcome.key.mode).toBe("test")
  })

  it("never touches the database for a malformed key", async () => {
    const byHash = vi.fn(async () => row())
    const outcome = await verifyApiKey("nope", deps(byHash))

    expect(outcome).toEqual({ status: "rejected", reason: "malformed key" })
    expect(byHash).not.toHaveBeenCalled()
  })

  it("serves the second call from cache", async () => {
    const key = mintKey("live")
    const byHash = vi.fn(async () => row())
    const d = deps(byHash)

    await verifyApiKey(key.secret, d)
    await verifyApiKey(key.secret, d)

    expect(byHash).toHaveBeenCalledTimes(1)
  })

  it("does not cache a rejection", async () => {
    const key = mintKey("live")
    const byHash = vi.fn(async () => null)
    const d = deps(byHash)

    await verifyApiKey(key.secret, d)
    await verifyApiKey(key.secret, d)

    expect(byHash).toHaveBeenCalledTimes(2)
    expect(d.cache.store.size).toBe(0)
  })

  it("stores the resolved key under the hash, so the secret never reaches Redis", async () => {
    const key = mintKey("live")
    const d = deps(async () => row())
    await verifyApiKey(key.secret, d)

    expect([...d.cache.store.keys()]).toEqual([cacheKeyFor(hashKey(key.secret))])
    expect(JSON.stringify([...d.cache.store.values()])).not.toContain(key.secret)
  })
})

describe("keys that exist but must not work", () => {
  /**
   * ⚠ REVOKED IS `rejected`, NOT `unavailable`, AND THE LOOKUP MUST STILL
   * RETURN THE ROW. A store that filtered revoked keys out would make
   * "withdrawn" and "never existed" indistinguishable here — different things
   * to log after a leak.
   */
  it("rejects a revoked key and says so", async () => {
    const outcome = await verifyApiKey(
      mintKey("live").secret,
      deps(async () => row({ revokedAt: new Date("2026-09-08T10:00:00Z") })),
    )
    expect(outcome).toEqual({ status: "rejected", reason: "key revoked" })
  })

  it("rejects an expired key", async () => {
    const outcome = await verifyApiKey(
      mintKey("live").secret,
      deps(async () => row({ expiresAt: new Date("2026-09-07T00:00:00Z") }), {
        now: () => new Date("2026-09-08T00:00:00Z"),
      }),
    )
    expect(outcome).toEqual({ status: "rejected", reason: "key expired" })
  })

  it("accepts a key whose expiry has not arrived", async () => {
    const outcome = await verifyApiKey(
      mintKey("live").secret,
      deps(async () => row({ expiresAt: new Date("2026-09-09T00:00:00Z") }), {
        now: () => new Date("2026-09-08T00:00:00Z"),
      }),
    )
    expect(outcome.status).toBe("verified")
  })

  /**
   * ⚠ A ROW WE CANNOT READ IS OUR FAULT, SO IT IS NOT A 401. Telling a customer
   * their key is invalid when our own column is malformed sends them to rotate
   * a key that was fine.
   */
  it("reports our own bad data as unavailable, never as a bad key", async () => {
    const outcome = await verifyApiKey(
      mintKey("live").secret,
      deps(async () => row({ mode: "staging" })),
    )
    expect(outcome.status).toBe("unavailable")
  })
})

describe("when the dependency underneath is broken", () => {
  /**
   * ⚠ THE DISTINCTION SURVIVED THE MOVE OFF CLERK, ONLY THE FAILING THING
   * CHANGED. This used to mean "Clerk did not answer"; it now means "Postgres
   * did not answer". Collapsing it into a 401 tells a customer their key is
   * wrong during an outage that was never theirs — the same rule authd follows
   * answering LDAP `unavailable` rather than `invalidCredentials`.
   */
  it("reports a database failure as unavailable", async () => {
    const outcome = await verifyApiKey(
      mintKey("live").secret,
      deps(async () => {
        throw new Error("connection refused")
      }),
    )
    expect(outcome).toEqual({ status: "unavailable", reason: "connection refused" })
  })

  // Redis being down is a reason to ask Postgres, never a reason to refuse.
  it("falls through to the database when the cache throws", async () => {
    const key = mintKey("live")
    const cache: KeyCache = {
      get: async () => {
        throw new Error("redis down")
      },
      set: async () => {
        throw new Error("redis down")
      },
      del: async () => {
        throw new Error("redis down")
      },
    }

    const outcome = await verifyApiKey(key.secret, {
      lookup: { byHash: async () => row() },
      cache,
      ttlSeconds: 60,
    })

    expect(outcome.status).toBe("verified")
  })

  it("treats a corrupt cache entry as a miss", async () => {
    const key = mintKey("live")
    const d = deps(async () => row())
    d.cache.store.set(cacheKeyFor(hashKey(key.secret)), "{not json")

    expect((await verifyApiKey(key.secret, d)).status).toBe("verified")
  })
})

describe("comparing hashes", () => {
  it("matches equal hashes and rejects different ones", () => {
    const a = hashKey("i10_live_aaaaaaaaaaaaaaaa")
    const b = hashKey("i10_live_bbbbbbbbbbbbbbbb")
    expect(hashesEqual(a, a)).toBe(true)
    expect(hashesEqual(a, b)).toBe(false)
  })

  // timingSafeEqual throws on a length mismatch rather than returning false.
  it("does not throw on different lengths", () => {
    expect(hashesEqual("abc", "abcd")).toBe(false)
  })
})
