import { PgDialect } from "drizzle-orm/pg-core"
import type { SQL } from "drizzle-orm"
import { describe, expect, it } from "bun:test"
import {
  claimStatement,
  markFailedStatement,
  markSentStatement,
  type MessageRef,
} from "../src/db/claim.js"

/**
 * These assert the SQL, without a database.
 *
 * Every property below is one whose regression sends a customer's email twice
 * or not at all, and none of them are visible in a test that only checks return
 * values — they live in the statement text.
 */
const dialect = new PgDialect()

const A: MessageRef = {
  id: "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6071",
  createdAt: new Date("2026-09-02T10:00:00.000Z"),
}
const B: MessageRef = {
  id: "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6072",
  createdAt: new Date("2026-09-02T10:00:01.000Z"),
}

const render = (q: SQL) => dialect.sqlToQuery(q)
const claim = (refs: MessageRef[] = [A]) =>
  render(claimStatement(refs, { workerId: "worker-1", staleAfter: "5 minutes" }))

describe("the claim", () => {
  // ⚠ THE WHOLE POINT. Check-then-take across two statements is a race two
  // workers lose together; UPDATE ... RETURNING is one.
  it("takes and reports in a single statement", () => {
    const { sql: statement } = claim()
    expect(statement).toMatch(/^\s*update core\.messages/)
    expect(statement).toContain("returning")
    expect(statement).not.toContain("select")
  })

  it("matches on the full primary key, because the table is partitioned", () => {
    const { sql: statement } = claim()
    expect(statement).toContain("m.id = v.id")
    expect(statement).toContain("m.created_at = v.created_at")
  })

  // ⚠ Without this a worker that dies mid-send strands its rows in `sending`
  // forever — no error, no retry, the mail simply never arrives.
  it("reclaims a stale `sending` row as well as a queued one", () => {
    const { sql: statement } = claim()
    expect(statement).toContain("m.status = 'queued'")
    expect(statement).toContain("m.status = 'sending'")
    expect(statement).toContain("m.claimed_at < now() -")
  })

  // ⚠ THE GUARANTEE BEHIND `scheduled_at`, AND IT IS THIS RATHER THAN THE QUEUE.
  // Redis delaying the job is an optimisation; a job promoted early, a sweep
  // that re-enqueues a waiting row, or a worker run by hand would all otherwise
  // send a scheduled message ahead of its time.
  it("never claims a message before it is due", () => {
    const { sql: statement } = claim()
    const where = statement.slice(statement.indexOf("where"))
    expect(where).toContain("m.scheduled_at is null or m.scheduled_at <= now()")
  })

  // ⚠ THE PROPERTY THAT MAKES BATCHING SAFE. A worker dying 400 messages into a
  // batch of 500 leaves those 400 as `sent`; the job goes back to the queue and
  // is re-claimed in full, so the ONLY thing standing between that and 400
  // duplicate emails is that this predicate cannot match a sent row.
  it("can never re-claim a message that is already sent", () => {
    const { sql: statement } = claim()
    const where = statement.slice(statement.indexOf("where"))
    expect(where).not.toContain("'sent'")
    // Nor anything else terminal: a permanently failed message must stay failed,
    // and a cancelled one must stay cancelled.
    expect(where).not.toContain("'failed'")
    expect(where).not.toContain("'canceled'")
  })

  // The claim interval is a parameter, never interpolated text: it reaches the
  // statement as a bind so a value from configuration cannot become SQL.
  it("binds the stale interval rather than inlining it", () => {
    const { sql: statement, params } = claim()
    expect(statement).toContain("::interval")
    expect(params).toContain("5 minutes")
    expect(statement).not.toContain("5 minutes")
  })

  it("counts the attempt as part of taking it", () => {
    expect(claim().sql).toContain("attempts   = m.attempts + 1")
  })

  it("records which worker holds it, so a stuck row can be traced", () => {
    const { sql: statement, params } = claim()
    expect(statement).toContain("claimed_by =")
    expect(params).toContain("worker-1")
  })

  it("claims a whole batch in one statement", () => {
    const { sql: statement, params } = claim([A, B])
    expect(statement).toContain("values (")
    expect(params).toContain(A.id)
    expect(params).toContain(B.id)
    // One round trip for the batch, not one per message.
    expect(statement.match(/update core\.messages/g)).toHaveLength(1)
  })

  it("binds every id rather than interpolating it", () => {
    const { sql: statement, params } = claim([A, B])
    expect(statement).not.toContain(A.id)
    expect(params).toEqual(expect.arrayContaining([A.id, B.id]))
  })

  // PgBouncer runs in transaction pooling mode and drops `search_path`, so an
  // unqualified table name resolves to nothing on a pooled connection.
  it("schema-qualifies the table", () => {
    expect(claim().sql).toContain("core.messages")
  })
})

describe("recording the outcome", () => {
  // ⚠ THE ONE THAT PREVENTS A CROSSED WIRE. A worker whose lease expired
  // mid-send may still be alive and still reach this statement, by which time
  // another worker owns the row. Writing unconditionally would overwrite the
  // second worker's ses_message_id with the first's, and the SES event stream
  // would then join to an id we no longer hold.
  it("only writes a result for the row this worker still holds", () => {
    for (const statement of [
      render(markSentStatement(A, "worker-1", "ses-abc")).sql,
      render(markFailedStatement(A, "worker-1", "boom", false)).sql,
    ]) {
      expect(statement).toContain("status = 'sending'")
      expect(statement).toContain("claimed_by =")
      expect(statement).toContain("returning id")
    }
  })

  it("clears the last error on success, so a stale one cannot linger", () => {
    expect(render(markSentStatement(A, "w", "ses-abc")).sql).toContain(
      "last_error     = null",
    )
  })

  it("binds the SES id", () => {
    const { params } = render(markSentStatement(A, "w", "ses-abc"))
    expect(params).toContain("ses-abc")
  })

  // ⚠ Back to `queued`, not left in `sending`. Left in `sending` the row waits
  // for the stale-claim sweep, which turns a two-second retry into minutes.
  it("returns a retryable failure to the queue and releases the claim", () => {
    const { sql: statement } = render(markFailedStatement(A, "w", "temporary", false))
    expect(statement).toContain("status     = 'queued'")
    expect(statement).toContain("claimed_by = null")
    expect(statement).toContain("claimed_at = null")
  })

  it("stops a permanent failure at `failed`", () => {
    expect(render(markFailedStatement(A, "w", "bad address", true)).sql).toContain(
      "status     = 'failed'",
    )
  })

  // An SES error body can be enormous, and last_error is read on a page that
  // lists many messages.
  it("truncates the error text", () => {
    const { params } = render(markFailedStatement(A, "w", "x".repeat(5000), true))
    const stored = params.find((p) => typeof p === "string" && p.startsWith("xxx"))
    expect((stored as string).length).toBe(2000)
  })

  it("binds the error text rather than inlining it", () => {
    const { sql: statement, params } = render(
      markFailedStatement(A, "w", "'; drop table core.messages; --", true),
    )
    expect(statement).not.toContain("drop table")
    expect(params).toContain("'; drop table core.messages; --")
  })
})
