import type { APIKey } from "@clerk/backend"
import { describe, expect, it, vi } from "vitest"
import {
  cacheKeyFor,
  unwrapKey,
  verifyApiKey,
  wrapSecret,
  type KeyCache,
} from "../src/auth/api-key.js"

const SECRET = "ak_abcdefghijklmnopqrstuvwxyz012345"
const LIVE = "i10_live_abcdefghijklmnopqrstuvwxyz012345"

function clerkKey(over: Partial<APIKey> = {}): APIKey {
  return {
    id: "ak_id_1",
    type: "api_key",
    name: "prod",
    subject: "org_123",
    scopes: ["emails:send"],
    claims: { tenantId: "ten-1", mode: "live" },
    revoked: false,
    revocationReason: null,
    expired: false,
    expiration: null,
    createdBy: null,
    description: null,
    lastUsedAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  } as APIKey
}

function memoryCache(): KeyCache & { store: Map<string, string> } {
  const store = new Map<string, string>()
  return {
    store,
    get: async (k) => store.get(k) ?? null,
    set: async (k, v) => void store.set(k, v),
  }
}

const httpError = (status: number) => Object.assign(new Error("clerk"), { status })

describe("the wrapping", () => {
  it("rewrites Clerk's prefix as ours, reversibly", () => {
    expect(wrapSecret(SECRET, "live")).toBe(LIVE)
    expect(unwrapKey(LIVE)).toBe(SECRET)
  })

  it("refuses to mint a key it could not unwrap", () => {
    expect(() => wrapSecret("sk_something", "live")).toThrow(/does not start with/)
  })

  // ⚠ THE TRAP. Both prefixes are nine characters, so these strip to the same
  // secret. Nothing may read the mode off the string — it comes from Clerk's
  // claims, or a customer promotes a test key by editing one character.
  it("strips both prefixes to one identical secret", () => {
    expect(unwrapKey("i10_test_abcdefghijklmnopqrstuvwxyz012345")).toBe(unwrapKey(LIVE))
  })

  it.each([
    ["a bare Clerk secret", SECRET],
    ["someone else's prefix", "sk_live_abcdefghijklmnopqrstuvwx"],
    ["too short a body", "i10_live_abc"],
    ["an invalid character", "i10_live_abcdefghijklmnop!!!!!!!!"],
    ["empty", ""],
  ])("does not unwrap %s", (_label, input) => {
    expect(unwrapKey(input)).toBeNull()
  })

  it("hashes the key for the cache, so the secret never reaches Redis", () => {
    const cacheKey = cacheKeyFor(LIVE)
    expect(cacheKey).toMatch(/^apikey:[0-9a-f]{64}$/)
    expect(cacheKey).not.toContain("abcdefghij")
  })
})

describe("verification", () => {
  it("resolves the tenant from Clerk's claims, not from the prefix", async () => {
    const verify = vi.fn().mockResolvedValue(clerkKey())
    const result = await verifyApiKey(LIVE, {
      verify,
      cache: memoryCache(),
      ttlSeconds: 60,
    })

    expect(verify).toHaveBeenCalledWith(SECRET)
    expect(result).toEqual({
      status: "verified",
      key: {
        apiKeyId: "ak_id_1",
        tenantId: "ten-1",
        scopes: ["emails:send"],
        mode: "live",
      },
    })
  })

  // The whole point of the wrap trap: a key whose string says live but whose
  // claims say test is a TEST key.
  it("takes the mode from the claims even when the prefix disagrees", async () => {
    const verify = vi
      .fn()
      .mockResolvedValue(clerkKey({ claims: { tenantId: "t", mode: "test" } }))
    const result = await verifyApiKey(LIVE, {
      verify,
      cache: memoryCache(),
      ttlSeconds: 60,
    })
    expect(result).toMatchObject({ status: "verified", key: { mode: "test" } })
  })

  it("never asks Clerk about a malformed key", async () => {
    const verify = vi.fn()
    const result = await verifyApiKey("nonsense", {
      verify,
      cache: memoryCache(),
      ttlSeconds: 60,
    })
    expect(verify).not.toHaveBeenCalled()
    expect(result.status).toBe("rejected")
  })

  it("serves the second call from cache", async () => {
    const verify = vi.fn().mockResolvedValue(clerkKey())
    const cache = memoryCache()
    const deps = { verify, cache, ttlSeconds: 60 }

    await verifyApiKey(LIVE, deps)
    const second = await verifyApiKey(LIVE, deps)

    expect(verify).toHaveBeenCalledTimes(1)
    expect(second).toMatchObject({ status: "verified", key: { tenantId: "ten-1" } })
  })

  it("does not cache a rejection", async () => {
    const verify = vi.fn().mockRejectedValue(httpError(404))
    const cache = memoryCache()
    const deps = { verify, cache, ttlSeconds: 60 }

    await verifyApiKey(LIVE, deps)
    await verifyApiKey(LIVE, deps)

    expect(verify).toHaveBeenCalledTimes(2)
    expect(cache.store.size).toBe(0)
  })

  it.each([
    ["revoked", clerkKey({ revoked: true })],
    ["expired", clerkKey({ expired: true })],
  ])("rejects a %s key even though verify() resolved", async (_label, key) => {
    const result = await verifyApiKey(LIVE, {
      verify: vi.fn().mockResolvedValue(key),
      cache: memoryCache(),
      ttlSeconds: 60,
    })
    expect(result.status).toBe("rejected")
  })

  // ⚠ The one that matters. Reporting `rejected` during a Clerk outage tells
  // every customer their key is wrong, and they respond by rotating keys that
  // were fine.
  it.each([
    ["a transport failure", new Error("ECONNREFUSED")],
    ["a 500", httpError(500)],
    ["a 503", httpError(503)],
    ["a 429", httpError(429)],
  ])("reports unavailable, not rejected, for %s", async (_label, error) => {
    const result = await verifyApiKey(LIVE, {
      verify: vi.fn().mockRejectedValue(error),
      cache: memoryCache(),
      ttlSeconds: 60,
    })
    expect(result.status).toBe("unavailable")
  })

  it.each([[401], [403], [404], [422]])("rejects on a %i", async (status) => {
    const result = await verifyApiKey(LIVE, {
      verify: vi.fn().mockRejectedValue(httpError(status)),
      cache: memoryCache(),
      ttlSeconds: 60,
    })
    expect(result.status).toBe("rejected")
  })

  // Our data is wrong, not the customer's key, so it must not read as a 401.
  it.each([
    ["no claims at all", clerkKey({ claims: null })],
    ["no tenant", clerkKey({ claims: { mode: "live" } })],
    ["an unknown mode", clerkKey({ claims: { tenantId: "t", mode: "staging" } })],
  ])("reports unavailable when the key carries %s", async (_label, key) => {
    const result = await verifyApiKey(LIVE, {
      verify: vi.fn().mockResolvedValue(key),
      cache: memoryCache(),
      ttlSeconds: 60,
    })
    expect(result.status).toBe("unavailable")
  })
})

describe("when Redis is the thing that is broken", () => {
  const broken: KeyCache = {
    get: async () => {
      throw new Error("redis down")
    },
    set: async () => {
      throw new Error("redis down")
    },
  }

  // Redis being down is a reason to ask Clerk, never a reason to refuse a
  // customer — the cache is an optimisation, not a dependency.
  it("falls through to Clerk and still succeeds", async () => {
    const result = await verifyApiKey(LIVE, {
      verify: vi.fn().mockResolvedValue(clerkKey()),
      cache: broken,
      ttlSeconds: 60,
    })
    expect(result).toMatchObject({ status: "verified" })
  })

  it("treats a corrupt cache entry as a miss", async () => {
    const cache = memoryCache()
    cache.store.set(cacheKeyFor(LIVE), "{not json")
    const verify = vi.fn().mockResolvedValue(clerkKey())

    const result = await verifyApiKey(LIVE, { verify, cache, ttlSeconds: 60 })

    expect(verify).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ status: "verified" })
  })
})
