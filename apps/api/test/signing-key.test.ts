import { describe, expect, it, mock } from "bun:test"
import { domainSendingLookup } from "../src/send/signing-key.js"
import type { SecretBox } from "../src/webhooks/signing.js"

/**
 * ⚠ THIS FILE EXISTS BECAUSE ITS ABSENCE SHIPPED A BUG. `domainSendingLookup`
 * had no test, and the only test of the direct transport stubbed it out — so
 * nothing exercised the one thing that was wrong: the query ran outside
 * `withTenant()`, `core.domains`'s RLS policy raised rather than returning no
 * rows, and every direct-routed message was recorded permanently failed.
 *
 * The assertions below are therefore about the SHAPE OF THE CALL rather than
 * about rows: that a tenant context is opened at all, and that the tenant it
 * opens is the message's. A fuller check belongs in an integration test running
 * as a non-owner role — noted in mail-routing.md, not faked here.
 */

const secrets: SecretBox = {
  seal: (p) => `sealed:${p}`,
  open: (s) => s.replace(/^sealed:/, ""),
}

const ROW = {
  selector: "sel1",
  sealed: "sealed:PRIVATE",
  bounceSubdomain: "bounce",
}

/**
 * A database that records the tenant each transaction was opened for.
 *
 * `withTenant` issues `set_config('app.tenant_id', …)` and then runs the
 * callback against the transaction, so standing in for `transaction()` is
 * enough to observe both halves.
 */
function fakeDb(rows: unknown[] = [ROW]) {
  const tenants: string[] = []
  const db = {
    transaction: mock(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        execute: mock(async (q: unknown) => {
          // ⚠ drizzle PUTS A BOUND PARAMETER IN AS A BARE CHUNK, not wrapped in
          // a `{value}` the way the literal fragments around it are. Reading
          // `.value` finds the SQL text and never the tenant id.
          const chunks = (q as { queryChunks?: unknown[] })?.queryChunks ?? []
          for (const c of chunks) {
            if (typeof c === "string") tenants.push(c)
          }
          return []
        }),
        select: () => ({
          from: () => ({ where: () => ({ limit: async () => rows }) }),
        }),
      }
      return fn(tx)
    }),
  }
  return { db, tenants }
}

describe("the DKIM key lookup", () => {
  /**
   * ⚠ THE REGRESSION. Without a transaction there is no `app.tenant_id`, and
   * `core.domains`'s policy raises instead of returning nothing.
   */
  it("opens a tenant-scoped transaction rather than querying bare", async () => {
    const { db, tenants } = fakeDb()
    const lookup = domainSendingLookup({ db: db as never, secrets })

    await lookup("example.com", "ten-1")

    expect(db.transaction).toHaveBeenCalledTimes(1)
    expect(tenants).toContain("ten-1")
  })

  it("unseals the private key and carries the row's bounce label", async () => {
    const { db } = fakeDb()
    const lookup = domainSendingLookup({ db: db as never, secrets })

    const got = await lookup("example.com", "ten-1")

    expect(got).toEqual({
      dkim: { selector: "sel1", privateKey: "PRIVATE" },
      bounceSubdomain: "bounce",
    })
  })

  it("answers null for a domain with no key, without throwing", async () => {
    const { db } = fakeDb([{ selector: null, sealed: null, bounceSubdomain: "bounce" }])
    const lookup = domainSendingLookup({ db: db as never, secrets })

    expect(await lookup("example.com", "ten-1")).toBeNull()
  })

  describe("the cache", () => {
    it("serves a repeat from memory rather than the database", async () => {
      const { db } = fakeDb()
      const lookup = domainSendingLookup({ db: db as never, secrets })

      await lookup("example.com", "ten-1")
      await lookup("example.com", "ten-1")

      expect(db.transaction).toHaveBeenCalledTimes(1)
    })

    /**
     * ⚠ KEYED ON TENANT AS WELL AS DOMAIN. Keying on the domain alone would let
     * one tenant's cached answer — including a cached MISS — be served to
     * another, which after the RLS fix is the remaining way to cross the
     * boundary.
     */
    it("does not serve one tenant's entry to another", async () => {
      const { db } = fakeDb()
      const lookup = domainSendingLookup({ db: db as never, secrets })

      await lookup("example.com", "ten-1")
      await lookup("example.com", "ten-2")

      expect(db.transaction).toHaveBeenCalledTimes(2)
    })

    it("re-reads once the entry has expired", async () => {
      const { db } = fakeDb()
      const lookup = domainSendingLookup({ db: db as never, secrets, ttlMs: 0 })

      await lookup("example.com", "ten-1")
      await lookup("example.com", "ten-1")

      expect(db.transaction).toHaveBeenCalledTimes(2)
    })

    /**
     * ⚠ THE BOUND EXISTS BECAUSE ENTRIES HOLD UNSEALED PRIVATE KEYS. Unbounded,
     * a long-lived worker ends up holding every customer's signing key in
     * plaintext at once — what sealing them in the table exists to prevent,
     * reintroduced where a heap dump reaches it.
     */
    it("evicts rather than growing without limit", async () => {
      const { db } = fakeDb()
      const lookup = domainSendingLookup({ db: db as never, secrets, maxEntries: 2 })

      await lookup("a.test", "ten-1")
      await lookup("b.test", "ten-1")
      await lookup("c.test", "ten-1") // evicts a.test
      expect(db.transaction).toHaveBeenCalledTimes(3)

      await lookup("a.test", "ten-1") // evicted, so read again
      expect(db.transaction).toHaveBeenCalledTimes(4)
    })
  })
})
