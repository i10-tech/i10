import type { SQL } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core"
import { describe, expect, it } from "vitest"
import {
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

describe("what i10 believes it sent", () => {
  const { sql: statement } = render(sentUsageStatement(day("01"), day("03")))

  // ⚠ Acceptance is not delivery. Billing on created_at charges for messages
  // that never went, and puts a message accepted at 23:59 in the wrong day.
  it("clocks on sent_at, never created_at", () => {
    expect(statement).toContain("m.sent_at >=")
    expect(statement).toContain("m.sent_at <")
    expect(statement).not.toContain("created_at >=")
  })

  // A row in `sending` is undecided; billing it charges for a message that may
  // still fail permanently.
  it("counts only `sent`", () => {
    expect(statement).toContain("m.status = 'sent'")
    expect(statement).not.toContain("'sending'")
    expect(statement).not.toContain("'queued'")
  })

  it("groups per tenant per day", () => {
    expect(statement).toContain("m.tenant_id")
    expect(statement).toContain("date_trunc('day'")
    expect(statement).toContain("group by")
  })

  // The bucket boundary has to be the same clock Autumn's events carry, or
  // every bucket disagrees by an offset and the reconciler tops up forever.
  it("truncates in UTC explicitly", () => {
    expect(statement).toContain("at time zone 'UTC'")
  })

  it("is half-open, so adjacent windows neither skip nor double-count", () => {
    expect(statement).toMatch(/sent_at >=.*\n.*sent_at </s)
  })

  it("binds the window rather than inlining it", () => {
    const { params } = render(sentUsageStatement(day("01"), day("03")))
    expect(params).toContain(day("01").toISOString())
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
