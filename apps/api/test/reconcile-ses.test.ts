import type { SQL } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core"
import { describe, expect, it } from "vitest"
import {
  billedButUnconfirmedStatement,
  EVENT_GRACE,
  needsAttention,
  orphanEventsStatement,
  repairFromSesStatement,
  sesSentButUnbilledStatement,
  type SesReconcileReport,
} from "../src/send/reconcile-ses.js"

const dialect = new PgDialect()
const render = (q: SQL) => dialect.sqlToQuery(q)
const at = (iso: string) => new Date(iso)

const finding = (n: number) => ({ messageId: `m-${n}`, tenantId: "ten-1" })
const report = (over: Partial<SesReconcileReport> = {}): SesReconcileReport => ({
  unbilled: [],
  unconfirmed: [],
  orphaned: [],
  ...over,
})

describe("SES sent it, we did not bill it", () => {
  const q = () => render(sesSentButUnbilledStatement(500))

  // ⚠ The expected outcome of at-least-once, not a bug: the worker called SES,
  // SES accepted, the process died before writing the result.
  it("finds rows SES confirmed that are not marked sent", () => {
    const { sql: statement } = q()
    expect(statement).toContain("e.type = 'sent'")
    expect(statement).toContain("m.status <> 'sent'")
  })

  it("joins on our own id, which travels to SES as a message tag", () => {
    expect(q().sql).toContain("m.id = e.message_id")
  })

  // ⚠ Without the grace, every message still in flight is reported as missing,
  // because SES publishes events on its own schedule.
  it("ignores anything inside the event grace period", () => {
    const { sql: statement, params } = q()
    expect(statement).toContain("e.occurred_at < now() -")
    expect(statement).toContain("::interval")
    expect(params).toContain(EVENT_GRACE)
  })

  it("takes the oldest first and is bounded", () => {
    expect(q().sql).toContain("order by e.occurred_at")
    expect(q().sql).toContain("limit")
  })
})

describe("the repair", () => {
  const q = () =>
    render(
      repairFromSesStatement(
        "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6071",
        at("2026-09-02T10:00:00.000Z"),
        at("2026-09-02T10:00:05.000Z"),
        "ses-abc",
      ),
    )

  // ⚠ THE ONE THAT WOULD DOUBLE-BILL. Two reconcilers, or one retried, must not
  // rewrite sent_at and move the message into a different Autumn bucket.
  it("refuses to touch a row that is already sent", () => {
    expect(q().sql).toContain("status <> 'sent'")
    expect(q().sql).toContain("returning id")
  })

  // ⚠ The Autumn reconciler buckets on sent_at. Stamping now() would file the
  // message in the day it was noticed rather than the day it went.
  it("stamps SES's time, never now()", () => {
    const { sql: statement, params } = q()
    expect(statement).toContain("sent_at        =")
    expect(statement).not.toContain("sent_at        = now()")
    expect(params).toContain("2026-09-02T10:00:05.000Z")
  })

  it("matches the full primary key, because the table is partitioned", () => {
    expect(q().sql).toContain("id =")
    expect(q().sql).toContain("created_at =")
  })

  it("keeps an existing ses id rather than overwriting it", () => {
    expect(q().sql).toContain("coalesce(ses_message_id,")
  })

  it("releases the abandoned claim", () => {
    expect(q().sql).toContain("claimed_by     = null")
    expect(q().sql).toContain("claimed_at     = null")
  })
})

describe("we billed it, SES never confirmed", () => {
  const q = () => render(billedButUnconfirmedStatement(at("2026-09-01T00:00:00Z"), 200))

  it("looks for sent rows with no matching sent event", () => {
    const { sql: statement } = q()
    expect(statement).toContain("m.status = 'sent'")
    expect(statement).toContain("not exists")
    expect(statement).toContain("e.type = 'sent'")
  })

  // Same grace, opposite direction — a message sent a minute ago has not had
  // time to be confirmed.
  it("applies the event grace here too", () => {
    expect(q().params).toContain(EVENT_GRACE)
  })

  // ⚠ Reported, never repaired. The likeliest cause is that the event
  // destination stopped delivering, and un-sending these would hide it.
  it("only reads", () => {
    expect(q().sql).toMatch(/^\s*select/)
    expect(q().sql).not.toContain("update")
  })
})

describe("events for messages we have never heard of", () => {
  const q = () => render(orphanEventsStatement(at("2026-09-01T00:00:00Z"), 100))

  it("finds sent events with no message row", () => {
    const { sql: statement } = q()
    expect(statement).toContain("not exists")
    expect(statement).toContain("core.messages m where m.id = e.message_id")
  })

  // ⚠ A row cannot be invented from an event — it carries no sender, no
  // recipients and no api key, so anything written would be a fabricated
  // billing record.
  it("only reads", () => {
    expect(q().sql).toMatch(/^\s*select/)
    expect(q().sql).not.toContain("insert")
    expect(q().sql).not.toContain("update")
  })
})

describe("deciding whether to wake somebody", () => {
  // ⚠ Routine by design. The at-least-once window guarantees a trickle, and the
  // repair is the system working — paging on it teaches everyone to ignore it.
  it("stays quiet for repairs alone, however many", () => {
    expect(
      needsAttention(
        report({ unbilled: Array.from({ length: 5000 }, (_, i) => finding(i)) }),
      ),
    ).toBe(false)
  })

  // Mail left the account with no record of it: a security finding, not an
  // accounting one.
  it("alerts on a single orphaned event", () => {
    expect(needsAttention(report({ orphaned: [finding(1)] }))).toBe(true)
  })

  // ⚠ The failure that hides the failure. If events stop arriving, the
  // unbilled detection silently stops working too.
  it("alerts when confirmations dry up in bulk", () => {
    const many = Array.from({ length: 50 }, (_, i) => finding(i))
    expect(needsAttention(report({ unconfirmed: many }))).toBe(true)
    expect(needsAttention(report({ unconfirmed: many.slice(0, 49) }))).toBe(false)
  })

  it("takes a threshold, because the right number is deployment-specific", () => {
    expect(needsAttention(report({ unconfirmed: [finding(1)] }), 1)).toBe(true)
  })

  it("says nothing when everything agrees", () => {
    expect(needsAttention(report())).toBe(false)
  })
})
