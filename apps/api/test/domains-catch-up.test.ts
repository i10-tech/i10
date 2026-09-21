import { PgDialect } from "drizzle-orm/pg-core"
import { describe, expect, it, mock } from "bun:test"
import type { Database } from "../src/db/client.js"
import { catchUpWithProvider } from "../src/domains/catch-up.js"
import type { DomainStore, RefreshOutcome } from "../src/domains/store.js"

/**
 * Catching up with SES on the domains that are still waiting.
 *
 * ⚠ NOTHING ASKED TWICE, AND THAT MADE US WRONG ABOUT OUR OWN STATE.
 * `core.domains_due_recheck` — the only background reader of this table —
 * selects `WHERE status = 'verified'`, because its job is re-proving ownership.
 * A domain that has NOT got there is in no background job at all, so the only
 * readers were a human pressing Verify and the console's own poll, which gives
 * up after about a minute. SES verifies on its own schedule and tells nobody.
 *
 * ⚠ THE OBSERVED CONSEQUENCE WAS A CUSTOMER SENDING REAL MAIL FROM A DOMAIN THE
 * DASHBOARD CALLED PENDING. That is survivable while nothing acts on the column
 * — and stops being survivable the moment the send path refuses on it, which it
 * now does.
 */

const dialect = new PgDialect()
const NOW = new Date("2026-09-21T12:00:00.000Z")

interface Waiting {
  domain_id: string
  tenant_id: string
  name: string
}

function fakeDb(rows: Waiting[]) {
  const asked: { sql: string; params: unknown[] }[] = []
  const db = {
    execute: async (query: unknown) => {
      const built = dialect.sqlToQuery(query as never)
      asked.push({ sql: built.sql, params: built.params })
      return rows
    },
  } as unknown as Database
  return { db, asked }
}

const verified = (id: string): RefreshOutcome => ({
  status: "ok",
  domain: { id, status: "verified" } as never,
})

const stillPending = (id: string): RefreshOutcome => ({
  status: "ok",
  domain: { id, status: "pending" } as never,
})

const waiting = (n: number): Waiting[] =>
  Array.from({ length: n }, (_, i) => ({
    domain_id: `d-${i}`,
    tenant_id: `t-${i}`,
    name: `example-${i}.com`,
  }))

const store = (refresh: DomainStore["refresh"]) =>
  ({ refresh }) as Pick<DomainStore, "refresh">

describe("asking about the domains that are waiting", () => {
  it("refreshes each one and counts the ones that turned out verified", async () => {
    const { db } = fakeDb(waiting(3))
    const refresh = mock(async (_t: string, id: string) =>
      id === "d-1" ? verified(id) : stillPending(id),
    )

    const summary = await catchUpWithProvider({
      db,
      domains: store(refresh),
      now: () => NOW,
    })

    expect(refresh).toHaveBeenCalledTimes(3)
    expect(summary).toEqual({ checked: 3, verified: 1, failed: 0 })
  })

  /**
   * ⚠ THE TENANT IS CARRIED THROUGH, because every write underneath runs inside
   * `withTenant` and row level security is the tenant boundary. A sweep that
   * refreshed with the wrong tenant id would either write nothing or write
   * somebody else's row, and only one of those is noisy.
   */
  it("refreshes each domain against its own tenant", async () => {
    const { db } = fakeDb(waiting(2))
    const refresh = mock(async (_t: string, id: string) => stillPending(id))

    await catchUpWithProvider({ db, domains: store(refresh), now: () => NOW })

    expect(refresh).toHaveBeenNthCalledWith(1, "t-0", "d-0")
    expect(refresh).toHaveBeenNthCalledWith(2, "t-1", "d-1")
  })

  /**
   * ⚠ ONE BAD DOMAIN MUST NOT ABANDON THE REST. A throttled SES call or a row
   * deleted between the read and the write says nothing about the other
   * hundred and ninety-nine, and stopping at the first would leave every later
   * one stale until somebody noticed by hand.
   */
  it("keeps going past a domain it could not ask about, and counts it", async () => {
    const { db } = fakeDb(waiting(3))
    const warn = mock(() => {})
    const refresh = mock(async (_t: string, id: string) => {
      if (id === "d-0") throw new Error("Throttling: rate exceeded")
      return verified(id)
    })

    const summary = await catchUpWithProvider({
      db,
      domains: store(refresh),
      log: { warn },
      now: () => NOW,
    })

    expect(refresh).toHaveBeenCalledTimes(3)
    expect(summary).toEqual({ checked: 3, verified: 2, failed: 1 })
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it("is a no-op when nothing is waiting", async () => {
    const { db } = fakeDb([])
    const refresh = mock(async () => stillPending("x"))

    expect(
      await catchUpWithProvider({ db, domains: store(refresh), now: () => NOW }),
    ).toEqual({ checked: 0, verified: 0, failed: 0 })
    expect(refresh).not.toHaveBeenCalled()
  })
})

describe("what the sweep asks for", () => {
  /**
   * ⚠ BOTH BOUNDS ARE SENT AND BOTH MATTER. The staleness window stops SES
   * being asked about the same domain twice in a minute if a slot overruns or
   * somebody tightens the schedule; the horizon stops an abandoned domain being
   * asked about every five minutes for ever, since SES gives up on DKIM after
   * 72 hours and nothing after that is going to change.
   */
  it("bounds the selection by staleness, a horizon and a batch size", async () => {
    const { db, asked } = fakeDb([])

    await catchUpWithProvider({
      db,
      domains: store(mock(async () => stillPending("x"))),
      now: () => NOW,
      staleMs: 120_000,
      horizonMs: 7 * 86_400_000,
      batch: 50,
    })

    expect(asked).toHaveLength(1)
    expect(asked[0]?.sql).toContain("core.domains_awaiting_provider")
    expect(asked[0]?.params).toEqual([
      "2026-09-21T11:58:00.000Z",
      "2026-09-14T12:00:00.000Z",
      50,
    ])
  })

  /**
   * ⚠ ISO STRINGS, NOT `Date` OBJECTS. postgres.js binds a parameter by writing
   * its bytes and cannot serialise a `Date`; the same mistake has shipped three
   * times in this codebase, most recently breaking every metering read for
   * weeks. See `ts()` in db/client.ts.
   */
  it("sends the bounds as strings the driver can bind", async () => {
    const { db, asked } = fakeDb([])

    await catchUpWithProvider({
      db,
      domains: store(mock(async () => stillPending("x"))),
      now: () => NOW,
    })

    for (const param of asked[0]?.params ?? []) {
      expect(param).not.toBeInstanceOf(Date)
    }
  })
})
