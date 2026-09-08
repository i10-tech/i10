import { PgDialect } from "drizzle-orm/pg-core"
import type { SQL } from "drizzle-orm"
import { describe, expect, it, vi } from "vitest"
import {
  INGEST_LIMIT,
  flushUsage,
  markShippedStatement,
  unshippedStatement,
} from "../src/metering/ingest.js"
import type { Database } from "../src/db/client.js"
import type { PolarClient } from "../src/billing/polar.js"

const dialect = new PgDialect()
const render = (q: SQL) => dialect.sqlToQuery(q)
const A = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6071"
const B = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6072"

function fakeDb(rows: unknown[]) {
  const seen: string[] = []
  const execute = vi.fn(async (query: SQL) => {
    seen.push(dialect.sqlToQuery(query).sql)
    return dialect.sqlToQuery(query).sql.includes("unshipped_meter_events") ? rows : []
  })
  const db = {
    execute,
    transaction: async (fn: (tx: { execute: typeof execute }) => Promise<unknown>) =>
      fn({ execute }),
  } as unknown as Database
  return { db, seen }
}

const row = (tenant: string, id: string) => ({
  tenant_id: tenant,
  event_id: id,
  occurred_at: "2026-09-05T10:00:00.000Z",
  value: 1,
})

const polar = (over: Partial<PolarClient> = {}): PolarClient =>
  ({
    ingestEvents: async () => ({ inserted: 0, duplicates: 0 }),
    ...over,
  }) as PolarClient

const flush = (rows: unknown[], client = polar()) => {
  const { db, seen } = fakeDb(rows)
  return {
    seen,
    run: () =>
      flushUsage({ db, polar: client, featureId: "emails", eventName: "emails" }),
  }
}

describe("what gets read", () => {
  // ⚠ Cross-tenant, so it goes through the privileged function rather than the
  // table — under the policy the job would see one tenant and conclude everyone
  // else had sent nothing.
  it("reads through the definer function, never off the table", () => {
    const { sql: statement } = render(unshippedStatement("emails", 500))
    expect(statement).toContain("core.unshipped_meter_events(")
    expect(statement).not.toContain("from core.meter_events")
  })
})

describe("what gets marked", () => {
  /**
   * ⚠ THE IDS THAT WERE SENT, NOT A TIME RANGE. "Mark everything older than X"
   * sweeps up rows that arrived during the request and were never in it — units
   * that are then never billed, with nothing left un-shipped to notice.
   */
  it("marks exactly the ids it shipped", () => {
    const { sql: statement } = render(markShippedStatement(A, "emails", ["m1", "m2"]))
    expect(statement).toContain("event_id   = any(")
    expect(statement).toContain("tenant_id  = $1::uuid")
    expect(statement).not.toMatch(/occurred_at\s*<|recorded_at\s*</)
  })

  /**
   * ⚠ AN ARRAY LITERAL, NOT A ROW CONSTRUCTOR, AND THE TEST ABOVE COULD NOT
   * TELL THEM APART. Interpolating the id array directly renders `any(($3, $4))`
   * — which satisfies `toContain("any(")` and which Postgres rejects at run time
   * with `cannot cast type record to text[]`.
   *
   * ⚠ AND THE CONSEQUENCE WAS RE-BILLING, NOT AN OUTAGE. The flush had already
   * handed the units to Polar by the time this ran, so the failure left them
   * un-marked and every subsequent run shipped them again. Nothing but Polar's
   * `external_id` dedupe stood between that and usage counted twice per run,
   * forever.
   */
  it("builds an array literal Postgres can actually cast", () => {
    const { sql: statement, params } = render(
      markShippedStatement(A, "emails", ["m1", "m2"]),
    )
    expect(statement).toContain("any(array[")
    expect(statement).not.toContain("any((")
    // One scalar per id, so nothing depends on the driver serialising an array.
    expect(params).toEqual([A, "emails", "m1", "m2"])
  })

  // Re-marking a shipped row would move its watermark for no reason; the guard
  // also makes a concurrent second pass harmless.
  it("only touches rows that are still unshipped", () => {
    expect(render(markShippedStatement(A, "emails", ["m1"])).sql).toContain(
      "ingested_at is null",
    )
  })
})

describe("flushing", () => {
  it("does nothing when there is nothing to send", async () => {
    const ingestEvents = vi.fn()
    const { run } = flush([], polar({ ingestEvents }))

    expect(await run()).toEqual({ shipped: 0, duplicates: 0, batchWasFull: false })
    expect(ingestEvents).not.toHaveBeenCalled()
  })

  it("sends every unit, keyed on the message id and the tenant", async () => {
    const ingestEvents = vi.fn(async () => ({ inserted: 2, duplicates: 0 }))
    const { run } = flush([row(A, "m1"), row(B, "m2")], polar({ ingestEvents }))

    await run()

    expect(ingestEvents).toHaveBeenCalledWith([
      {
        name: "emails",
        externalId: "m1",
        tenantId: A,
        at: new Date("2026-09-05T10:00:00.000Z"),
        units: 1,
      },
      expect.objectContaining({ externalId: "m2", tenantId: B }),
    ])
  })

  /**
   * ⚠ POLAR FIRST, THE WATERMARK SECOND. Marking first and failing to post
   * loses the units silently; posting first and failing to mark costs a
   * re-send, which `external_id` makes free. Only one of the two orders can
   * lose revenue.
   */
  it("marks nothing when polar refuses", async () => {
    const { seen, run } = flush(
      [row(A, "m1")],
      polar({
        ingestEvents: async () => {
          throw new Error("503")
        },
      }),
    )

    await expect(run()).rejects.toThrow("503")
    expect(seen.some((s) => s.includes("update core.meter_events"))).toBe(false)
  })

  // ⚠ One transaction per tenant, because row level security is per tenant. A
  // bulk cross-tenant UPDATE is how one bad id becomes everyone's problem.
  it("marks each tenant inside its own tenant context", async () => {
    const { seen, run } = flush(
      [row(A, "m1"), row(B, "m2")],
      polar({ ingestEvents: async () => ({ inserted: 2, duplicates: 0 }) }),
    )

    await run()

    expect(seen.filter((s) => s.includes("set_config('app.tenant_id'"))).toHaveLength(2)
    expect(seen.filter((s) => s.includes("update core.meter_events"))).toHaveLength(2)
  })

  // Duplicates are the ordinary answer on a retry, not a failure.
  it("reports what polar had already seen", async () => {
    const { run } = flush(
      [row(A, "m1")],
      polar({ ingestEvents: async () => ({ inserted: 0, duplicates: 1 }) }),
    )
    expect(await run()).toMatchObject({ shipped: 0, duplicates: 1 })
  })

  // ⚠ The caller drains a backlog by running again; a full batch is the signal.
  it("says when the batch was full", async () => {
    const rows = Array.from({ length: INGEST_LIMIT }, (_, i) => row(A, `m${i}`))
    const { run } = flush(
      rows,
      polar({ ingestEvents: async () => ({ inserted: INGEST_LIMIT, duplicates: 0 }) }),
    )
    expect((await run()).batchWasFull).toBe(true)
  })

  /**
   * ⚠ THE UNITS ARE IN POLAR ALREADY, so a failure to record that is worth a
   * log line and not worth failing the pass — the next run re-sends and Polar
   * skips them.
   */
  it("survives a failure to mark", async () => {
    const execute = vi.fn(async (query: SQL) => {
      const statement = dialect.sqlToQuery(query).sql
      if (statement.includes("update core.meter_events")) throw new Error("deadlock")
      return statement.includes("unshipped_meter_events") ? [row(A, "m1")] : []
    })
    const db = {
      execute,
      transaction: async (fn: (tx: { execute: typeof execute }) => Promise<unknown>) =>
        fn({ execute }),
    } as unknown as Database
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    const report = await flushUsage({
      db,
      polar: polar({ ingestEvents: async () => ({ inserted: 1, duplicates: 0 }) }),
      featureId: "emails",
      eventName: "emails",
      log,
    })

    expect(report.shipped).toBe(1)
    expect(log.error).toHaveBeenCalled()
  })
})
