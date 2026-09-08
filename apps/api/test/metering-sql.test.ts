import { PgDialect } from "drizzle-orm/pg-core"
import type { SQL } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import {
  assignStatement,
  assignmentStatement,
  ensureStatement,
  recordStatement,
  usedInStatement,
} from "../src/metering/postgres.js"
import type { MeterKey } from "@repo/metering"

/**
 * These assert the SQL, without a database.
 *
 * Every property below is one whose regression bills a customer twice, hands
 * them an allowance they did not buy, or moves a boundary that was supposed to
 * be fixed forever — and none of them are visible in a return value. They live
 * in the statement text.
 */
const dialect = new PgDialect()
const render = (q: SQL) => dialect.sqlToQuery(q)

const TENANT = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6071"
const KEY: MeterKey = { tenantId: TENANT, featureId: "emails", shard: 0 }
const WINDOW = {
  start: new Date("2026-02-01T00:00:00.000Z"),
  end: new Date("2026-03-01T00:00:00.000Z"),
}

describe("assigning a plan", () => {
  /**
   * ⚠ THE ASSERTION THIS FILE EXISTS FOR. An anchor that moves on every
   * assignment hands every customer a free reset — exhaust the allowance,
   * change plan, start a fresh window — and makes the old and new windows
   * overlap, so the ledger's buckets stop partitioning time.
   */
  it("never updates the anchor", () => {
    const { sql: statement } = render(
      assignStatement({ tenantId: TENANT, planId: "pro", anchor: WINDOW.start }),
    )
    expect(statement).toContain("do update")
    expect(statement).toContain("plan_id    = excluded.plan_id")
    expect(statement).not.toMatch(/set[\s\S]*anchor/)
  })

  it("upserts on the tenant, so a second assignment moves the same row", () => {
    const { sql: statement } = render(
      assignStatement({ tenantId: TENANT, planId: "pro", anchor: WINDOW.start }),
    )
    expect(statement).toContain("on conflict (tenant_id)")
  })

  it("joins the plan so a catalogue row and a custom one read the same", () => {
    const { sql: statement } = render(assignmentStatement(TENANT))
    expect(statement).toContain("join core.plans")
    expect(statement).toContain("a.tenant_id = $1::uuid")
  })
})

describe("reading a window", () => {
  /**
   * ⚠ HALF-OPEN, MATCHING `windowFor`. With both ends inclusive an event on the
   * boundary is billed in two periods at once, and the two sides of the
   * reconciler disagree by however many landed on the tick — forever, because
   * a closed period cannot be corrected.
   */
  it("is inclusive at the start and exclusive at the end", () => {
    const { sql: statement } = render(usedInStatement(KEY, WINDOW))
    expect(statement).toContain("occurred_at >= $4")
    expect(statement).toContain("occurred_at < $5")
  })

  // ⚠ A LIFETIME ALLOWANCE HAS NO END, SO THE PREDICATE MUST NOT BE THERE AT
  // ALL. A bound of `null` would compare against NULL and match nothing, and a
  // credit pack would read as entirely unspent no matter how much was used.
  it("has no upper bound for a lifetime window", () => {
    const { sql: statement } = render(
      usedInStatement(KEY, { start: WINDOW.start, end: null }),
    )
    expect(statement).toContain("occurred_at >= $4")
    expect(statement).not.toContain("occurred_at <")
  })

  it("scopes to one shard, because the gate does", () => {
    const { sql: statement } = render(usedInStatement(KEY, WINDOW))
    expect(statement).toContain("shard       = $3")
  })

  // ⚠ `sum()` over an integer column is bigint, which postgres-js hands back as
  // a string. Casting keeps that predictable rather than depending on the
  // driver's type map.
  it("sums to a defined zero rather than to null", () => {
    const { sql: statement } = render(usedInStatement(KEY, WINDOW))
    expect(statement).toContain("coalesce(sum(value), 0)::bigint")
  })
})

describe("recording usage", () => {
  const events = [
    { id: "msg_1", at: WINDOW.start, value: 1 },
    { id: "msg_2", at: WINDOW.start, value: 1 },
  ]

  /**
   * ⚠ DO NOTHING, NOT DO UPDATE, AND THIS IS WHAT MAKES EVERY LEG OF THE
   * PIPELINE INDEPENDENTLY RETRYABLE. `DO UPDATE` would let a replay carrying a
   * different value rewrite history that has already been invoiced.
   */
  it("ignores a replay rather than rewriting it", () => {
    const { sql: statement } = render(recordStatement(KEY, events))
    expect(statement).toContain(
      "on conflict (tenant_id, feature_id, event_id) do nothing",
    )
    expect(statement).not.toContain("do update")
  })

  // ⚠ WITHOUT `shard`, so the same message cannot be counted twice by being
  // replayed against a different shard than the one that first recorded it.
  it("conflicts on the message id, not on the shard", () => {
    const { sql: statement } = render(recordStatement(KEY, events))
    expect(statement).not.toContain("shard, event_id")
    expect(statement).toContain("feature_id, event_id) do nothing")
  })

  it("returns only the rows that were new", () => {
    const { sql: statement } = render(recordStatement(KEY, events))
    expect(statement.trimEnd().endsWith("returning event_id")).toBe(true)
  })

  it("sends one statement for the whole batch", () => {
    const { sql: statement, params } = render(recordStatement(KEY, events))
    expect(statement.match(/insert into/g)).toHaveLength(1)
    // Six bound values per row, and nothing interpolated into the text.
    expect(params).toHaveLength(12)
    expect(statement).not.toContain("msg_1")
  })
})

/**
 * ⚠ THE ASSERTION THAT WOULD HAVE CAUGHT THREE LIVE FAILURES, AND DID NOT
 * EXIST. postgres.js binds a parameter by writing its bytes, so a `Date` throws
 * `ERR_INVALID_ARG_TYPE` before the query reaches the server. Every other test
 * in this file renders SQL and never binds, so the whole suite passed against
 * statements that could not run at all.
 *
 * `ensureStatement` is the signup path: it failed on the first tenant ever
 * provisioned through it, which is logged as "tenant created without an
 * entitlement" and means that customer's first send is refused. `recordStatement`
 * is every metered send. Neither had sent a byte in production, so nothing
 * disagreed with anything and no reconciler had a discrepancy to report.
 *
 * ⚠ AND THE CAST TRAVELS WITH THE STRING. Once the parameter is text, Postgres
 * has to be told it is a timestamp, or it resolves the column against `text`
 * and fails further along for an unrelated-looking reason.
 *
 * The same defect and the same fix as send/reconcile.ts — see the matching
 * guard in reconcile.test.ts. Any new statement binding a timestamp belongs
 * here too.
 */
describe("what actually reaches postgres", () => {
  it("binds strings, never Date objects", () => {
    const statements = [
      assignStatement({ tenantId: TENANT, planId: "pro", anchor: WINDOW.start }),
      ensureStatement({ tenantId: TENANT, planId: "free", anchor: WINDOW.start }),
      recordStatement(KEY, [{ id: "msg_1", at: WINDOW.start, value: 1 }]),
    ]

    for (const statement of statements) {
      const { params, sql: text } = render(statement)
      for (const param of params) expect(param).not.toBeInstanceOf(Date)
      expect(text).toContain("::timestamptz")
    }
  })
})
