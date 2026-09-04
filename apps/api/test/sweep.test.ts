import { describe, expect, it } from "vitest"
import type { SendJob } from "../src/queue/send-queue.js"
import {
  planSweep,
  sweepJobId,
  SWEEP_BATCH_SIZE,
  type StrandedRow,
} from "../src/send/sweep.js"

const AT = new Date("2026-09-02T10:00:00Z")

const row = (
  id: string,
  tenantId: string,
  queue: "transactional" | "bulk" = "transactional",
): StrandedRow => ({ id, createdAt: AT, tenantId, queue })

describe("planning a pass", () => {
  it("makes one batch per tenant", () => {
    const batches = planSweep([row("a", "ten-1"), row("b", "ten-2"), row("c", "ten-1")])

    expect(batches).toHaveLength(2)
    expect(batches.map((b) => b.job.messages.map((m) => m.id))).toEqual([
      ["a", "c"],
      ["b"],
    ])
  })

  // ⚠ THE SPLIT IS THE WHOLE REASON THERE ARE TWO QUEUES. A tenant with rows in
  // both classes must not have its bulk backlog enqueued onto the transactional
  // queue because that is where its first stranded row happened to be.
  it("never mixes the two classes", () => {
    const batches = planSweep([
      row("a", "ten-1", "transactional"),
      row("b", "ten-1", "bulk"),
      row("c", "ten-1", "transactional"),
    ])

    expect(batches).toHaveLength(2)
    expect(batches.find((b) => b.class === "transactional")?.job.messages).toHaveLength(
      2,
    )
    expect(batches.find((b) => b.class === "bulk")?.job.messages).toHaveLength(1)
  })

  // A tenant with a large backlog becomes several jobs, not one job that holds
  // its group for the whole of it.
  it("chunks a tenant's backlog", () => {
    const rows = Array.from({ length: 250 }, (_, i) => row(`m-${i}`, "ten-1"))

    const batches = planSweep(rows, 100)

    expect(batches.map((b) => b.job.messages.length)).toEqual([100, 100, 50])
    expect(batches.every((b) => b.job.tenantId === "ten-1")).toBe(true)
  })

  it("defaults the chunk size", () => {
    const rows = Array.from({ length: SWEEP_BATCH_SIZE + 1 }, (_, i) =>
      row(`m-${i}`, "ten-1"),
    )

    expect(planSweep(rows)).toHaveLength(2)
  })

  it("plans nothing when nothing is stranded", () => {
    expect(planSweep([])).toEqual([])
  })
})

describe("naming a swept batch", () => {
  const job: SendJob = { tenantId: "ten-1", messages: [{ id: "a", createdAt: AT }] }

  // ⚠ THIS IS THE PROPERTY THE WHOLE SWEEP DEPENDS ON. groupmq keeps a
  // `:unique:<jobId>` key and our queues keep completed jobs, so re-adding the
  // name of a batch that already ran enqueues NOTHING. A sweep reusing
  // `batchJobId` would be a silent no-op for exactly the rows it exists to
  // rescue.
  it("is not the name the accept path used", () => {
    expect(sweepJobId(new Date(), job)).not.toBe("batch:a")
  })

  it("is stable within one pass", () => {
    const run = new Date("2026-09-04T09:00:00Z")

    expect(sweepJobId(run, job)).toBe(sweepJobId(run, job))
  })

  it("differs between passes, so a later pass is a real retry", () => {
    const first = sweepJobId(new Date("2026-09-04T09:00:00Z"), job)
    const second = sweepJobId(new Date("2026-09-04T09:05:00Z"), job)

    expect(first).not.toBe(second)
  })

  it("refuses a batch with no messages", () => {
    expect(() => sweepJobId(new Date(), { tenantId: "ten-1", messages: [] })).toThrow(
      TypeError,
    )
  })
})
