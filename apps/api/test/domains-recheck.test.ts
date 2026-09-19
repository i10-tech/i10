import { describe, expect, it } from "bun:test"
import { PgDialect } from "drizzle-orm/pg-core"
import type { SQL } from "drizzle-orm"
import { recheckDomains } from "../src/domains/recheck.js"
import type { Database } from "../src/db/client.js"
import type { DelegationProbe, TxtLookup } from "../src/domains/ownership.js"

/**
 * Re-asking whether a verified domain is still its holder's.
 *
 * ⚠ THIS IS THE ONLY CODE IN THE PRODUCT THAT TAKES SOMETHING AWAY FROM A
 * CUSTOMER WITHOUT ANYBODY ASKING IT TO, so the interesting tests are all about
 * when it must NOT act. A verified domain is what gates sending; standing one
 * down because a nameserver was slow, or because a zone was mid-migration for
 * ten minutes, breaks a paying customer's mail for a reason nobody can see.
 */

const NOW = new Date("2026-09-19T12:00:00.000Z")
const DAY = 24 * 60 * 60 * 1000
const dialect = new PgDialect()

const TOKEN = "0f1e2d3c4b5a69788796a5b4c3d2e1f0"

const due = (over: Record<string, unknown> = {}) => ({
  domain_id: "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f60bb",
  tenant_id: "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6071",
  name: "example.com",
  delegated: true,
  delegation_token: TOKEN,
  dkim_selector: "i10abc123",
  dkim_public_key: "MIIBIjANBgkq",
  proof_missing_since: null,
  ...over,
})

function fakeDb(rows: Record<string, unknown>[]) {
  const statements: string[] = []
  const db = {
    execute: async (q: SQL) => {
      const text = dialect.sqlToQuery(q).sql
      statements.push(text)
      return text.includes("domains_due_recheck") ? rows : []
    },
  } as unknown as Database
  return { db, statements }
}

const NS = ["ns1.i10.tech", "ns2.i10.tech"]

/** A parent that delegates to these claims' nameservers, or to nothing. */
const delegating =
  (...claims: string[]): DelegationProbe =>
  async () =>
    claims.length === 0
      ? { kind: "undelegated" }
      : { kind: "delegated", nameservers: claims.map((c) => `${c}.ns1.i10.tech`) }

const nothing: TxtLookup = async () => []

const run = (
  rows: Record<string, unknown>[],
  probes: { delegation?: DelegationProbe; txt?: TxtLookup },
  over: Partial<Parameters<typeof recheckDomains>[0]> = {},
) => {
  const { db, statements } = fakeDb(rows)
  return recheckDomains({
    db,
    probes: {
      txt: probes.txt ?? nothing,
      delegation: probes.delegation ?? delegating(),
    },
    nameservers: NS,
    now: () => NOW,
    ...over,
  }).then((summary) => ({ summary, statements }))
}

describe("a domain that still proves itself", () => {
  it("is recorded as checked and nothing else", async () => {
    const { summary, statements } = await run([due()], {
      delegation: delegating(TOKEN),
    })

    expect(summary).toMatchObject({ checked: 1, proven: 1, missing: 0, displaced: 0 })
    expect(statements.some((s) => s.includes("note_domain_proof"))).toBe(true)
    expect(statements.some((s) => s.includes("displace_domain"))).toBe(false)
  })

  /** ⚠ A MANUAL DOMAIN IS PROVED BY ITS OWN ROUTE — the DKIM record it publishes. */
  it("proves a manual domain with its DKIM record", async () => {
    const asked: string[] = []
    const { summary } = await run([due({ delegated: false })], {
      txt: async (name) => {
        asked.push(name)
        return name === "i10abc123._domainkey.example.com"
          ? ["v=DKIM1; k=rsa; p=MIIBIjANBgkq"]
          : []
      },
    })

    expect(asked).toEqual(["i10abc123._domainkey.example.com"])
    expect(summary.proven).toBe(1)
  })
})

describe("a domain whose proof has gone", () => {
  /**
   * ⚠ THE FIRST FAILURE ONLY STARTS A CLOCK. Standing a domain down on one
   * reading would punish a customer for the ninety seconds their zone was
   * mid-edit, and the punishment is that their mail stops.
   */
  it("is not stood down the first time it fails", async () => {
    const { summary, statements } = await run([due()], { delegation: delegating() })

    expect(summary).toMatchObject({ checked: 1, missing: 1, displaced: 0 })
    expect(statements.some((s) => s.includes("displace_domain"))).toBe(false)
  })

  it("is still not stood down inside the grace period", async () => {
    const twoDaysAgo = new Date(NOW.getTime() - 2 * DAY).toISOString()
    const { summary, statements } = await run(
      [due({ proof_missing_since: twoDaysAgo })],
      { delegation: delegating() },
    )

    expect(summary.displaced).toBe(0)
    expect(statements.some((s) => s.includes("displace_domain"))).toBe(false)
  })

  /** ⚠ AND IT IS STOOD DOWN ONCE IT HAS BEEN FAILING EVERY CHECK FOR A WEEK. */
  it("is stood down once it has failed for longer than the grace period", async () => {
    const eightDaysAgo = new Date(NOW.getTime() - 8 * DAY).toISOString()
    const { summary, statements } = await run(
      [due({ proof_missing_since: eightDaysAgo })],
      { delegation: delegating() },
    )

    expect(summary).toMatchObject({ missing: 1, displaced: 1 })
    expect(statements.some((s) => s.includes("displace_domain"))).toBe(true)
  })

  it("honours a grace period the operator has shortened", async () => {
    const anHourAgo = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString()
    const { summary } = await run(
      [due({ proof_missing_since: anHourAgo })],
      { delegation: delegating() },
      {
        graceMs: 30 * 60 * 1000,
      },
    )
    expect(summary.displaced).toBe(1)
  })
})

describe("a domain we could not ask about", () => {
  /**
   * ⚠ THE MOST IMPORTANT TEST IN THIS FILE. A failure to ASK is not an answer.
   * If a resolver timeout started the clock, one bad afternoon at a large DNS
   * provider would quietly begin un-verifying a large fraction of our customers
   * at once — and every one of those clocks would look like a genuine failure a
   * week later, long after the outage was forgotten.
   */
  it("has nothing written about it at all", async () => {
    const eightDaysAgo = new Date(NOW.getTime() - 8 * DAY).toISOString()
    const { summary, statements } = await run(
      [due({ proof_missing_since: eightDaysAgo })],
      { delegation: async () => ({ kind: "unreachable", detail: "timed out" }) },
    )

    expect(summary).toMatchObject({
      checked: 1,
      unreachable: 1,
      missing: 0,
      displaced: 0,
    })
    // ⚠ NOT EVEN THE CHECK TIMESTAMP — the row must come back next run untouched.
    expect(statements.some((s) => s.includes("note_domain_proof"))).toBe(false)
    expect(statements.some((s) => s.includes("displace_domain"))).toBe(false)
  })

  /** ⚠ AND IT DOES NOT STOP THE RUN. One dead nameserver is not a failed pass. */
  it("does not stop the rest of the batch being checked", async () => {
    const { summary } = await run(
      [due({ domain_id: "a", name: "unreachable.test" }), due({ domain_id: "b" })],
      {
        delegation: async (parent) =>
          parent === "unreachable.test"
            ? { kind: "unreachable", detail: "timed out" }
            : { kind: "delegated", nameservers: [`${TOKEN}.ns1.i10.tech`] },
      },
    )

    expect(summary).toMatchObject({ checked: 2, unreachable: 1, proven: 1 })
  })
})

describe("choosing what to re-check", () => {
  it("asks only for domains whose last check is older than the interval", async () => {
    const { statements } = await run([], { delegation: delegating() })
    const query = statements[0]!

    expect(query).toContain("domains_due_recheck")
  })

  it("does nothing at all when nothing is due", async () => {
    const { summary, statements } = await run([], { delegation: delegating() })
    expect(summary).toEqual({
      checked: 0,
      proven: 0,
      missing: 0,
      unreachable: 0,
      displaced: 0,
    })
    expect(statements).toHaveLength(1)
  })
})
