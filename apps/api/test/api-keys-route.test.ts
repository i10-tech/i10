import { describe, expect, it, mock } from "bun:test"
import { createApp } from "../src/app.js"
import { cacheKeyFor } from "../src/auth/api-key.js"
import type { CreatedKey, KeyStore, KeySummary } from "../src/auth/store.js"

const KEY = "i10_live_abcdefghijklmnopqrstuvwxyz012345"
const TENANT = "ten-1"

const apiKeyAuth = {
  lookup: {
    byHash: async () => ({
      id: "key-1",
      tenantId: TENANT,
      scopes: [],
      mode: "live",
      revokedAt: null,
      expiresAt: null,
    }),
  },
  cache: { get: async () => null, set: async () => {}, del: async () => {} },
  ttlSeconds: 60,
}

const summary = (over: Partial<KeySummary> = {}): KeySummary => ({
  id: "key-2",
  name: "production",
  prefix: "i10_live_abcdefgh",
  mode: "live",
  scopes: [],
  createdAt: new Date("2026-09-08T10:00:00Z"),
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
  ...over,
})

const created = (over: Partial<CreatedKey> = {}): CreatedKey => ({
  ...summary(),
  secret: "i10_live_THESECRETVALUE0000000000000000",
  ...over,
})

function harness(
  store: Partial<KeyStore> = {},
  cache: Partial<typeof apiKeyAuth.cache> = {},
) {
  const del = mock(async () => {})
  const log = { error: mock() }
  const app = createApp({
    apiKeyAuth,
    apiKeys: {
      store: {
        create: async () => created(),
        list: async () => [summary()],
        revoke: async () => ({ secretHash: "OLDHASH" }),
        rotate: async () => ({ created: created(), revokedHash: "OLDHASH" }),
        ...store,
      },
      cache: { get: async () => null, set: async () => {}, del, ...cache },
      log,
    },
  })

  const call = (path: string, init: RequestInit = {}) =>
    app.request(`/api-keys${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${KEY}`, ...(init.headers ?? {}) },
    })

  return { call, del, log }
}

describe("authentication", () => {
  // These routes cannot mint a tenant's FIRST key — reaching them needs one.
  // See routes/api-keys.ts; closing that needs console session auth.
  it("refuses an unauthenticated caller", async () => {
    const { call } = harness()
    const res = await call("", { headers: { Authorization: "" } })
    expect(res.status).toBe(401)
  })
})

describe("creating", () => {
  /**
   * ⚠ THE ONLY RESPONSE IN THE API THAT CARRIES A CREDENTIAL, AND THE ONLY TIME
   * IT IS EVER RETURNED. Nothing stores the plaintext — only its SHA-256 — so
   * there is deliberately no endpoint that reads one back. A customer who loses
   * a key rotates it.
   */
  it("returns the secret exactly once, on creation", async () => {
    const { call } = harness()
    const res = await call("", {
      method: "POST",
      body: JSON.stringify({ name: "production" }),
    })

    expect(res.status).toBe(201)
    expect(((await res.json()) as { secret: string }).secret).toBe(
      "i10_live_THESECRETVALUE0000000000000000",
    )
  })

  it("defaults to a live key", async () => {
    const create = mock<KeyStore["create"]>(async () => created())
    const { call } = harness({ create })
    await call("", { method: "POST", body: JSON.stringify({ name: "p" }) })
    expect(create.mock.calls[0]?.[0].mode).toBe("live")
  })

  it("refuses a mode that is neither live nor test", async () => {
    const { call } = harness()
    const res = await call("", {
      method: "POST",
      body: JSON.stringify({ name: "p", mode: "staging" }),
    })
    expect(res.status).toBe(422)
  })

  it("refuses a key with no name", async () => {
    const { call } = harness()
    const res = await call("", { method: "POST", body: JSON.stringify({ name: "  " }) })
    expect(res.status).toBe(422)
  })

  // ⚠ The caller names the key; the TENANT comes from the credential that
  // authenticated the request and can never be supplied in the body.
  it("takes the tenant from the caller, never from the body", async () => {
    const create = mock<KeyStore["create"]>(async () => created())
    const { call } = harness({ create })
    await call("", {
      method: "POST",
      body: JSON.stringify({ name: "p", tenantId: "somebody-else" }),
    })
    expect(create.mock.calls[0]?.[0].tenantId).toBe(TENANT)
  })
})

describe("listing", () => {
  /**
   * ⚠ THE ASSERTION WORTH HAVING. A list endpoint that leaked secrets would
   * turn one compromised session into every key the tenant owns, and it is the
   * kind of regression a careless `...row` spread introduces silently.
   */
  it("never returns a secret", async () => {
    const { call } = harness()
    const body = await (await call("")).text()

    expect(body).toContain("i10_live_abcdefgh")
    expect(body).not.toContain("THESECRETVALUE")
    expect(body).not.toContain("secret")
  })
})

describe("revoking", () => {
  /**
   * ⚠ THE ROW IS ONLY HALF OF A REVOCATION. A verified key lives in Redis for
   * the TTL, so without evicting that entry the key keeps working for up to a
   * minute after the customer was told it was dead — which is the exact floor
   * that self-issuing these keys existed to remove.
   */
  it("evicts the cache entry, keyed by the stored hash", async () => {
    const { call, del } = harness()
    const res = await call("/key-2", { method: "DELETE" })

    expect(res.status).toBe(204)
    expect(del).toHaveBeenCalledTimes(1)
    expect(del).toHaveBeenCalledWith(cacheKeyFor("OLDHASH"))
  })

  /**
   * ⚠ A FAILED EVICTION IS A 500, NOT A QUIET SUCCESS. Reporting success while
   * a leaked credential is still live is the worst answer available: the
   * customer stops looking. The row stays revoked, so a retry converges.
   */
  it("reports a failed eviction rather than claiming success", async () => {
    const { call, log } = harness(
      {},
      {
        del: async () => {
          throw new Error("redis down")
        },
      },
    )

    const res = await call("/key-2", { method: "DELETE" })
    expect(res.status).toBe(500)
    expect(log.error).toHaveBeenCalled()
  })

  // Already revoked and belonging to another tenant are one answer on purpose:
  // telling them apart reveals whether somebody else holds that id.
  it("answers 404 for a key that is not revocable", async () => {
    const { call } = harness({ revoke: async () => null })
    expect((await call("/key-2", { method: "DELETE" })).status).toBe(404)
  })
})

describe("rotating", () => {
  it("returns the replacement and evicts the old entry", async () => {
    const { call, del } = harness()
    const res = await call("/key-2/rotate", { method: "POST" })

    expect(res.status).toBe(200)
    expect(((await res.json()) as { secret: string }).secret).toBe(
      "i10_live_THESECRETVALUE0000000000000000",
    )
    expect(del).toHaveBeenCalledTimes(1)
    expect(del).toHaveBeenCalledWith(cacheKeyFor("OLDHASH"))
  })

  /**
   * ⚠ UNLIKE REVOKE, A FAILED EVICTION HERE STILL RETURNS 200 — AND THE
   * ASYMMETRY IS DELIBERATE. The replacement exists and the caller must receive
   * it; a 500 would leave them holding a revoked key with no successor, because
   * the secret is not recoverable afterwards. The stale entry expires on its own.
   */
  it("still hands back the new key when the eviction fails", async () => {
    const { call, log } = harness(
      {},
      {
        del: async () => {
          throw new Error("redis down")
        },
      },
    )

    const res = await call("/key-2/rotate", { method: "POST" })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { secret: string }).secret).toContain("i10_live_")
    expect(log.error).toHaveBeenCalled()
  })

  it("answers 404 for a key that cannot be rotated", async () => {
    const { call } = harness({ rotate: async () => null })
    expect((await call("/key-2/rotate", { method: "POST" })).status).toBe(404)
  })
})

describe("when nothing is wired", () => {
  it("answers 501 rather than pretending to manage keys", async () => {
    const app = createApp({ apiKeyAuth })
    const res = await app.request("/api-keys", {
      headers: { Authorization: `Bearer ${KEY}` },
    })
    expect(res.status).toBe(501)
  })
})
