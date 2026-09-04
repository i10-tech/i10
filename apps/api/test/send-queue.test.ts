import { describe, expect, it, vi } from "vitest"
import type { MessageRef } from "../src/db/claim.js"
import {
  batchJobId,
  enqueueBatch,
  namespaceFor,
  type SendJob,
} from "../src/queue/send-queue.js"
import {
  resilient,
  shouldSend,
  unmetered,
  type Metering,
} from "../src/send/metering.js"

const ref = (id: string, iso: string): MessageRef => ({ id, createdAt: new Date(iso) })

const A = ref("0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6071", "2026-09-02T10:00:02.000Z")
const B = ref("0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6072", "2026-09-02T10:00:00.500Z")
const C = ref("0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6073", "2026-09-02T10:00:09.000Z")

const job = (messages: MessageRef[]): SendJob => ({ tenantId: "ten-1", messages })

/** Just enough of groupmq's Queue for the enqueue path. */
function fakeQueue() {
  const add = vi.fn(async (opts: Record<string, unknown>) => ({ id: "job-1", ...opts }))
  return { add } as unknown as Parameters<typeof enqueueBatch>[0] & {
    add: typeof add
  }
}

describe("scheduling", () => {
  // ⚠ THE DELAY IS THE OPTIMISATION, THE CLAIM IS THE GUARANTEE — but without
  // this the worker would take a scheduled batch the moment it is enqueued.
  it("hands groupmq the due time", async () => {
    const queue = fakeQueue()
    const runAt = new Date("2026-09-03T09:00:00.000Z")

    await enqueueBatch(queue, job([A, B]), { runAt })

    expect(queue.add).toHaveBeenCalledWith(
      expect.objectContaining({ runAt, orderMs: runAt.getTime() }),
    )
  })

  // ⚠ ORDERED BY WHEN IT IS DUE, NOT BY WHEN IT WAS ACCEPTED. Keeping the
  // acceptance time would make a message scheduled for tomorrow jump ahead of
  // everything accepted after it the moment it was promoted.
  it("does not let a scheduled batch keep its acceptance order", async () => {
    const queue = fakeQueue()
    const runAt = new Date("2026-09-03T09:00:00.000Z")

    await enqueueBatch(queue, job([B]), { runAt })

    const opts = queue.add.mock.calls[0]![0] as { orderMs: number }
    expect(opts.orderMs).not.toBe(B.createdAt.getTime())
  })

  it("stays immediate and acceptance-ordered without one", async () => {
    const queue = fakeQueue()
    await enqueueBatch(queue, job([A, B]))

    const opts = queue.add.mock.calls[0]![0] as { orderMs: number; runAt?: Date }
    expect(opts.runAt).toBeUndefined()
    expect(opts.orderMs).toBe(B.createdAt.getTime())
  })
})

describe("the queue namespace", () => {
  // ⚠ i10's Redis is its own instance, never PSL's under a prefix. The prefix
  // stays explicit because the failure if that changed is two products draining
  // each other's queues, and it would look like messages vanishing.
  it("is per class and prefixed", () => {
    expect(namespaceFor("transactional")).toBe("i10:send:transactional")
    expect(namespaceFor("bulk")).toBe("i10:send:bulk")
  })

  // Separating the classes is what stops one tenant's bulk batch queueing in
  // front of another tenant's password reset.
  it("keeps the two classes apart", () => {
    expect(namespaceFor("transactional")).not.toBe(namespaceFor("bulk"))
  })
})

describe("the batch job id", () => {
  // The second of three idempotency layers: Idempotency-Key at ingress, this at
  // enqueue, the compare-and-swap at egress.
  it("is stable for the same batch", () => {
    expect(batchJobId(job([A, B]))).toBe(batchJobId(job([A, B])))
  })

  it("differs between batches", () => {
    expect(batchJobId(job([A]))).not.toBe(batchJobId(job([C])))
  })

  it("refuses an empty batch rather than inventing a name", () => {
    expect(() => batchJobId(job([]))).toThrow(TypeError)
  })
})

describe("enqueueing a batch", () => {
  it("groups by tenant, which is what makes the fairness work", async () => {
    const q = fakeQueue()
    await enqueueBatch(q, job([A]))
    expect(q.add).toHaveBeenCalledWith(expect.objectContaining({ groupId: "ten-1" }))
  })

  // ⚠ One job per batch, not one per message. Per-group serialisation would
  // otherwise cap a tenant at one message in flight.
  it("sends the whole batch as a single job", async () => {
    const q = fakeQueue()
    await enqueueBatch(q, job([A, B, C]))
    expect(q.add).toHaveBeenCalledTimes(1)
    const [{ data }] = q.add.mock.calls[0] as [{ data: SendJob }]
    expect(data.messages).toHaveLength(3)
  })

  // Ordering within a group is by orderMs. A batch accepted first should stay
  // ahead of one accepted later, so the earliest message in the batch decides.
  it("orders by the earliest acceptance time in the batch", async () => {
    const q = fakeQueue()
    await enqueueBatch(q, job([A, B, C]))
    expect(q.add).toHaveBeenCalledWith(
      expect.objectContaining({ orderMs: B.createdAt.getTime() }),
    )
  })

  it("carries references rather than message bodies", async () => {
    const q = fakeQueue()
    await enqueueBatch(q, job([A]))
    const [{ data }] = q.add.mock.calls[0] as [{ data: SendJob }]
    expect(Object.keys(data.messages[0]!).sort()).toEqual(["createdAt", "id"])
  })

  it("refuses an empty batch", async () => {
    const q = fakeQueue()
    await expect(enqueueBatch(q, job([]))).rejects.toThrow(TypeError)
    expect(q.add).not.toHaveBeenCalled()
  })
})

describe("quota", () => {
  it("sends when allowed and refuses when exceeded", () => {
    expect(shouldSend({ status: "allowed" })).toBe(true)
    expect(shouldSend({ status: "exceeded", message: "out" })).toBe(false)
  })

  // ⚠ THE DECISION, MADE EXPLICITLY. A metering outage must not stop a paying
  // customer's password resets. The cost is a little unbilled usage during an
  // incident, which is visible in the logs and reconcilable.
  it("fails open when metering is unavailable, and can be told not to", () => {
    const out = { status: "unavailable", message: "down" } as const
    expect(shouldSend(out)).toBe(true)
    expect(shouldSend(out, false)).toBe(false)
  })

  it("treats a thrown check as unavailable, never as exceeded", async () => {
    const broken: Metering = {
      checkQuota: async () => {
        throw new Error("autumn down")
      },
      recordSent: async () => {},
    }
    const outcome = await resilient(broken).checkQuota("ten-1", 1)
    expect(outcome.status).toBe("unavailable")
  })

  // ⚠ The mail has already gone. Throwing here would return the row to the
  // queue and send it twice to fix a billing record.
  it("never lets a failed usage record throw into the send path", async () => {
    const log = { warn: vi.fn(), error: vi.fn() }
    const broken: Metering = {
      checkQuota: async () => ({ status: "allowed" }),
      recordSent: async () => {
        throw new Error("autumn down")
      },
    }
    await expect(
      resilient(broken, log).recordSent("ten-1", [{ id: "msg-a", sentAt: new Date() }]),
    ).resolves.toBeUndefined()
    // ⚠ And it is NOT retried — Autumn's own docs say a retried batchTrack
    // double-deducts, and that "gaps are preferable to duplicates". The
    // reconciler closes the gap.
    expect(log.error).toHaveBeenCalled()
  })

  // ⚠ Ids, not a count. Autumn's single `track` 409s a replayed
  // Idempotency-Key, so an id can be resubmitted safely and a count cannot —
  // which is the only reason the reconciler can top up without double-billing.
  //
  // ⚠ And each id carries the database's own `sent_at`, because the reconciler
  // buckets our side by that column and the meter's side by the timestamp we
  // send it. A worker clock a millisecond off would split a message across two
  // days and top it up on every run.
  it("passes message ids and their stored sent_at through", async () => {
    const inner: Metering = { checkQuota: vi.fn(), recordSent: vi.fn() }
    const at = new Date("2026-09-02T23:59:59.900Z")
    await resilient(inner).recordSent("ten-1", [
      { id: "msg-a", sentAt: at },
      { id: "msg-b", sentAt: at },
    ])
    expect(inner.recordSent).toHaveBeenCalledExactlyOnceWith("ten-1", [
      { id: "msg-a", sentAt: at },
      { id: "msg-b", sentAt: at },
    ])
  })

  it("the unmetered stub allows and counts nothing", async () => {
    expect(await unmetered.checkQuota("ten-1", 10)).toEqual({ status: "allowed" })
    await expect(
      unmetered.recordSent("ten-1", [{ id: "msg-a", sentAt: new Date() }]),
    ).resolves.toBeUndefined()
  })
})

describe("naming a job", () => {
  // ⚠ THE DEFAULT NAME IS STABLE, WHICH IS THE SECOND IDEMPOTENCY LAYER — and
  // is also why the sweep cannot use it. groupmq treats a name it has seen
  // before as a duplicate and enqueues nothing.
  it("uses the batch's own name by default", async () => {
    const q = fakeQueue()

    await enqueueBatch(q, job([A, B]))

    expect(q.add).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: batchJobId(job([A, B])) }),
    )
  })

  it("takes an override, which is how a swept batch is re-enqueued", async () => {
    const q = fakeQueue()

    await enqueueBatch(q, job([A, B]), { jobId: "sweep:1757000000000:x" })

    expect(q.add).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "sweep:1757000000000:x" }),
    )
  })
})
