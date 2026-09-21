import { PgDialect } from "drizzle-orm/pg-core"
import type { SQL } from "drizzle-orm"
import { describe, expect, it, mock } from "bun:test"
import type { Database } from "../src/db/client.js"
import { sweepOrphans } from "../src/domains/orphans.js"

/**
 * What we are still holding for domains that no longer exist.
 *
 * ⚠ THIS IS THE MOST DANGEROUS CODE IN THE FEATURE AND THE TESTS ARE WEIGHTED
 * ACCORDINGLY. Most of what follows asserts that something is NOT deleted.
 * Removing a live sending identity stops a customer's mail with no warning and
 * no undo, so every removal has to clear two independent tests — our database
 * does not know the name, AND the identity carries our own BYODKIM selector —
 * and anything that cannot be proved twice must be left alone and reported.
 */

const dialect = new PgDialect()
const queryText = (q: unknown) => dialect.sqlToQuery(q as SQL).sql

/** Our own selector shape: `i10` plus twelve hex. See `generateSelector`. */
const OURS = { origin: "EXTERNAL", tokens: ["i103c3c2cbc1a75"] }
/** What Easy DKIM looks like — made by hand in the AWS console. */
const THEIRS = { origin: "AWS_SES", tokens: ["abc123", "def456", "ghi789"] }

function fakeDb(handlers: { known?: string[]; zones?: unknown[] }) {
  return {
    execute: async (q: unknown) => {
      const text = queryText(q)
      if (text.includes("orphaned_zones")) return handlers.zones ?? []
      return (handlers.known ?? []).map((name) => ({ name }))
    },
  } as unknown as Database
}

const identity = (over: Record<string, unknown> = {}) => ({
  list: async () => [],
  signature: async () => ({ origin: null, tokens: [] as string[] }),
  remove: mock(async (_d: string) => {}),
  ...over,
})

const base = { ownDomains: ["i10.tech"], batch: 100 }

describe("sweeping orphans", () => {
  it("reports an identity with no row and our selector, and removes nothing by default", async () => {
    const id = identity({
      list: async () => ["gone.com"],
      signature: async () => OURS,
    })

    const summary = await sweepOrphans({
      db: fakeDb({ known: [] }),
      identity: id as never,
      ...base,
    })

    expect(summary.identitiesOrphaned).toBe(1)
    expect(summary.identitiesRemoved).toBe(0)
    expect(id.remove).not.toHaveBeenCalled()
  })

  it("removes it once told to", async () => {
    const id = identity({
      list: async () => ["gone.com"],
      signature: async () => OURS,
    })

    const summary = await sweepOrphans({
      db: fakeDb({ known: [] }),
      identity: id as never,
      remove: true,
      ...base,
    })

    expect(summary.identitiesRemoved).toBe(1)
    expect(id.remove).toHaveBeenCalledWith("gone.com")
  })

  /**
   * ⚠ THE FIRST TEST ON ITS OWN WOULD DELETE EVERY CUSTOMER'S IDENTITY. A domain
   * that still has a row is in use by definition — that row is what the send
   * path reads — so it is never a candidate, whatever its status.
   */
  it("never touches an identity whose domain row still exists", async () => {
    const id = identity({
      list: async () => ["live.com"],
      signature: async () => OURS,
    })

    const summary = await sweepOrphans({
      db: fakeDb({ known: ["live.com"] }),
      identity: id as never,
      remove: true,
      ...base,
    })

    expect(summary.identitiesOrphaned).toBe(0)
    expect(id.remove).not.toHaveBeenCalled()
  })

  /**
   * ⚠ THE SECOND TEST ON ITS OWN WOULD DELETE SOMEBODY'S HAND-MADE IDENTITY. The
   * AWS account is not ours alone: identities get created in the console for a
   * test or a one-off send, and a sweep reasoning only from our database would
   * take out every one of them the first time it ran.
   */
  it("leaves an identity we did not create, and counts it separately", async () => {
    const id = identity({
      list: async () => ["somebody-elses.com"],
      signature: async () => THEIRS,
    })

    const summary = await sweepOrphans({
      db: fakeDb({ known: [] }),
      identity: id as never,
      remove: true,
      ...base,
    })

    expect(summary.identitiesForeign).toBe(1)
    expect(summary.identitiesOrphaned).toBe(0)
    expect(id.remove).not.toHaveBeenCalled()
  })

  /**
   * ⚠ EXTERNAL ORIGIN IS NOT ENOUGH BY ITSELF. Somebody else's BYODKIM identity
   * also reports `EXTERNAL`; what makes one OURS is that the token is a selector
   * this code generated.
   */
  it("leaves an external identity whose selector is not ours", async () => {
    const id = identity({
      list: async () => ["byodkim-elsewhere.com"],
      signature: async () => ({ origin: "EXTERNAL", tokens: ["selector1"] }),
    })

    const summary = await sweepOrphans({
      db: fakeDb({ known: [] }),
      identity: id as never,
      remove: true,
      ...base,
    })

    expect(summary.identitiesForeign).toBe(1)
    expect(id.remove).not.toHaveBeenCalled()
  })

  /**
   * ⚠ OUR OWN SENDING DOMAINS, WHICH CARRY EVERY PASSWORD RESET AND RECEIPT THIS
   * PRODUCT SENDS. They have rows, so they would survive the first test anyway —
   * and the guard is here because the cost of being wrong about them is our own
   * mail stopping.
   */
  it("never considers our own sending domains, even with no row", async () => {
    const id = identity({
      list: async () => ["i10.tech"],
      signature: async () => OURS,
    })

    const summary = await sweepOrphans({
      db: fakeDb({ known: [] }),
      identity: id as never,
      remove: true,
      ...base,
    })

    expect(summary.identitiesOrphaned).toBe(0)
    expect(id.remove).not.toHaveBeenCalled()
  })

  it("reports orphaned zones and removes them only when told", async () => {
    const zones = { remove: mock(async (_z: string) => {}) }
    const orphan = [
      { zone_id: 1, zone_name: "mail.gone.com", domain_name: "gone.com" },
    ]

    const reported = await sweepOrphans({
      db: fakeDb({ known: [], zones: orphan }),
      identity: identity() as never,
      zones,
      ...base,
    })
    expect(reported.zonesOrphaned).toBe(1)
    expect(reported.zonesRemoved).toBe(0)
    expect(zones.remove).not.toHaveBeenCalled()

    const acted = await sweepOrphans({
      db: fakeDb({ known: [], zones: orphan }),
      identity: identity() as never,
      zones,
      remove: true,
      ...base,
    })
    expect(acted.zonesRemoved).toBe(1)
    expect(zones.remove).toHaveBeenCalledWith("mail.gone.com")
  })

  /**
   * ⚠ WITHOUT A ZONE SINK THE HALF IS SKIPPED RATHER THAN REPORTED. A deployment
   * with no PowerDNS has no zones of ours to leak, and a summary claiming
   * otherwise would be noise on every run for ever.
   */
  it("skips the zone half entirely when there is no sink", async () => {
    const summary = await sweepOrphans({
      db: fakeDb({ known: [], zones: [{ zone_id: 1, zone_name: "x", domain_name: "y" }] }),
      identity: identity() as never,
      remove: true,
      ...base,
    })

    expect(summary.zonesOrphaned).toBe(0)
  })

  /** ⚠ ONE FAILED REMOVAL MUST NOT ABANDON THE REST, and must be counted. */
  it("keeps going when a removal throws", async () => {
    const id = identity({
      list: async () => ["one.com", "two.com"],
      signature: async () => OURS,
      remove: mock(async (d: string) => {
        if (d === "one.com") throw new Error("AccessDenied")
      }),
    })
    const warn = mock(() => {})

    const summary = await sweepOrphans({
      db: fakeDb({ known: [] }),
      identity: id as never,
      remove: true,
      log: { warn },
      ...base,
    })

    expect(summary.identitiesOrphaned).toBe(2)
    expect(summary.identitiesRemoved).toBe(1)
    expect(summary.failed).toBe(1)
  })
})
