import { describe, expect, it } from "bun:test"
import {
  routeSplitStatement,
  summariseRouteSplit,
  type RouteSplitBucket,
} from "../src/send/route-split.js"
import { sentUsageStatement } from "../src/send/reconcile.js"

/**
 * The readout for `sent_route`.
 *
 * ⚠ THE COLUMN WAS WRITTEN ON EVERY ROW SINCE 0033 AND READ BY NOTHING, so the
 * tests that matter most here are the ones that keep the two questions apart:
 * what we BILL for (one price, both routes, no route predicate) and what we
 * SPEND (which MTA carried it). They read the same table and must never grow
 * into each other.
 */

const bucket = (over: Partial<RouteSplitBucket> = {}): RouteSplitBucket => ({
  tenantId: "ten-1",
  periodStart: new Date("2026-09-17T00:00:00Z"),
  route: "ses",
  count: 1,
  ...over,
})

describe("summarising a route split", () => {
  it("adds up each route and the total", () => {
    const summary = summariseRouteSplit([
      bucket({ route: "ses", count: 900 }),
      bucket({ route: "direct", count: 100 }),
    ])

    expect(summary).toMatchObject({ ses: 900, direct: 100, unknown: 0, total: 1000 })
  })

  it("adds up across days and tenants", () => {
    const summary = summariseRouteSplit([
      bucket({ tenantId: "a", route: "ses", count: 10 }),
      bucket({
        tenantId: "a",
        route: "ses",
        count: 5,
        periodStart: new Date("2026-09-18T00:00:00Z"),
      }),
      bucket({ tenantId: "b", route: "direct", count: 7 }),
    ])

    expect(summary).toMatchObject({ ses: 15, direct: 7, total: 22, tenants: 2 })
  })

  /**
   * ⚠ WHICH TENANTS ARE ON OUR OWN IPs IS THE ABUSE SURFACE. Free traffic goes
   * direct, which means it leaves on an address shared with PSL — so "how many
   * tenants" is a different and more useful question than "how many messages".
   */
  it("counts the tenants that sent anything direct", () => {
    const summary = summariseRouteSplit([
      bucket({ tenantId: "a", route: "ses", count: 100 }),
      bucket({ tenantId: "b", route: "direct", count: 1 }),
      bucket({ tenantId: "c", route: "direct", count: 1 }),
      bucket({ tenantId: "c", route: "ses", count: 1 }),
    ])

    expect(summary.tenants).toBe(3)
    expect(summary.tenantsDirect).toBe(2)
  })

  /**
   * ⚠ `unknown` IS A FAULT AND NOT A CATEGORY. `sent_route` is nullable, 0033
   * backfilled everything that existed and `markSentStatement` has written it on
   * every row since — so a `sent` message with no route means a write path
   * skipped it. Folding those into `ses` would make the fault add up to a
   * plausible number and disappear; the reconcile job raises on a non-zero.
   */
  it("reports an unrecorded route rather than absorbing it", () => {
    const summary = summariseRouteSplit([
      bucket({ route: "ses", count: 10 }),
      bucket({ route: "unknown", count: 3 }),
    ])

    expect(summary.unknown).toBe(3)
    expect(summary.ses).toBe(10)
    expect(summary.total).toBe(13)
  })

  /**
   * ⚠ A VALUE ADDED TO THE ENUM AND NOT ADDED HERE MUST NOT VANISH. The total is
   * what somebody checks against the SES invoice, so an unrecognised route
   * counts as unknown rather than being dropped on the floor.
   */
  it("counts a route it does not recognise instead of dropping it", () => {
    const summary = summariseRouteSplit([
      bucket({ route: "ses", count: 5 }),
      bucket({ route: "carrier-pigeon", count: 2 }),
    ])

    expect(summary.unknown).toBe(2)
    expect(summary.total).toBe(7)
  })

  it("answers zero for a window with no sends", () => {
    expect(summariseRouteSplit([])).toEqual({
      ses: 0,
      direct: 0,
      unknown: 0,
      total: 0,
      tenants: 0,
      tenantsDirect: 0,
    })
  })
})

/**
 * ⚠ A DRIZZLE `SQL` DOES NOT STRINGIFY — `String(sql)` is `[object Object]`, and
 * an assertion against that passes or fails for reasons that have nothing to do
 * with the query. The text lives in `queryChunks` as `StringChunk`s interleaved
 * with the bound parameters.
 */
const render = (statement: unknown): string =>
  (statement as { queryChunks: unknown[] }).queryChunks
    .map((chunk) => {
      if (typeof chunk === "string") return chunk
      const value = (chunk as { value?: unknown }).value
      return Array.isArray(value) ? value.join("") : String(value ?? "")
    })
    .join("")

describe("the statement", () => {
  const from = new Date("2026-09-01T00:00:00Z")
  const to = new Date("2026-09-30T00:00:00Z")

  /**
   * ⚠ postgres.js BINDS A PARAMETER BY WRITING ITS BYTES, AND A `Date` IS NOT A
   * STRING. Passing one directly throws `ERR_INVALID_ARG_TYPE` before the query
   * is ever sent — which is exactly what kept usage reconciliation from
   * completing once already, so the same mistake is worth pinning here.
   */
  it("serialises its dates and casts them", () => {
    const text = render(routeSplitStatement(from, to))

    expect(text).toContain("2026-09-01T00:00:00.000Z")
    expect(text).toContain("2026-09-30T00:00:00.000Z")
    expect(text).toContain("::timestamptz")
  })

  it("goes through the privileged snapshot function", () => {
    // A cross-tenant count cannot be issued from a tenant-scoped connection:
    // every policy in `core` reads `app.tenant_id` strictly and raises without
    // it. Same reason `sent_usage_snapshot` exists.
    expect(render(routeSplitStatement(from, to))).toContain("core.route_split_snapshot")
  })

  /**
   * ⚠ THE ONE THAT MATTERS MOST. Billing counts `sent` rows with NO route
   * predicate — one price, both routes, which is the whole commercial decision.
   * If this readout's `where` ever migrated into the billing query, free-tier
   * mail would stop being billable and nobody would notice until a customer's
   * invoice was wrong in their favour.
   */
  it("does not share a predicate with the billing query", () => {
    const billing = render(sentUsageStatement(from, to))

    expect(billing).toContain("core.sent_usage_snapshot")
    expect(billing).not.toContain("route")
  })
})
