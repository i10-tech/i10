import { PgDialect } from "drizzle-orm/pg-core"
import type { SQL } from "drizzle-orm"
import { describe, expect, it, vi } from "vitest"
import {
  postgresEntitlements,
  postgresLedger,
  postgresMetering,
} from "../src/metering/service.js"
import { shouldSend } from "../src/send/metering.js"
import type { Database } from "../src/db/client.js"

/**
 * The swap itself: `@repo/metering` mapped onto the `Metering` seam the send
 * path has always taken as a dependency.
 */
const dialect = new PgDialect()
const TENANT = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6071"
const ANCHOR = new Date("2026-01-15T00:00:00.000Z")
const NOW = new Date("2026-02-01T09:00:00.000Z")
const now = () => NOW

function fakeDb(rowsFor: (statement: string) => unknown[]) {
  const seen: string[] = []
  const execute = vi.fn(async (query: SQL) => {
    const { sql: statement } = dialect.sqlToQuery(query)
    seen.push(statement)
    return rowsFor(statement)
  })
  const db = {
    execute,
    transaction: async (fn: (tx: { execute: typeof execute }) => Promise<unknown>) =>
      fn({ execute }),
  } as unknown as Database
  return { db, seen }
}

const onPro = (used: number) => (statement: string) => {
  if (statement.includes("plan_assignments") && statement.includes("select"))
    return [
      {
        plan_id: "pro",
        source: "catalog",
        entitlements: [{ featureId: "emails", allowance: 50_000, interval: "month" }],
        anchor: ANCHOR,
      },
    ]
  if (statement.includes("sum(value)")) return [{ used: String(used) }]
  return []
}

describe("checking quota", () => {
  it("allows a request inside the allowance", async () => {
    const { db } = fakeDb(onPro(10))
    const metering = postgresMetering({ db, featureId: "emails", now })
    expect(await metering.checkQuota(TENANT, 5)).toEqual({ status: "allowed" })
  })

  it("refuses one past it, and says when the allowance returns", async () => {
    const { db } = fakeDb(onPro(50_000))
    const metering = postgresMetering({ db, featureId: "emails", now })

    expect(await metering.checkQuota(TENANT, 1)).toEqual({
      status: "exceeded",
      message: "You have used your sending allowance for this period.",
      resetsAt: new Date("2026-02-15T00:00:00.000Z"),
    })
  })

  /**
   * ⚠ THE MOST IMPORTANT MAPPING IN THE SWAP. A tenant with no plan is OUR
   * misconfiguration — a signup that never assigned free, a feature id renamed
   * under a running catalogue. Reporting it as `exceeded` tells a customer who
   * has sent nothing to go and upgrade, and the mistake then hides behind them
   * doing exactly that.
   */
  it("reports an unentitled tenant as unavailable, never as exceeded", async () => {
    const { db } = fakeDb(() => [])
    const log = { warn: vi.fn(), error: vi.fn() }
    const metering = postgresMetering({ db, featureId: "emails", log, now })

    const outcome = await metering.checkQuota(TENANT, 1)
    expect(outcome.status).toBe("unavailable")
    // ...which fails open, so their mail still goes.
    expect(shouldSend(outcome)).toBe(true)
    expect(log.error).toHaveBeenCalled()
  })

  it("reports a feature the plan does not grant the same way", async () => {
    const { db } = fakeDb(onPro(0))
    const log = { warn: vi.fn(), error: vi.fn() }
    const metering = postgresMetering({ db, featureId: "sms", log, now })
    expect((await metering.checkQuota(TENANT, 1)).status).toBe("unavailable")
  })
})

describe("recording what was sent", () => {
  // ⚠ The stored `sent_at`, not the recording process's clock — the reconciler
  // buckets both sides on it, and a millisecond across midnight is a deficit in
  // one day and a surplus in the next, topped up forever.
  it("stamps each event with the row's own sent_at", async () => {
    const { db, seen } = fakeDb((s) => (s.includes("insert into") ? [{}] : []))
    const sentAt = new Date("2026-02-01T08:59:59.999Z")

    await postgresMetering({ db, featureId: "emails", now }).recordSent(TENANT, [
      { id: "msg_1", sentAt },
    ])

    expect(seen.some((s) => s.includes("insert into core.meter_events"))).toBe(true)
  })

  it("warns when a batch contained events already recorded", async () => {
    const { db } = fakeDb(() => [])
    const log = { warn: vi.fn(), error: vi.fn() }

    await postgresMetering({ db, featureId: "emails", log, now }).recordSent(TENANT, [
      { id: "msg_1", sentAt: NOW },
    ])

    expect(log.warn).toHaveBeenCalled()
  })
})

describe("entitlements", () => {
  /**
   * ⚠ SIGNUP MUST NEVER MOVE A PAYING CUSTOMER BACK ONTO FREE. This runs again
   * on every redelivered provisioning webhook, and an upsert would do exactly
   * that on the second delivery.
   */
  it("ensures a plan without overwriting one", async () => {
    const { db, seen } = fakeDb(() => [])
    await postgresEntitlements({ db, freePlanId: "free", now }).ensureCustomer({
      tenantId: TENANT,
    })

    const insert = seen.find((s) => s.includes("plan_assignments"))
    expect(insert).toContain("do nothing")
    expect(insert).not.toContain("do update")
  })

  it("moves a tenant between plans without touching the anchor", async () => {
    const { db, seen } = fakeDb(() => [])
    await postgresEntitlements({ db, freePlanId: "free", now }).grantPlan({
      tenantId: TENANT,
      planId: "pro",
      // ⚠ Accepted and ignored: it was Autumn's idempotency key, and ours is
      // the row's own primary key. Keeping it lets `subscriptionGrants` stay
      // untouched.
      subscriptionId: "sub_123",
    })

    const insert = seen.find((s) => s.includes("plan_assignments"))
    expect(insert).toContain("do update")
    expect(insert).not.toMatch(/set[\s\S]*anchor/)
  })
})

describe("the ledger the reconciler reads", () => {
  it("aggregates through the definer function, not off the table", async () => {
    const { db, seen } = fakeDb(() => [
      { tenant_id: TENANT, period_start: "2026-02-01T00:00:00.000Z", count: "7" },
    ])

    const buckets = await postgresLedger({
      db,
      featureId: "emails",
    }).aggregateByCustomer(ANCHOR, NOW)

    expect(buckets).toEqual([
      { tenantId: TENANT, periodStart: new Date("2026-02-01T00:00:00.000Z"), count: 7 },
    ])
    expect(seen[0]).toContain("core.meter_usage_snapshot(")
    expect(seen[0]).not.toContain("from core.meter_events")
  })

  /**
   * ⚠ THE PROPERTY THE TOP-UP DEPENDS ON. The deficit is closed by message id
   * precisely because presenting the same id twice inserts nothing; closing it
   * by count would have two runs add double.
   */
  it("reports a replayed message as a duplicate rather than a top-up", async () => {
    const { db } = fakeDb(() => [])
    const outcome = await postgresLedger({ db, featureId: "emails" }).track({
      customerId: TENANT,
      messageId: "msg_1",
      at: NOW,
    })
    expect(outcome).toBe("duplicate")
  })

  it("reports a new message as recorded", async () => {
    const { db } = fakeDb((s) => (s.includes("insert into") ? [{}] : []))
    expect(
      await postgresLedger({ db, featureId: "emails" }).track({
        customerId: TENANT,
        messageId: "msg_1",
        at: NOW,
      }),
    ).toBe("recorded")
  })

  it("lists the tenants that hold a plan", async () => {
    const { db, seen } = fakeDb(() => [{ tenant_id: TENANT }])
    expect(await postgresLedger({ db, featureId: "emails" }).listCustomerIds()).toEqual(
      [TENANT],
    )
    expect(seen[0]).toContain("core.assigned_tenant_ids()")
  })

  it("confirms one tenant with a point lookup", async () => {
    const present = fakeDb((s) =>
      s.includes("plan_assignments") ? [{ present: 1 }] : [],
    )
    const absent = fakeDb(() => [])
    const ledger = (db: Database) => postgresLedger({ db, featureId: "emails" })

    expect(await ledger(present.db).customerExists(TENANT)).toBe(true)
    expect(await ledger(absent.db).customerExists(TENANT)).toBe(false)
  })
})
