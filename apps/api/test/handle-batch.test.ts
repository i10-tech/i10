import { describe, expect, it, vi } from "vitest"
import type { SendJob } from "../src/queue/send-queue.js"
import type { Metering } from "../src/send/metering.js"
import {
  fakeTransport,
  messageIdHeader,
  type OutboundMessage,
  type SendOutcome,
} from "../src/send/transport.js"
import { handleBatch, type BatchDeps } from "../src/worker/handle-batch.js"

const outbound = (n: number): OutboundMessage => ({
  id: `msg-${n}`,
  tenantId: "ten-1",
  from: "hello@i10.tech",
  to: [`user${n}@example.com`],
  cc: [],
  bcc: [],
  replyTo: [],
  subject: `Subject ${n}`,
  text: "body",
})

const job = (count: number): SendJob => ({
  tenantId: "ten-1",
  messages: Array.from({ length: count }, (_, i) => ({
    id: `msg-${i}`,
    createdAt: new Date("2026-09-02T10:00:00Z"),
  })),
})

/** The `sent_at` the database would have returned. */
const SENT_AT = new Date("2026-09-02T10:00:01Z")

function deps(over: Partial<BatchDeps> = {}) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const metering: Metering = {
    checkQuota: vi.fn(),
    recordSent: vi.fn(async () => {}),
  }
  const base: BatchDeps = {
    claim: async (j) => j.messages.map((_, i) => outbound(i)),
    markSent: vi.fn(async () => SENT_AT),
    markFailed: vi.fn(async () => {}),
    transport: fakeTransport(),
    metering,
    log,
    concurrency: 4,
    ...over,
  }
  return { deps: base, log, metering }
}

describe("the happy path", () => {
  it("claims, sends, records and meters", async () => {
    const transport = fakeTransport(() => ({
      status: "sent",
      providerMessageId: "ses-1",
    }))
    const { deps: d, metering } = deps({ transport })

    const result = await handleBatch(job(3), d)

    expect(result).toEqual({ claimed: 3, sent: 3, rejected: 0, deferred: 0 })
    expect(transport.sent).toHaveLength(3)
    expect(d.markSent).toHaveBeenCalledTimes(3)
    expect(metering.recordSent).toHaveBeenCalledExactlyOnceWith("ten-1", [
      { id: "msg-0", sentAt: SENT_AT },
      { id: "msg-1", sentAt: SENT_AT },
      { id: "msg-2", sentAt: SENT_AT },
    ])
  })

  // ⚠ THE DATABASE'S `sent_at`, NOT THE WORKER'S CLOCK. The reconciler buckets
  // our side by that column and the meter's side by what we send it; a
  // millisecond apart across midnight puts one message in two different days,
  // and the day that came up short is topped up on every run afterwards.
  it("bills at the timestamp the write returned", async () => {
    const stored = new Date("2026-09-02T23:59:59.900Z")
    const { deps: d, metering } = deps({ markSent: vi.fn(async () => stored) })

    await handleBatch(job(1), d)

    expect(metering.recordSent).toHaveBeenCalledExactlyOnceWith("ten-1", [
      { id: "msg-0", sentAt: stored },
    ])
  })

  // ⚠ NO WRITE, NO BILL. A null means the compare-and-swap did not take — the
  // claim had already moved to another worker, which will record and bill the
  // row itself. Billing it here too would charge the customer twice for one
  // message.
  it("does not bill a message whose write did not land", async () => {
    const { deps: d, metering } = deps({ markSent: vi.fn(async () => null) })

    const result = await handleBatch(job(2), d)

    expect(result.sent).toBe(2)
    expect(metering.recordSent).not.toHaveBeenCalled()
  })

  // ⚠ One metering call per batch, not one per message. Autumn rate-limits to
  // ten requests a second per organisation.
  it("meters the batch once", async () => {
    const { deps: d, metering } = deps()
    await handleBatch(job(50), d)
    expect(metering.recordSent).toHaveBeenCalledTimes(1)
  })
})

describe("losing the claim", () => {
  // ⚠ NOT AN ERROR. Another worker owns these — the mechanism working. Throwing
  // would make groupmq retry and race that worker again, turning a clean
  // hand-off into a duplicate.
  it("does nothing and does not throw", async () => {
    const transport = fakeTransport()
    const { deps: d, metering } = deps({ claim: async () => [], transport })

    const result = await handleBatch(job(3), d)

    expect(result).toEqual({ claimed: 0, sent: 0, rejected: 0, deferred: 0 })
    expect(transport.sent).toHaveLength(0)
    expect(metering.recordSent).not.toHaveBeenCalled()
  })

  it("sends only what it won, not the whole job", async () => {
    const transport = fakeTransport()
    const { deps: d } = deps({ claim: async () => [outbound(0)], transport })

    const result = await handleBatch(job(5), d)

    expect(result.claimed).toBe(1)
    expect(transport.sent).toHaveLength(1)
  })
})

describe("failures", () => {
  it("stops a rejection permanently and never bills it", async () => {
    const transport = fakeTransport(() => ({
      status: "rejected",
      reason: "malformed address",
    }))
    const { deps: d, metering } = deps({ transport })

    const result = await handleBatch(job(2), d)

    expect(result).toMatchObject({ sent: 0, rejected: 2 })
    expect(d.markFailed).toHaveBeenCalledWith(
      expect.anything(),
      "malformed address",
      true,
    )
    expect(metering.recordSent).not.toHaveBeenCalled()
  })

  it("returns a deferral to the queue", async () => {
    const transport = fakeTransport(() => ({ status: "deferred", reason: "throttled" }))
    const { deps: d } = deps({ transport })

    const result = await handleBatch(job(2), d)

    expect(result).toMatchObject({ deferred: 2 })
    expect(d.markFailed).toHaveBeenCalledWith(expect.anything(), "throttled", false)
  })

  // ⚠ THE ONE THAT DROPS REAL MAIL IF IT REGRESSES. An exception is the
  // transport failing to give an answer, not evidence the message is
  // undeliverable. Permanent on a network blip loses the message.
  it("treats a thrown transport error as deferred, never as rejected", async () => {
    const transport = {
      send: async () => {
        throw new Error("ECONNRESET")
      },
    }
    const { deps: d } = deps({ transport })

    const result = await handleBatch(job(1), d)

    expect(result).toMatchObject({ deferred: 1, rejected: 0 })
    expect(d.markFailed).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("ECONNRESET"),
      false,
    )
  })

  it("bills only what was actually sent in a mixed batch", async () => {
    const transport = fakeTransport((m): SendOutcome => {
      if (m.id === "msg-0") return { status: "sent", providerMessageId: "ses-0" }
      if (m.id === "msg-1") return { status: "rejected", reason: "bad" }
      return { status: "deferred", reason: "slow" }
    })
    const { deps: d, metering } = deps({ transport })

    const result = await handleBatch(job(3), d)

    expect(result).toEqual({ claimed: 3, sent: 1, rejected: 1, deferred: 1 })
    expect(metering.recordSent).toHaveBeenCalledExactlyOnceWith("ten-1", [
      { id: "msg-0", sentAt: SENT_AT },
    ])
  })

  // ⚠ The mail has gone. A billing failure must not return sent rows to the
  // queue and send them twice.
  it("does not fail the batch when metering throws", async () => {
    const metering: Metering = {
      checkQuota: vi.fn(),
      recordSent: async () => {
        throw new Error("autumn down")
      },
    }
    const { deps: d } = deps({ metering })

    await expect(handleBatch(job(2), d)).resolves.toMatchObject({ sent: 2 })
  })

  // ⚠ An unhandled rejection escaping the pool would abandon the rest of the
  // batch mid-flight, leaving those rows claimed and stranded until the sweep.
  it("finishes the batch even when recording one message throws", async () => {
    const markSent = vi.fn(async (m: OutboundMessage) => {
      if (m.id === "msg-0") throw new Error("deadlock")
      return SENT_AT
    })
    const { deps: d } = deps({ markSent })

    const result = await handleBatch(job(4), d)

    expect(markSent).toHaveBeenCalledTimes(4)
    expect(result.claimed).toBe(4)
  })
})

describe("concurrency", () => {
  // ⚠ Not Promise.all over the batch. Five hundred simultaneous calls blow
  // through the send rate and convert a throughput problem into a retry storm.
  it("never exceeds the configured width", async () => {
    let inFlight = 0
    let peak = 0
    const transport = {
      send: async (): Promise<SendOutcome> => {
        peak = Math.max(peak, ++inFlight)
        await new Promise((r) => setTimeout(r, 2))
        inFlight--
        return { status: "sent", providerMessageId: "ses" }
      },
    }
    const { deps: d } = deps({ transport, concurrency: 3 })

    await handleBatch(job(20), d)

    expect(peak).toBeLessThanOrEqual(3)
    expect(peak).toBeGreaterThan(1)
  })

  it("still sends everything with a width of one", async () => {
    const transport = fakeTransport()
    const { deps: d } = deps({ transport, concurrency: 1 })
    await handleBatch(job(6), d)
    expect(transport.sent).toHaveLength(6)
  })

  it("tolerates a width larger than the batch", async () => {
    const transport = fakeTransport()
    const { deps: d } = deps({ transport, concurrency: 100 })
    await handleBatch(job(2), d)
    expect(transport.sent).toHaveLength(2)
  })
})

describe("the Message-ID header", () => {
  // ⚠ THE ONLY THING THAT MAKES A DUPLICATE HARMLESS. A retry must produce the
  // same value or the accepted-duplicate rate becomes a delivered-duplicate
  // rate.
  it("is derived from the message id, so a retry repeats it", () => {
    expect(messageIdHeader("msg-1", "hello@i10.tech")).toBe("<msg-1@i10.tech>")
    expect(messageIdHeader("msg-1", "hello@i10.tech")).toBe(
      messageIdHeader("msg-1", "hello@i10.tech"),
    )
  })

  it("aligns the domain with the sender", () => {
    expect(messageIdHeader("m", "a@Sub.Example.COM")).toBe("<m@sub.example.com>")
  })

  it("falls back rather than emitting a malformed header", () => {
    expect(messageIdHeader("m", "not-an-address")).toBe("<m@i10.tech>")
  })
})
