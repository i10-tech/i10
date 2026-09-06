import { readFileSync } from "node:fs"
import type { SQL } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core"
import { describe, expect, it } from "vitest"
import {
  activeTenantsStatement,
  missingCustomers,
  reconcile,
  sentUsageStatement,
  unbilledIdsStatement,
  type UsageBucket,
} from "../src/send/reconcile.js"

const dialect = new PgDialect()
const render = (q: SQL) => dialect.sqlToQuery(q)

const day = (d: string) => new Date(`2026-09-${d}T00:00:00.000Z`)
const bucket = (tenantId: string, d: string, count: number): UsageBucket => ({
  tenantId,
  periodStart: day(d),
  count,
})

/**
 * ⚠ THE GUARANTEES MOVED INTO A MIGRATION, SO THE ASSERTIONS FOLLOWED THEM.
 * These properties used to be pinned against the statement this file builds;
 * they now live in `core.sent_usage_snapshot`, because the question spans every
 * tenant and row level security means no tenant-scoped connection can ask it —
 * outside a `withTenant()` transaction the old statement raised rather than
 * returning rows. Asserting the function body is the only place left where
 * "billed on `sent_at`, in UTC, half-open, `sent` only" is still checked, and
 * dropping the assertions along with the SQL would have quietly retired four
 * guarantees at once.
 */
const migration = readFileSync(
  new URL("../drizzle/0013_metering_snapshots.sql", import.meta.url),
  "utf8",
)

const functionBody = (name: string) => {
  const start = migration.indexOf(`CREATE FUNCTION "core"."${name}"`)
  expect(start, `${name} is not in 0013`).toBeGreaterThan(-1)
  return migration.slice(start, migration.indexOf("$$;", start))
}

describe("what i10 believes it sent", () => {
  const body = functionBody("sent_usage_snapshot")

  // ⚠ Acceptance is not delivery. Billing on created_at charges for messages
  // that never went, and puts a message accepted at 23:59 in the wrong day.
  it("clocks on sent_at, never created_at", () => {
    expect(body).toContain("m.sent_at >= p_from")
    expect(body).toContain("m.sent_at <  p_to")
    expect(body).not.toContain("created_at >=")
  })

  // A row in `sending` is undecided; billing it charges for a message that may
  // still fail permanently.
  it("counts only `sent`", () => {
    expect(body).toContain("m.status = 'sent'")
    expect(body).not.toContain("'sending'")
    expect(body).not.toContain("'queued'")
  })

  it("groups per tenant per day", () => {
    expect(body).toContain("m.tenant_id")
    expect(body).toContain("date_trunc('day'")
    expect(body).toContain("GROUP BY")
  })

  // The bucket boundary has to be the same clock the meter's events carry, or
  // every bucket disagrees by an offset and the reconciler tops up forever.
  it("truncates in UTC explicitly", () => {
    expect(body).toContain("AT TIME ZONE 'UTC'")
  })

  it("is half-open, so adjacent windows neither skip nor double-count", () => {
    expect(body).toMatch(/sent_at >=.*\n.*sent_at </s)
  })

  /**
   * ⚠ THE TWO SIDES OF THE COMPARISON MUST BUCKET IDENTICALLY. One clocking in
   * UTC and the other in the session's timezone disagree by an offset every
   * single day, and the reconciler then tops up the same messages forever.
   */
  it("buckets the meter side exactly as it buckets ours", () => {
    const ours = functionBody("sent_usage_snapshot")
    const theirs = functionBody("meter_usage_snapshot")
    expect(theirs).toContain("date_trunc('day'")
    expect(theirs).toContain("AT TIME ZONE 'UTC'")
    expect(ours).toContain("date_trunc('day'")
  })

  // ⚠ `sum(value)`, not `count(*)`: a row is not necessarily one unit, and
  // counting rows would bill any future multi-unit feature at one.
  it("sums the meter's values rather than counting its rows", () => {
    expect(functionBody("meter_usage_snapshot")).toContain("sum(e.value)")
  })

  it("is read through the function, never off the table", () => {
    const { sql: statement, params } = render(sentUsageStatement(day("01"), day("03")))
    expect(statement).toContain("core.sent_usage_snapshot(")
    expect(statement).not.toContain("from core.messages")
    expect(params).toHaveLength(2)
  })
})

describe("finding the unbilled messages", () => {
  const q = () => render(unbilledIdsStatement("ten-1", day("01"), day("02"), 500))

  // ⚠ IDS, NOT A COUNT. Autumn's single `track` takes an Idempotency-Key and
  // 409s a replay, so an id is safe to submit repeatedly. "Seventeen more" is
  // not: two reconciler runs would add thirty-four.
  it("returns ids", () => {
    expect(q().sql).toContain("m.id::text")
  })

  it("scopes to one tenant and one bucket", () => {
    const { sql: statement, params } = q()
    expect(statement).toContain("m.tenant_id =")
    expect(statement).toContain("m.status = 'sent'")
    expect(params).toContain("ten-1")
  })

  // Autumn rate-limits to 10 requests/second per organisation and the top-up is
  // one request per message, so an unbounded deficit has to be worked through
  // in slices rather than in one run.
  it("is bounded", () => {
    expect(q().sql).toContain("limit")
  })

  it("takes the oldest first, so a partial run still makes progress", () => {
    expect(q().sql).toContain("order by m.sent_at")
  })
})

describe("comparing the two sides", () => {
  it("says nothing when they agree", () => {
    const ours = [bucket("a", "01", 10), bucket("b", "01", 3)]
    expect(reconcile(ours, [...ours])).toEqual({ deficits: [], surpluses: [] })
  })

  it("reports a deficit when Autumn is behind", () => {
    const result = reconcile([bucket("a", "01", 10)], [bucket("a", "01", 7)])
    expect(result.deficits).toEqual([
      { tenantId: "a", periodStart: day("01"), ours: 10, theirs: 7, deficit: 3 },
    ])
    expect(result.surpluses).toEqual([])
  })

  it("treats a bucket Autumn has never seen as a full deficit", () => {
    const result = reconcile([bucket("a", "01", 4)], [])
    expect(result.deficits[0]).toMatchObject({ ours: 4, theirs: 0, deficit: 4 })
  })

  // ⚠ NEVER AUTO-CORRECTED. Autumn counting more than we sent means something
  // recorded a duplicate, and issuing negative usage would erase the only
  // evidence of it — and is itself a way to under-bill by accident.
  it("reports a surplus separately and never as a deficit", () => {
    const result = reconcile([bucket("a", "01", 5)], [bucket("a", "01", 9)])
    expect(result.deficits).toEqual([])
    expect(result.surpluses).toEqual([
      { tenantId: "a", periodStart: day("01"), ours: 5, theirs: 9, deficit: -4 },
    ])
  })

  // ⚠ The shape a mis-attributed customer id takes: usage recorded against a
  // tenant that sent nothing. Iterating only over our own buckets would miss it
  // entirely, and it is the case that bills the wrong person.
  it("catches usage against a tenant that sent nothing at all", () => {
    const result = reconcile([], [bucket("ghost", "01", 12)])
    expect(result.deficits).toEqual([])
    expect(result.surpluses).toEqual([
      { tenantId: "ghost", periodStart: day("01"), ours: 0, theirs: 12, deficit: -12 },
    ])
  })

  it("keeps tenants and days apart rather than summing them", () => {
    const result = reconcile(
      [bucket("a", "01", 5), bucket("a", "02", 5), bucket("b", "01", 5)],
      [bucket("a", "01", 5), bucket("a", "02", 1), bucket("b", "01", 5)],
    )
    expect(result.deficits).toHaveLength(1)
    expect(result.deficits[0]).toMatchObject({ tenantId: "a", deficit: 4 })
    expect(result.deficits[0]!.periodStart).toEqual(day("02"))
  })

  it("ignores an empty bucket on either side", () => {
    expect(reconcile([bucket("a", "01", 0)], [])).toEqual({
      deficits: [],
      surpluses: [],
    })
    expect(reconcile([], [bucket("a", "01", 0)])).toEqual({
      deficits: [],
      surpluses: [],
    })
  })

  // Two reconcilers racing, or one retried, must reach the same answer — the
  // safety net itself cannot be a source of double-billing.
  it("is a pure function of its inputs", () => {
    const ours = [bucket("a", "01", 10)]
    const theirs = [bucket("a", "01", 7)]
    expect(reconcile(ours, theirs)).toEqual(reconcile(ours, theirs))
  })
})

describe("every tenant should exist as a customer", () => {
  const tenants = [
    { tenantId: "a", slug: "acme", name: "Acme" },
    { tenantId: "b", slug: "globex", name: "Globex" },
  ]

  it("says nothing when they all do", () => {
    expect(missingCustomers(tenants, ["a", "b", "c"])).toEqual([])
  })

  // ⚠ A DIFFERENT KIND OF ERROR FROM A DRIFTED NUMBER. A tenant Autumn has
  // never heard of means every track call for it has been failing since the
  // tenant was created — and the usage reconciler cannot see it, because both
  // sides read zero and agree.
  it("finds a tenant the billing side has never heard of", () => {
    expect(missingCustomers(tenants, ["a"])).toEqual([
      { tenantId: "b", slug: "globex", name: "Globex" },
    ])
  })

  // The tenant you most want to find is the one that has not sent yet.
  it("checks every active tenant, not only ones that sent something", () => {
    expect(missingCustomers(tenants, [])).toHaveLength(2)
  })
})

describe("the active-tenant list", () => {
  it("excludes suspended tenants, which are not expected to be billable", () => {
    expect(functionBody("active_tenants_snapshot")).toContain("t.status = 'active'")
  })

  it("is read through the function, never off the table", () => {
    const { sql: statement } = render(activeTenantsStatement())
    expect(statement).toContain("core.active_tenants_snapshot()")
    expect(statement).not.toContain("from core.tenants")
  })
})
