import { describe, expect, it, vi } from "vitest"
import type { Database } from "../src/db/client.js"
import type { AutumnClient } from "../src/send/autumn.js"
import { reconcileSes, reconcileUsage } from "../src/send/reconcile-run.js"

const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })

/**
 * A database that answers each `execute` from a queue of results, in order.
 * Enough to test the orchestration; the statements themselves are covered by
 * reconcile.test.ts and reconcile-ses.test.ts.
 */
function fakeDb(results: unknown[][]) {
  const execute = vi.fn(async () => results.shift() ?? [])
  return { db: { execute } as unknown as Database, execute }
}

const AT = new Date("2026-09-03T10:00:00Z")
const DAY = new Date("2026-09-03T00:00:00Z")

describe("the SES leg", () => {
  it("repairs what SES sent and we did not record", async () => {
    const { db, execute } = fakeDb([
      [
        {
          message_id: "m-1",
          created_at: AT,
          tenant_id: "ten-1",
          status: "sending",
          ses_sent_at: AT,
          ses_message_id: "ses-1",
        },
      ],
      [{ id: "m-1" }], // the repair took
      [], // nothing billed-but-unconfirmed
      [], // no orphans
    ])

    const report = await reconcileSes(db, DAY, log())

    expect(report.unbilled).toEqual([{ messageId: "m-1", tenantId: "ten-1" }])
    expect(execute).toHaveBeenCalledTimes(4)
  })

  // ⚠ A REPAIR THAT WROTE NOTHING IS NOT A REPAIR. The row reached `sent`
  // between the read and the write — a second pass, or the worker finishing
  // late — and counting it would report work that did not happen.
  it("does not count a repair that hit no row", async () => {
    const { db } = fakeDb([
      [
        {
          message_id: "m-1",
          created_at: AT,
          tenant_id: "ten-1",
          status: "sent",
          ses_sent_at: AT,
          ses_message_id: null,
        },
      ],
      [], // update returned nothing
      [],
      [],
    ])

    const report = await reconcileSes(db, DAY, log())

    expect(report.unbilled).toEqual([])
  })

  it("keeps going when one repair fails", async () => {
    const rows = [
      { message_id: "m-1", created_at: AT, tenant_id: "t", ses_sent_at: AT },
      { message_id: "m-2", created_at: AT, tenant_id: "t", ses_sent_at: AT },
    ]
    let call = 0
    const db = {
      execute: vi.fn(async () => {
        call += 1
        if (call === 1) return rows
        if (call === 2) throw new Error("deadlock detected")
        if (call === 3) return [{ id: "m-2" }]
        return []
      }),
    } as unknown as Database

    const report = await reconcileSes(db, DAY, log())

    expect(report.unbilled).toEqual([{ messageId: "m-2", tenantId: "t" }])
  })

  it("reports the two directions it must never repair", async () => {
    const { db } = fakeDb([
      [],
      [{ message_id: "m-9", tenant_id: "ten-1" }],
      [{ message_id: "m-8", tenant_id: "ten-2" }],
    ])

    const report = await reconcileSes(db, DAY, log())

    expect(report.unconfirmed).toEqual([{ messageId: "m-9", tenantId: "ten-1" }])
    expect(report.orphaned).toEqual([{ messageId: "m-8", tenantId: "ten-2" }])
  })
})

function fakeAutumn(over: Partial<AutumnClient> = {}): AutumnClient {
  return {
    check: vi.fn(),
    batchTrack: vi.fn(),
    track: vi.fn(async () => "recorded" as const),
    aggregateByCustomer: vi.fn(async () => []),
    ensureCustomer: vi.fn(),
    grantPlan: vi.fn(),
    ...over,
  } as unknown as AutumnClient
}

describe("the usage leg", () => {
  // ⚠ BY MESSAGE ID, NEVER BY COUNT. `track` is idempotent on the id, so a
  // repeated pass cannot double-bill; submitting "two more" would.
  it("tops up a deficit one message at a time", async () => {
    const { db } = fakeDb([
      [{ tenant_id: "ten-1", period_start: DAY, count: 3 }],
      [{ id: "m-1" }, { id: "m-2" }],
    ])
    const track = vi.fn(async () => "recorded" as const)
    const autumn = fakeAutumn({
      aggregateByCustomer: vi.fn(async () => [
        { tenantId: "ten-1", periodStart: DAY, count: 1 },
      ]),
      track,
    })

    const report = await reconcileUsage(db, autumn, DAY, AT, log())

    expect(report.deficits).toHaveLength(1)
    expect(report.toppedUp).toBe(2)
    expect(track).toHaveBeenCalledWith({
      customerId: "ten-1",
      messageId: "m-1",
      // The bucket's own start, so a replay files the message in the same day.
      at: DAY,
    })
  })

  it("counts what Autumn already had rather than calling it a top-up", async () => {
    const { db } = fakeDb([
      [{ tenant_id: "ten-1", period_start: DAY, count: 2 }],
      [{ id: "m-1" }],
    ])
    const autumn = fakeAutumn({
      aggregateByCustomer: vi.fn(async () => [
        { tenantId: "ten-1", periodStart: DAY, count: 1 },
      ]),
      track: vi.fn(async () => "duplicate" as const),
    })

    const report = await reconcileUsage(db, autumn, DAY, AT, log())

    expect(report).toMatchObject({ toppedUp: 0, alreadyKnown: 1 })
  })

  // ⚠ REPORTED AND NEVER CORRECTED. Autumn counting more than we sent is a
  // duplicate somewhere, and negative usage would erase the evidence.
  it("reports a surplus without touching Autumn", async () => {
    const { db } = fakeDb([[{ tenant_id: "ten-1", period_start: DAY, count: 1 }]])
    const track = vi.fn()
    const autumn = fakeAutumn({
      aggregateByCustomer: vi.fn(async () => [
        { tenantId: "ten-1", periodStart: DAY, count: 5 },
      ]),
      track,
    })

    const report = await reconcileUsage(db, autumn, DAY, AT, log())

    expect(report.surpluses).toHaveLength(1)
    expect(report.toppedUp).toBe(0)
    expect(track).not.toHaveBeenCalled()
  })

  it("carries a bucket it could not finish to the next run", async () => {
    const { db } = fakeDb([
      [{ tenant_id: "ten-1", period_start: DAY, count: 2 }],
      [{ id: "m-1" }],
    ])
    const autumn = fakeAutumn({
      aggregateByCustomer: vi.fn(async () => []),
      track: vi.fn(async () => {
        throw new Error("autumn is down")
      }),
    })

    const report = await reconcileUsage(db, autumn, DAY, AT, log())

    expect(report).toMatchObject({ failed: 1, toppedUp: 0 })
  })

  it("does nothing when the two sides agree", async () => {
    const { db } = fakeDb([[{ tenant_id: "ten-1", period_start: DAY, count: 4 }]])
    const track = vi.fn()
    const autumn = fakeAutumn({
      aggregateByCustomer: vi.fn(async () => [
        { tenantId: "ten-1", periodStart: DAY, count: 4 },
      ]),
      track,
    })

    const report = await reconcileUsage(db, autumn, DAY, AT, log())

    expect(report.deficits).toEqual([])
    expect(report.surpluses).toEqual([])
    expect(track).not.toHaveBeenCalled()
  })
})
