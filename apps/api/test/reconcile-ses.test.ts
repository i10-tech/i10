import { readFileSync } from "node:fs"
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

/**
 * ⚠ THE GUARANTEES MOVED INTO A MIGRATION, SO THE ASSERTIONS FOLLOWED THEM.
 * Same move 0013 made for the usage leg, and for the same reason: these
 * questions span every tenant, row level security means no tenant-scoped
 * connection can ask them, and outside a `withTenant()` transaction each of
 * these statements raised rather than returning rows. Asserting the function
 * bodies is the only place left where the grace, the join, the guards and the
 * read-only-ness are still checked, and dropping them with the SQL would have
 * retired a dozen guarantees at once.
 */
const migration = readFileSync(
  new URL("../drizzle/0028_ses_reconcile_definers.sql", import.meta.url),
  "utf8",
)

const functionBody = (name: string) => {
  const start = migration.indexOf(`CREATE FUNCTION "core"."${name}"`)
  expect(start, `${name} is not in 0028`).toBeGreaterThan(-1)
  return migration.slice(start, migration.indexOf("$$;", start))
}

/**
 * ⚠ EVERY ONE OF THESE IS `SECURITY DEFINER`, WHICH IS THE POINT OF 0028 AND
 * ALSO ITS ONE DANGER. A definer routine runs as the owner with RLS bypassed,
 * so the checks below are not style — they are the boundary.
 */
describe("the reconciler can ask at all", () => {
  for (const name of [
    "ses_unbilled_snapshot",
    "ses_unconfirmed_snapshot",
    "ses_orphan_snapshot",
    "repair_from_ses",
  ]) {
    it(`${name} is a definer with a pinned search_path`, () => {
      const body = functionBody(name)
      expect(body).toContain("SECURITY DEFINER")
      expect(body).toContain("SET search_path = core, pg_temp")
    })
  }

  // ⚠ The three reads are STABLE so the planner runs them once; the repair
  // WRITES and must not be, or Postgres is entitled to skip the work.
  it("marks the reads stable and the write volatile", () => {
    for (const name of [
      "ses_unbilled_snapshot",
      "ses_unconfirmed_snapshot",
      "ses_orphan_snapshot",
    ]) {
      expect(functionBody(name)).toContain("STABLE")
    }
    expect(functionBody("repair_from_ses")).toContain("VOLATILE")
  })

  // ⚠ Only the API role. A definer function is an RLS bypass with a name, so
  // who may call it is the whole of its security.
  it("grants execute to i10_api and nobody else", () => {
    const grants = migration.match(/GRANT EXECUTE ON FUNCTION [^;]+;/g) ?? []
    expect(grants).toHaveLength(4)
    for (const grant of grants) expect(grant).toContain("TO i10_api")
  })
})

describe("SES sent it, we did not bill it", () => {
  const body = functionBody("ses_unbilled_snapshot")

  // ⚠ The expected outcome of at-least-once, not a bug: the worker called SES,
  // SES accepted, the process died before writing the result.
  it("finds rows SES confirmed that are not marked sent", () => {
    expect(body).toContain("e.type = 'sent'")
    expect(body).toContain("m.status <> 'sent'")
  })

  it("joins on our own id, which travels to SES as a message tag", () => {
    expect(body).toContain("m.id = e.message_id")
  })

  // ⚠ Without the grace, every message still in flight is reported as missing,
  // because SES publishes events on its own schedule.
  it("ignores anything inside the event grace period", () => {
    expect(body).toContain("e.occurred_at < now() - p_grace")
  })

  it("takes the oldest first and is bounded", () => {
    expect(body).toContain("ORDER BY e.occurred_at")
    expect(body).toContain("LIMIT p_limit")
  })

  // ⚠ THE GRACE IS PASSED, NOT DUPLICATED. EVENT_GRACE carries the reasoning
  // that sets it; a copy in the migration would drift, and the job would then
  // manufacture findings while the comment explaining why it cannot still
  // stands.
  it("passes the grace and the limit from here", () => {
    const { sql: statement, params } = render(sesSentButUnbilledStatement(500))
    expect(statement).toContain("core.ses_unbilled_snapshot(")
    expect(params).toContain(EVENT_GRACE)
    expect(params).toContain(500)
  })
})

describe("the repair", () => {
  const body = functionBody("repair_from_ses")

  // ⚠ THE ONE THAT WOULD DOUBLE-BILL. Two reconcilers, or one retried, must not
  // rewrite sent_at and move the message into a different billing bucket. And
  // with RLS bypassed this guard is also what stops the function being "set any
  // message to sent at any timestamp".
  it("refuses to touch a row that is already sent", () => {
    expect(body).toContain("AND status <> 'sent'")
    expect(body).toContain("RETURNING id")
  })

  // ⚠ The usage reconciler buckets on sent_at. Stamping now() would file the
  // message in the day it was noticed rather than the day it went.
  it("stamps SES's time, never now()", () => {
    expect(body).toContain("sent_at        = p_sent_at")
    expect(body).not.toContain("sent_at        = now()")
  })

  it("matches the full primary key, because the table is partitioned", () => {
    expect(body).toContain("WHERE id = p_message_id")
    expect(body).toContain("AND created_at = p_created_at")
  })

  it("keeps an existing ses id rather than overwriting it", () => {
    expect(body).toContain("coalesce(ses_message_id, p_ses_message_id)")
  })

  it("releases the abandoned claim", () => {
    expect(body).toContain("claimed_by     = null")
    expect(body).toContain("claimed_at     = null")
  })

  it("passes the whole key, not just the id", () => {
    const { sql: statement, params } = render(
      repairFromSesStatement(
        "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6071",
        at("2026-09-02T10:00:00.000Z"),
        at("2026-09-02T10:00:05.000Z"),
        "ses-abc",
      ),
    )
    expect(statement).toContain("core.repair_from_ses(")
    expect(params).toContain("2026-09-02T10:00:00.000Z")
    expect(params).toContain("2026-09-02T10:00:05.000Z")
    expect(params).toContain("ses-abc")
  })
})

describe("we billed it, SES never confirmed", () => {
  const body = functionBody("ses_unconfirmed_snapshot")

  it("looks for sent rows with no matching sent event", () => {
    expect(body).toContain("m.status = 'sent'")
    expect(body).toContain("NOT EXISTS")
    expect(body).toContain("e.type = 'sent'")
  })

  // Same grace, opposite direction — a message sent a minute ago has not had
  // time to be confirmed.
  it("applies the event grace here too", () => {
    expect(body).toContain("m.sent_at <  now() - p_grace")
    expect(
      render(billedButUnconfirmedStatement(at("2026-09-01T00:00:00Z"), 200)).params,
    ).toContain(EVENT_GRACE)
  })

  // ⚠ Reported, never repaired. The likeliest cause is that the event
  // destination stopped delivering, and un-sending these would hide it.
  it("only reads", () => {
    expect(body).toContain("SELECT")
    expect(body).not.toContain("UPDATE")
    expect(body).not.toContain("INSERT")
  })
})

describe("events for messages we have never heard of", () => {
  const body = functionBody("ses_orphan_snapshot")

  it("finds sent events with no message row", () => {
    expect(body).toContain("NOT EXISTS")
    expect(body).toContain("FROM core.messages m WHERE m.id = e.message_id")
  })

  // ⚠ A row cannot be invented from an event — it carries no sender, no
  // recipients and no api key, so anything written would be a fabricated
  // billing record.
  it("only reads", () => {
    expect(body).toContain("SELECT")
    expect(body).not.toContain("INSERT")
    expect(body).not.toContain("UPDATE")
  })

  it("is bounded and oldest-first", () => {
    expect(body).toContain("ORDER BY e.occurred_at")
    expect(body).toContain("LIMIT p_limit")
    expect(
      render(orphanEventsStatement(at("2026-09-01T00:00:00Z"), 100)).params,
    ).toContain(100)
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
