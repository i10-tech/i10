import { describe, expect, it, mock } from "bun:test"
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
  const log = { info: mock(), warn: mock(), error: mock() }
  const metering: Metering = {
    checkQuota: mock(),
    recordSent: mock(async () => {}),
  }
  const base: BatchDeps = {
    claim: async (j) => j.messages.map((_, i) => outbound(i)),
    markSent: mock(async () => SENT_AT),
    markFailed: mock(async () => {}),
    route: () => "ses" as const,
    transportFor: () => fakeTransport(),
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
    const { deps: d, metering } = deps({ transportFor: () => transport })

    const result = await handleBatch(job(3), d)

    expect(result).toEqual({
      claimed: 3,
      sent: 3,
      rejected: 0,
      deferred: 0,
      stranded: 0,
    })
    expect(transport.sent).toHaveLength(3)
    expect(d.markSent).toHaveBeenCalledTimes(3)
    expect(metering.recordSent).toHaveBeenCalledTimes(1)
    expect(metering.recordSent).toHaveBeenCalledWith("ten-1", [
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
    const { deps: d, metering } = deps({ markSent: mock(async () => stored) })

    await handleBatch(job(1), d)

    expect(metering.recordSent).toHaveBeenCalledTimes(1)
    expect(metering.recordSent).toHaveBeenCalledWith("ten-1", [
      { id: "msg-0", sentAt: stored },
    ])
  })

  // ⚠ NO WRITE, NO BILL. A null means the compare-and-swap did not take — the
  // claim had already moved to another worker, which will record and bill the
  // row itself. Billing it here too would charge the customer twice for one
  // message.
  it("does not bill a message whose write did not land", async () => {
    const { deps: d, metering } = deps({ markSent: mock(async () => null) })

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
    const { deps: d, metering } = deps({
      claim: async () => [],
      transportFor: () => transport,
    })

    const result = await handleBatch(job(3), d)

    expect(result).toEqual({
      claimed: 0,
      sent: 0,
      rejected: 0,
      deferred: 0,
      stranded: 0,
    })
    expect(transport.sent).toHaveLength(0)
    expect(metering.recordSent).not.toHaveBeenCalled()
  })

  it("sends only what it won, not the whole job", async () => {
    const transport = fakeTransport()
    const { deps: d } = deps({
      claim: async () => [outbound(0)],
      transportFor: () => transport,
    })

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
    const { deps: d, metering } = deps({ transportFor: () => transport })

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
    const { deps: d } = deps({ transportFor: () => transport })

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
    const { deps: d } = deps({ transportFor: () => transport })

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
    const { deps: d, metering } = deps({ transportFor: () => transport })

    const result = await handleBatch(job(3), d)

    expect(result).toEqual({
      claimed: 3,
      sent: 1,
      rejected: 1,
      deferred: 1,
      stranded: 0,
    })
    expect(metering.recordSent).toHaveBeenCalledTimes(1)
    expect(metering.recordSent).toHaveBeenCalledWith("ten-1", [
      { id: "msg-0", sentAt: SENT_AT },
    ])
  })

  // ⚠ The mail has gone. A billing failure must not return sent rows to the
  // queue and send them twice.
  it("does not fail the batch when metering throws", async () => {
    const metering: Metering = {
      checkQuota: mock(),
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
    const markSent = mock(async (m: OutboundMessage) => {
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
    const { deps: d } = deps({ transportFor: () => transport, concurrency: 3 })

    await handleBatch(job(20), d)

    expect(peak).toBeLessThanOrEqual(3)
    expect(peak).toBeGreaterThan(1)
  })

  it("still sends everything with a width of one", async () => {
    const transport = fakeTransport()
    const { deps: d } = deps({ transportFor: () => transport, concurrency: 1 })
    await handleBatch(job(6), d)
    expect(transport.sent).toHaveLength(6)
  })

  it("tolerates a width larger than the batch", async () => {
    const transport = fakeTransport()
    const { deps: d } = deps({ transportFor: () => transport, concurrency: 100 })
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

  /**
   * ⚠ THE FORM REAL CALLERS ACTUALLY SEND, AND THE ONE THIS FILE NEVER TRIED.
   * Every case above passes a bare address, so taking everything after the last
   * `@` looked correct — and on `i10 test <noreply@pslhq.app>` it yields
   * `pslhq.app>`, producing `<m@pslhq.app>>` with a doubled bracket.
   *
   * ⚠ AND SES SWALLOWS THAT WITHOUT COMPLAINING. A malformed Message-ID is not
   * refused, it is replaced with `…@eu-central-1.amazonses.com` — so the header
   * was simply missing from delivered mail, the retry mitigation was not in
   * force, and the only evidence was in a received message's source.
   */
  it("unwraps a display name instead of trusting the last @", () => {
    expect(messageIdHeader("m", "i10 test <noreply@pslhq.app>")).toBe("<m@pslhq.app>")
    expect(messageIdHeader("m", '"Doe, John" <j@Example.COM>')).toBe("<m@example.com>")
  })

  // The two forms must agree, or the same message routed through a display name
  // and a bare address would be two different messages to a receiver.
  it("gives a display name and a bare address the same value", () => {
    expect(messageIdHeader("m", "Name <a@b.com>")).toBe(messageIdHeader("m", "a@b.com"))
  })
})

describe("a failure to record the outcome", () => {
  // ⚠ THE CASE THAT USED TO VANISH. `inBatches` caught everything with
  // `.catch(() => {})`, so a Postgres failure right after SES accepted a
  // message left the row `sending`, nothing billed, and not one line anywhere
  // saying it had happened.
  it("counts it, logs it and reports it", async () => {
    const boom = new Error("connection terminated unexpectedly")
    const reportError = mock()
    const { deps: d, log } = deps({
      transportFor: () =>
        fakeTransport(() => ({ status: "sent", providerMessageId: "ses-1" })),
      markSent: mock(async () => {
        throw boom
      }),
      reportError,
    })

    const result = await handleBatch(job(2), d)

    expect(result).toMatchObject({ claimed: 2, sent: 0, stranded: 2 })
    expect(log.error).toHaveBeenCalledTimes(2)
    expect(reportError).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({ tenantId: "ten-1" }),
    )
  })

  // The other half of the same guarantee: one message failing to record must
  // not abandon the messages beside it, which is what an unhandled rejection
  // escaping the runner would do.
  it("does not abandon the rest of the batch", async () => {
    const markSent = mock(async (m: OutboundMessage) => {
      if (m.id === "msg-1") throw new Error("deadlock detected")
      return SENT_AT
    })
    const { deps: d, metering } = deps({
      transportFor: () =>
        fakeTransport(() => ({ status: "sent", providerMessageId: "ses-1" })),
      markSent,
      // Serial, so the failure is guaranteed to land mid-run rather than in
      // parallel with the others.
      concurrency: 1,
    })

    const result = await handleBatch(job(3), d)

    expect(result).toMatchObject({ claimed: 3, sent: 2, stranded: 1 })
    expect(markSent).toHaveBeenCalledTimes(3)
    expect(metering.recordSent).toHaveBeenCalledTimes(1)
    expect(metering.recordSent).toHaveBeenCalledWith("ten-1", [
      { id: "msg-0", sentAt: SENT_AT },
      { id: "msg-2", sentAt: SENT_AT },
    ])
  })

  // ⚠ THE REPORTER IS OPTIONAL AND MUST NOT BE ABLE TO BREAK THE BATCH EITHER.
  // A logger that throws inside the handler for a throw is the one way this
  // could still lose the remaining messages.
  it("survives a reporter that throws", async () => {
    const { deps: d } = deps({
      transportFor: () =>
        fakeTransport(() => ({ status: "sent", providerMessageId: "ses-1" })),
      markSent: mock(async () => {
        throw new Error("write failed")
      }),
      reportError: () => {
        throw new Error("sentry is down too")
      },
    })

    await expect(handleBatch(job(2), d)).resolves.toMatchObject({ stranded: 2 })
  })
})

describe("routing within one batch", () => {
  /**
   * ⚠ A BATCH IS PER TENANT AND A ROUTE IS PER DOMAIN, so one job can legitimately
   * contain both. Resolving once for the batch would send half of it the wrong way.
   */
  it("sends each message through its own route's transport", async () => {
    const ses = fakeTransport(() => ({ status: "sent", providerMessageId: "ses-1" }))
    const direct = fakeTransport(() => ({ status: "sent", providerMessageId: "mta-1" }))

    const { deps: d } = deps({
      // Even messages direct, odd through SES.
      route: (m) => (Number(m.id.replace(/\D/g, "")) % 2 === 0 ? "direct" : "ses"),
      transportFor: (r) => (r === "direct" ? direct : ses),
    })

    const result = await handleBatch(job(4), d)

    expect(result.sent).toBe(4)
    expect(ses.sent).toHaveLength(2)
    expect(direct.sent).toHaveLength(2)
  })

  /**
   * ⚠ THE ROW MUST RECORD THE ROUTE THAT ACTUALLY CARRIED IT. `sent_route` and
   * `provider_message_id` are written by one statement precisely so a row can
   * never claim SES carried it while holding an id our own MTA issued.
   */
  it("stamps the route it actually used alongside the provider's id", async () => {
    const markSent = mock(async () => SENT_AT)
    const { deps: d } = deps({
      markSent,
      route: () => "direct" as const,
      transportFor: () =>
        fakeTransport(() => ({ status: "sent", providerMessageId: "mta-7" })),
    })

    await handleBatch(job(1), d)

    expect(markSent).toHaveBeenCalledWith(expect.anything(), "mta-7", "direct")
  })
})
