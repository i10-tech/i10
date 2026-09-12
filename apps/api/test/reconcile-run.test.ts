import { describe, expect, it, mock } from "bun:test"
import type { SQL } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core"
import type { Database } from "../src/db/client.js"
import {
  reconcileSes,
  reconcileTenantCustomers,
  reconcileUsage,
} from "../src/send/reconcile-run.js"
import type { CustomerDirectory, UsageLedger } from "../src/send/reconcile.js"

const log = () => ({ info: mock(), warn: mock(), error: mock() })

/**
 * A database that answers each `execute` from a queue of results, in order.
 * Enough to test the orchestration; the statements themselves are covered by
 * reconcile.test.ts and reconcile-ses.test.ts.
 */
function fakeDb(results: unknown[][]) {
  const dialect = new PgDialect()
  // ⚠ `withTenant` issues its `set_config` on the same handle, so it would
  // otherwise eat the queued result the statement after it is waiting for.
  const execute = mock(async (query?: SQL) => {
    if (query && dialect.sqlToQuery(query).sql.includes("set_config")) return []
    return results.shift() ?? []
  })
  const db = {
    execute,
    transaction: async (fn: (tx: { execute: typeof execute }) => Promise<unknown>) =>
      fn({ execute }),
  } as unknown as Database
  return { db, execute }
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
      execute: mock(async () => {
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

/**
 * ⚠ IT IS A `UsageLedger`, WHICH IS ALL IT EVER NEEDED TO BE. This used to be
 * typed `AutumnClient` and cast, so the fake carried six methods
 * `reconcileUsage` never calls — `check`, `batchTrack`, `ensureCustomer` and
 * the rest — and the test read as though the reconciler depended on a vendor
 * client. It depends on two methods.
 */
function fakeLedger(over: Partial<UsageLedger> = {}): UsageLedger {
  return {
    track: mock(async () => "recorded" as const),
    aggregateByCustomer: mock(async () => []),
    ...over,
  }
}

/**
 * ⚠ A SECOND PORT, AND THE OLD SINGLE FAKE HID THAT THERE WERE TWO.
 * `reconcileUsage` needs a ledger; `reconcileTenantCustomers` needs a
 * directory. One object satisfying both made them look like one dependency,
 * which is exactly the coupling replacing Autumn was meant to remove.
 */
function fakeDirectory(over: Partial<CustomerDirectory> = {}): CustomerDirectory {
  return {
    listCustomerIds: mock(async () => []),
    customerExists: mock(async () => false as const),
    ...over,
  }
}

describe("the usage leg", () => {
  // ⚠ BY MESSAGE ID, NEVER BY COUNT. `track` is idempotent on the id, so a
  // repeated pass cannot double-bill; submitting "two more" would.
  it("tops up a deficit one message at a time", async () => {
    const { db } = fakeDb([
      [{ tenant_id: "ten-1", period_start: DAY, count: 3 }],
      [{ id: "m-1" }, { id: "m-2" }],
    ])
    const track = mock(async () => "recorded" as const)
    const ledger = fakeLedger({
      aggregateByCustomer: mock(async () => [
        { tenantId: "ten-1", periodStart: DAY, count: 1 },
      ]),
      track,
    })

    const report = await reconcileUsage(db, ledger, DAY, AT, log())

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
    const ledger = fakeLedger({
      aggregateByCustomer: mock(async () => [
        { tenantId: "ten-1", periodStart: DAY, count: 1 },
      ]),
      track: mock(async () => "duplicate" as const),
    })

    const report = await reconcileUsage(db, ledger, DAY, AT, log())

    expect(report).toMatchObject({ toppedUp: 0, alreadyKnown: 1 })
  })

  // ⚠ REPORTED AND NEVER CORRECTED. Autumn counting more than we sent is a
  // duplicate somewhere, and negative usage would erase the evidence.
  it("reports a surplus without touching Autumn", async () => {
    const { db } = fakeDb([[{ tenant_id: "ten-1", period_start: DAY, count: 1 }]])
    const track = mock()
    const ledger = fakeLedger({
      aggregateByCustomer: mock(async () => [
        { tenantId: "ten-1", periodStart: DAY, count: 5 },
      ]),
      track,
    })

    const report = await reconcileUsage(db, ledger, DAY, AT, log())

    expect(report.surpluses).toHaveLength(1)
    expect(report.toppedUp).toBe(0)
    expect(track).not.toHaveBeenCalled()
  })

  it("carries a bucket it could not finish to the next run", async () => {
    const { db } = fakeDb([
      [{ tenant_id: "ten-1", period_start: DAY, count: 2 }],
      [{ id: "m-1" }],
    ])
    const ledger = fakeLedger({
      aggregateByCustomer: mock(async () => []),
      track: mock(async () => {
        throw new Error("autumn is down")
      }),
    })

    const report = await reconcileUsage(db, ledger, DAY, AT, log())

    expect(report).toMatchObject({ failed: 1, toppedUp: 0 })
  })

  it("does nothing when the two sides agree", async () => {
    const { db } = fakeDb([[{ tenant_id: "ten-1", period_start: DAY, count: 4 }]])
    const track = mock()
    const ledger = fakeLedger({
      aggregateByCustomer: mock(async () => [
        { tenantId: "ten-1", periodStart: DAY, count: 4 },
      ]),
      track,
    })

    const report = await reconcileUsage(db, ledger, DAY, AT, log())

    expect(report.deficits).toEqual([])
    expect(report.surpluses).toEqual([])
    expect(track).not.toHaveBeenCalled()
  })
})

describe("the tenant/customer leg", () => {
  const tenants = [
    { tenant_id: "ten-1", slug: "one", name: "One" },
    { tenant_id: "ten-2", slug: "two", name: "Two" },
  ]

  it("says nothing when every tenant is a customer", async () => {
    const { db } = fakeDb([tenants])
    const directory = fakeDirectory({
      listCustomerIds: mock(async () => ["ten-1", "ten-2"]),
    })

    const report = await reconcileTenantCustomers(db, directory, log(), "free")

    expect(report).toMatchObject({ checked: 2, missing: [], unverified: [] })
    expect(directory.customerExists).not.toHaveBeenCalled()
  })

  /**
   * ⚠ THE NARROWING ONLY WORKS IF THE PLAN ID REACHES THE QUERY. The exclusion
   * itself lives in `core.paying_tenants_snapshot`, so a fake database cannot
   * demonstrate it — what this pins is the wiring: the caller's free plan id is
   * bound as a parameter rather than dropped, which is the half that can
   * regress here. Pass the wrong one and every free tenant is checked again,
   * which is the failure this whole change removes.
   */
  it("asks only for tenants off the free plan", async () => {
    const { db, execute } = fakeDb([tenants])
    await reconcileTenantCustomers(
      db,
      fakeDirectory({ listCustomerIds: mock(async () => ["ten-1", "ten-2"]) }),
      log(),
      "starter",
    )

    const rendered = new PgDialect().sqlToQuery(execute.mock.calls[0]![0]!)
    expect(rendered.sql).toContain("core.paying_tenants_snapshot(")
    expect(rendered.params).toEqual(["starter"])
  })

  it("confirms a candidate before reporting it", async () => {
    const { db } = fakeDb([tenants])
    const customerExists = mock(async () => false as const)
    const directory = fakeDirectory({
      listCustomerIds: mock(async () => ["ten-1"]),
      customerExists,
    })

    const report = await reconcileTenantCustomers(db, directory, log(), "free")

    expect(customerExists).toHaveBeenCalledTimes(1)
    expect(customerExists).toHaveBeenCalledWith("ten-2")
    expect(report.missing).toEqual([{ tenantId: "ten-2", slug: "two", name: "Two" }])
  })

  // ⚠ THE PAGING RACE. `customers.list` walks a list that can change underneath
  // it, so a customer created between two pages is sorted ahead of where the
  // walk already is and is missed. The point lookup is what stops that being
  // reported as a tenant with no billing customer.
  it("drops a candidate the point lookup finds after all", async () => {
    const { db } = fakeDb([tenants])
    const directory = fakeDirectory({
      listCustomerIds: mock(async () => ["ten-1"]),
      customerExists: mock(async () => true as const),
    })

    const report = await reconcileTenantCustomers(db, directory, log(), "free")

    expect(report.missing).toEqual([])
    expect(report.unverified).toEqual([])
  })

  // ⚠ AN OUTAGE MUST NOT MASQUERADE AS A FINDING. Anything but a 404 is "could
  // not find out", and folding it into `missing` would report every tenant as
  // unbilled the first time the meter had a bad afternoon.
  it("keeps an unanswerable candidate out of the findings", async () => {
    const { db } = fakeDb([tenants])
    const directory = fakeDirectory({
      listCustomerIds: mock(async () => []),
      customerExists: mock(async () => "unknown" as const),
    })

    const report = await reconcileTenantCustomers(db, directory, log(), "free")

    expect(report.missing).toEqual([])
    expect(report.unverified).toHaveLength(2)
  })

  it("treats a thrown confirmation as unverified rather than absent", async () => {
    const { db } = fakeDb([tenants])
    const directory = fakeDirectory({
      listCustomerIds: mock(async () => ["ten-1"]),
      customerExists: mock(async () => {
        throw new Error("the meter is down")
      }),
    })

    const report = await reconcileTenantCustomers(db, directory, log(), "free")

    expect(report.missing).toEqual([])
    expect(report.unverified).toHaveLength(1)
  })

  // A failed list is not "no customers exist", which would report every tenant.
  it("propagates a failed list rather than reporting everyone", async () => {
    const { db } = fakeDb([tenants])
    const directory = fakeDirectory({
      listCustomerIds: mock(async () => {
        throw new Error("customers.list failed with 500")
      }),
    })

    await expect(
      reconcileTenantCustomers(db, directory, log(), "free"),
    ).rejects.toThrow(/customers.list failed/)
  })
})
