import { PgDialect } from "drizzle-orm/pg-core"
import { describe, expect, it, mock } from "bun:test"
import type { Database } from "../src/db/client.js"
import { proveWaitingDomains } from "../src/domains/prove.js"
import type { DomainStore, VerifyOutcome } from "../src/domains/store.js"

/**
 * Proving the domains nobody has proved yet.
 *
 * ⚠ REGISTRATION HAD EXACTLY ONE ATTEMPT AND NO RETRY ANYWHERE. `verify` is the
 * only thing that may create an SES identity, and it is reachable from two HTTP
 * routes and nothing else — the console calls it once, about a second after
 * writing the records. DNS is usually not serving yet at that instant, and on
 * the manual path the customer publishes hours later, so the single attempt
 * missed and nothing ever made another.
 *
 * ⚠ AND NO BACKGROUND JOB COULD HAVE. `core.domains_awaiting_provider` filters
 * `status <> 'not_started'`; `core.domains_due_recheck` reads
 * `status = 'verified'`; `refresh` returns `not_registered` and writes nothing.
 * The state every domain is CREATED in had no reader at all.
 */

const dialect = new PgDialect()
const NOW = new Date("2026-09-21T12:00:00.000Z")

interface Waiting {
  domain_id: string
  tenant_id: string
  name: string
  delegated: boolean
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

const proved = (id: string): VerifyOutcome => ({
  status: "ok",
  domain: { id, status: "pending" } as never,
})

const notYet = (id: string): VerifyOutcome => ({
  status: "unproven",
  domain: { id, status: "not_started" } as never,
  reason: "absent",
})

const takenBy = (id: string): VerifyOutcome => ({
  status: "claimed",
  domain: { id, status: "not_started" } as never,
})

const waiting = (n: number): Waiting[] =>
  Array.from({ length: n }, (_, i) => ({
    domain_id: `d-${i}`,
    tenant_id: `t-${i}`,
    name: `example-${i}.com`,
    delegated: false,
  }))

const store = (verify: DomainStore["verify"]) =>
  ({ verify }) as Pick<DomainStore, "verify">

describe("proving the domains that are waiting to be proved", () => {
  it("verifies each one and counts what happened to it", async () => {
    const { db } = fakeDb(waiting(4))
    const verify = mock(async (_t: string, id: string) => {
      if (id === "d-0") return proved(id)
      if (id === "d-1") return takenBy(id)
      return notYet(id)
    })

    const summary = await proveWaitingDomains({
      db,
      domains: store(verify as never),
      now: () => NOW,
    })

    expect(verify).toHaveBeenCalledTimes(4)
    expect(summary).toEqual({
      checked: 4,
      registered: 1,
      unproven: 2,
      claimed: 1,
      failed: 0,
    })
  })

  /**
   * ⚠ THE ONE THING THIS SWEEP MUST NEVER DO. `verify` on the route may take a
   * name from a workspace that can no longer prove it — a deliberate transfer,
   * with a person waiting for the answer. Run from a cron across every unproved
   * row in the table, that same code would migrate domains between customers on
   * its own schedule with nobody asking. If this assertion ever fails, the
   * sweep has been handed a power it is not allowed to have.
   */
  it("never contests a name, so a cron cannot move a domain between workspaces", async () => {
    const { db } = fakeDb(waiting(2))
    const seen: (boolean | undefined)[] = []
    const verify = mock(
      async (_t: string, id: string, options?: { contest?: boolean }) => {
        seen.push(options?.contest)
        return notYet(id)
      },
    )

    await proveWaitingDomains({ db, domains: store(verify as never), now: () => NOW })

    expect(seen).toEqual([false, false])
  })

  /**
   * ⚠ ONE DOMAIN MUST NOT ABANDON THE REST. A hung nameserver or a failed zone
   * write says nothing about the other rows in the batch, and stopping at the
   * first would leave every later one waiting until somebody noticed by hand.
   */
  it("keeps going when one domain throws, and counts it", async () => {
    const { db } = fakeDb(waiting(3))
    const verify = mock(async (_t: string, id: string) => {
      if (id === "d-1") throw new Error("nameserver timed out")
      return proved(id)
    })
    const warn = mock(() => {})

    const summary = await proveWaitingDomains({
      db,
      domains: store(verify as never),
      log: { warn },
      now: () => NOW,
    })

    expect(verify).toHaveBeenCalledTimes(3)
    expect(summary).toEqual({
      checked: 3,
      registered: 2,
      unproven: 0,
      claimed: 0,
      failed: 1,
    })
    expect(warn).toHaveBeenCalledTimes(1)
  })

  /**
   * ⚠ `missing` IS A RACE, NOT A FAILURE. The row was deleted between the
   * selector's read and this write, which is ordinary and must not be counted
   * against the pass — a batch of them would otherwise trip the "every attempt
   * failed" alarm in the entry point.
   */
  it("says nothing about a row that was deleted underneath it", async () => {
    const { db } = fakeDb(waiting(1))
    const verify = mock(async () => ({ status: "missing" }) as VerifyOutcome)

    const summary = await proveWaitingDomains({
      db,
      domains: store(verify as never),
      now: () => NOW,
    })

    expect(summary).toEqual({
      checked: 1,
      registered: 0,
      unproven: 0,
      claimed: 0,
      failed: 0,
    })
  })

  it("asks the selector for unproved rows, bounded by staleness and horizon", async () => {
    const { db, asked } = fakeDb([])

    await proveWaitingDomains({
      db,
      domains: store((async () => ({ status: "missing" })) as never),
      now: () => NOW,
      staleMs: 2 * 60 * 1000,
      horizonMs: 7 * 24 * 60 * 60 * 1000,
      batch: 50,
    })

    expect(asked).toHaveLength(1)
    expect(asked[0]?.sql).toContain("core.domains_awaiting_proof")
    expect(asked[0]?.params).toEqual([
      "2026-09-21T11:58:00.000Z",
      "2026-09-14T12:00:00.000Z",
      50,
    ])
  })
})
