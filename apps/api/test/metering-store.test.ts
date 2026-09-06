import { PgDialect } from "drizzle-orm/pg-core"
import type { SQL } from "drizzle-orm"
import { describe, expect, it, vi } from "vitest"
import { meterEventStore, planAssignmentStore } from "../src/metering/postgres.js"
import type { Database } from "../src/db/client.js"
import type { MeterKey } from "@repo/metering"

/**
 * The store's own behaviour, with the driver replaced.
 *
 * What is being tested is everything between the SQL and the port: that a
 * missing row is not the same as a broken one, that counts are taken against
 * what the caller handed us, and that every statement is wrapped in a tenant
 * transaction — which is the only thing standing between one customer's usage
 * and another's balance.
 */
const dialect = new PgDialect()
const TENANT = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6071"
const KEY: MeterKey = { tenantId: TENANT, featureId: "emails", shard: 0 }
const WINDOW = {
  start: new Date("2026-02-01T00:00:00.000Z"),
  end: new Date("2026-03-01T00:00:00.000Z"),
}

/** A `Database` whose only job is to hand back rows and remember the SQL. */
function fakeDb(rowsFor: (statement: string) => unknown[]) {
  const seen: string[] = []
  const execute = vi.fn(async (query: SQL) => {
    const { sql: statement } = dialect.sqlToQuery(query)
    seen.push(statement)
    return rowsFor(statement)
  })

  const db = {
    transaction: async (fn: (tx: { execute: typeof execute }) => Promise<unknown>) =>
      fn({ execute }),
  } as unknown as Database

  return { db, seen }
}

const PLAN_ROW = {
  plan_id: "pro",
  source: "catalog",
  entitlements: [
    {
      kind: "consumable",
      featureId: "emails",
      allowance: 50_000,
      interval: "month",
      overage: "never",
    },
  ],
  anchor: new Date("2026-01-15T00:00:00.000Z"),
  overage_enabled: false,
}

describe("finding an assignment", () => {
  it("returns the plan and the anchor", async () => {
    const { db } = fakeDb((s) => (s.includes("plan_assignments") ? [PLAN_ROW] : []))

    expect(await planAssignmentStore(db).find(TENANT)).toEqual({
      tenantId: TENANT,
      anchor: PLAN_ROW.anchor,
      overageEnabled: false,
      plan: {
        id: "pro",
        source: "catalog",
        entitlements: [
          {
            kind: "consumable",
            featureId: "emails",
            allowance: 50_000,
            interval: "month",
            overage: "never",
          },
        ],
      },
    })
  })

  it("returns null when the tenant holds no plan", async () => {
    const { db } = fakeDb(() => [])
    expect(await planAssignmentStore(db).find(TENANT)).toBeNull()
  })

  /**
   * ⚠ THE DISTINCTION THE WHOLE OUTCOME TYPE RESTS ON. `null` is a fact about
   * the customer — they hold no plan. A catalogue row we cannot read is a fact
   * about us. Letting the second wear the first's clothes tells a paying
   * customer they are over quota because somebody mistyped an interval.
   */
  it("throws rather than reporting a malformed plan as no plan", async () => {
    const { db } = fakeDb((s) =>
      s.includes("plan_assignments")
        ? [
            {
              ...PLAN_ROW,
              entitlements: [
                {
                  kind: "consumable",
                  featureId: "emails",
                  allowance: 100,
                  interval: "fortnight",
                  overage: "never",
                },
              ],
            },
          ]
        : [],
    )

    await expect(planAssignmentStore(db).find(TENANT)).rejects.toThrow()
  })

  // ⚠ RLS reads `app.tenant_id`, which only a `withTenant` transaction sets. A
  // read issued outside one raises rather than returning another tenant's rows,
  // and this is the assertion that the wrapper is actually there.
  it("carries the tenant into the transaction", async () => {
    const { db, seen } = fakeDb(() => [])
    await planAssignmentStore(db).find(TENANT)
    expect(seen[0]).toContain("set_config('app.tenant_id'")
  })
})

describe("recording", () => {
  const events = [
    { id: "msg_1", at: WINDOW.start, value: 1 },
    { id: "msg_2", at: WINDOW.start, value: 1 },
  ]

  it("counts what the insert returned as recorded", async () => {
    const { db } = fakeDb((s) => (s.includes("insert into") ? [{}, {}] : []))
    expect(await meterEventStore(db).record(KEY, events)).toEqual({
      recorded: 2,
      duplicates: 0,
    })
  })

  it("counts rows the conflict suppressed as duplicates", async () => {
    const { db } = fakeDb((s) => (s.includes("insert into") ? [{}] : []))
    expect(await meterEventStore(db).record(KEY, events)).toEqual({
      recorded: 1,
      duplicates: 1,
    })
  })

  /**
   * ⚠ COUNTED AGAINST WHAT THE CALLER HANDED US. Collapsing a repeated id and
   * then counting against the collapsed list would report two fresh units for a
   * batch that contained one message twice, and an upstream that is
   * double-submitting would stay invisible in the one number that shows it.
   */
  it("reports a repeat inside one batch as a duplicate", async () => {
    const { db, seen } = fakeDb((s) => (s.includes("insert into") ? [{}] : []))

    expect(await meterEventStore(db).record(KEY, [events[0]!, events[0]!])).toEqual({
      recorded: 1,
      duplicates: 1,
    })

    // ...and the statement itself carries the id once, not twice.
    const insert = seen.find((s) => s.includes("insert into"))
    expect(insert?.match(/\(\s*\$/g)).toHaveLength(1)
  })

  // Not a send, so it must not become an INSERT with an empty VALUES list —
  // which is a syntax error, raised on the send path, after the mail has gone.
  it("does no work for an empty batch", async () => {
    const { db, seen } = fakeDb(() => [])
    expect(await meterEventStore(db).record(KEY, [])).toEqual({
      recorded: 0,
      duplicates: 0,
    })
    expect(seen).toEqual([])
  })

  it("refuses a value the integer column would not hold", async () => {
    const { db } = fakeDb(() => [])
    await expect(
      meterEventStore(db).record(KEY, [{ id: "m", at: WINDOW.start, value: 1.5 }]),
    ).rejects.toThrow(RangeError)
  })
})

describe("reading usage", () => {
  // ⚠ `sum()` over bigint arrives as a STRING from postgres-js, and `"90" > 100`
  // is false in the same way `"0" > 100` is — a comparison that looks like it
  // works right up until the balance is wrong.
  it("converts the driver's bigint string to a number", async () => {
    const { db } = fakeDb((s) => (s.includes("sum(value)") ? [{ used: "12345" }] : []))
    const used = await meterEventStore(db).usedIn(KEY, WINDOW)
    expect(used).toBe(12_345)
    expect(typeof used).toBe("number")
  })

  it("reads an empty meter as zero", async () => {
    const { db } = fakeDb(() => [])
    expect(await meterEventStore(db).usedIn(KEY, WINDOW)).toBe(0)
  })
})
