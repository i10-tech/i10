import type { SendEmail } from "@repo/contracts"
import { describe, expect, it, vi } from "vitest"
import {
  acceptSend,
  addrSpec,
  asList,
  classFor,
  hashRequest,
  withoutSuppressed,
  type AcceptOps,
} from "../src/send/accept.js"
import { unmetered, type Metering } from "../src/send/metering.js"

const email = (over: Partial<SendEmail> = {}): SendEmail =>
  ({
    from: "hello@i10.tech",
    to: "user@example.com",
    subject: "Hi",
    text: "body",
    ...over,
  }) as SendEmail

function ops(over: Partial<AcceptOps> = {}) {
  const enqueue = vi.fn(async () => {})
  const persist = vi.fn(async (input: { messages: unknown[] }) => ({
    status: "written" as const,
    ids: input.messages.map((_, i) => `msg-${i}`),
    refs: input.messages.map((_, i) => ({
      id: `msg-${i}`,
      createdAt: new Date("2026-09-02T10:00:00Z"),
    })),
  }))
  const suppressedFor = vi.fn(async () => new Set<string>())
  const log = { warn: vi.fn(), error: vi.fn() }
  return {
    deps: {
      persist,
      suppressedFor,
      enqueue,
      metering: unmetered,
      log,
      ...over,
    } as AcceptOps & { metering: Metering; log: typeof log },
    persist,
    enqueue,
    suppressedFor,
    log,
  }
}

const accept = (deps: ReturnType<typeof ops>["deps"], over = {}) =>
  acceptSend(
    {
      tenantId: "ten-1",
      apiKeyId: "key-1",
      payloads: [email()],
      endpoint: "single" as const,
      ...over,
    },
    deps,
  )

describe("the request hash", () => {
  // ⚠ Without this a legitimate retry from a different SDK version looks like a
  // conflict, because JSON.stringify preserves insertion order.
  it("does not depend on key order", () => {
    expect(hashRequest({ a: 1, b: 2 })).toBe(hashRequest({ b: 2, a: 1 }))
  })

  it("does not depend on undefined fields being present", () => {
    expect(hashRequest({ a: 1, b: undefined })).toBe(hashRequest({ a: 1 }))
  })

  it("changes when the content changes", () => {
    expect(hashRequest(email())).not.toBe(hashRequest(email({ subject: "Other" })))
  })

  // Order in an array is meaningful — a different recipient order is a
  // different email.
  it("respects array order", () => {
    expect(hashRequest([1, 2])).not.toBe(hashRequest([2, 1]))
  })

  it("handles nesting", () => {
    expect(hashRequest({ h: { x: 1, y: 2 } })).toBe(hashRequest({ h: { y: 2, x: 1 } }))
  })
})

describe("suppression", () => {
  // ⚠ Reputation is shared across every tenant on the same SES account, so one
  // customer ignoring their list degrades deliverability for all of them.
  it("removes suppressed recipients from every field", () => {
    const prepared = withoutSuppressed(
      email({ to: ["a@x.com", "b@x.com"], cc: ["c@x.com"], bcc: ["a@x.com"] }),
      new Set(["a@x.com"]),
    )
    expect(prepared.to).toEqual(["b@x.com"])
    expect(prepared.cc).toEqual(["c@x.com"])
    expect(prepared.bcc).toEqual([])
  })

  it("matches case-insensitively", () => {
    const prepared = withoutSuppressed(
      email({ to: ["Bounced@Example.COM"] }),
      new Set(["bounced@example.com"]),
    )
    expect(prepared.to).toEqual([])
  })

  // ⚠ THE BYPASS THAT WOULD NEVER BE NOTICED. A display name around a
  // suppressed address must not make it sendable again — the send would
  // succeed, and the cost would land on the SES reputation every tenant shares.
  it("sees through a display name", () => {
    const prepared = withoutSuppressed(
      email({ to: ["Bob Bounced <bob@x.com>"] }),
      new Set(["bob@x.com"]),
    )
    expect(prepared.to).toEqual([])
  })

  it("reduces an address to its addr-spec", () => {
    expect(addrSpec("Bob <Bob@X.com>")).toBe("bob@x.com")
    expect(addrSpec("  bob@x.com ")).toBe("bob@x.com")
  })

  // ⚠ Accepted and recorded, never queued. The caller did nothing wrong and the
  // dashboard needs to be able to explain it — a 422 would show nothing.
  it("accepts a message whose recipients are all suppressed, but never queues it", async () => {
    const { deps, enqueue, persist } = ops({
      suppressedFor: async () => new Set(["user@example.com"]),
    })

    const result = await accept(deps)

    expect(result.status).toBe("accepted")
    expect(persist).toHaveBeenCalledTimes(1)
    expect(enqueue).not.toHaveBeenCalled()
  })

  it("queues the survivors of a mixed batch and not the rest", async () => {
    const { deps, enqueue } = ops({
      suppressedFor: async () => new Set(["gone@example.com"]),
    })

    await accept(deps, {
      payloads: [email({ to: "gone@example.com" }), email({ to: "ok@example.com" })],
      endpoint: "batch" as const,
    })

    const call = enqueue.mock.calls[0] as unknown as [unknown, { messages: unknown[] }]
    expect(call[1].messages).toHaveLength(1)
  })
})

describe("quota", () => {
  // ⚠ Before anything is written: the alternative is a database full of
  // messages that will never be allowed to send.
  it("refuses before persisting or queueing", async () => {
    const metering: Metering = {
      checkQuota: async () => ({ status: "exceeded", message: "out of credits" }),
      recordSent: async () => {},
    }
    const { deps, persist, enqueue } = ops({ metering } as never)

    const result = await accept(deps)

    expect(result).toEqual({ status: "quota_exceeded", message: "out of credits" })
    expect(persist).not.toHaveBeenCalled()
    expect(enqueue).not.toHaveBeenCalled()
  })

  // A metering outage must not stop a paying customer's password resets.
  it("accepts when metering is unavailable", async () => {
    const metering: Metering = {
      checkQuota: async () => ({ status: "unavailable", message: "down" }),
      recordSent: async () => {},
    }
    const { deps } = ops({ metering } as never)
    expect((await accept(deps)).status).toBe("accepted")
  })

  it("counts a batch once rather than per message", async () => {
    const checkQuota = vi.fn(async () => ({ status: "allowed" as const }))
    const { deps } = ops({
      metering: { checkQuota, recordSent: async () => {} },
    } as never)

    await accept(deps, { payloads: [email(), email(), email()] })

    expect(checkQuota).toHaveBeenCalledExactlyOnceWith("ten-1", 3)
  })
})

describe("idempotency", () => {
  // ⚠ Returns the FIRST ids and queues nothing. Queueing again would be a
  // second job for messages that may already have been sent.
  it("replays without enqueueing", async () => {
    const { deps, enqueue } = ops({
      persist: async () => ({ status: "replayed", ids: ["msg-original"] }),
    } as never)

    const result = await accept(deps, { idempotencyKey: "k-1" })

    expect(result).toEqual({ status: "replayed", ids: ["msg-original"] })
    expect(enqueue).not.toHaveBeenCalled()
  })

  // ⚠ Neither a silent replay nor a second send — both are wrong and which one
  // the caller wanted is unknowable.
  it("reports a conflict for a reused key with a different body", async () => {
    const { deps, enqueue } = ops({
      persist: async () => ({ status: "conflict" }),
    } as never)

    const result = await accept(deps, { idempotencyKey: "k-1" })

    expect(result.status).toBe("conflict")
    expect(enqueue).not.toHaveBeenCalled()
  })

  it("passes the key and hash down to the transaction", async () => {
    const { deps, persist } = ops()
    await accept(deps, { idempotencyKey: "k-1" })
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "k-1",
        requestHash: hashRequest([email()]),
      }),
    )
  })
})

describe("the order of operations", () => {
  // ⚠ THE ONE THAT LOSES MAIL IF IT REGRESSES. A job whose rows are not
  // committed finds nothing to claim and is dropped silently.
  it("persists before it enqueues", async () => {
    const order: string[] = []
    const { deps } = ops({
      persist: async () => {
        order.push("persist")
        return {
          status: "written" as const,
          ids: ["msg-0"],
          refs: [{ id: "msg-0", createdAt: new Date() }],
        }
      },
      enqueue: async () => {
        order.push("enqueue")
      },
    } as never)

    await accept(deps)

    expect(order).toEqual(["persist", "enqueue"])
  })

  // The rows are committed and the sweep will find them. Reporting a failure
  // would make an SDK retry and send everything twice.
  it("still accepts when the enqueue fails after commit", async () => {
    const { deps, log } = ops({
      enqueue: async () => {
        throw new Error("redis down")
      },
    })

    const result = await accept(deps)

    expect(result).toMatchObject({ status: "accepted", ids: ["msg-0"] })
    expect(log.error).toHaveBeenCalled()
  })
})

describe("routing", () => {
  // ⚠ A thousand-message batch must never queue in front of a password reset.
  it("sends single messages to transactional and batches to bulk", () => {
    expect(classFor("single")).toBe("transactional")
    expect(classFor("batch")).toBe("bulk")
  })

  it("queues onto the class it chose", async () => {
    const { deps, enqueue } = ops()
    await accept(deps, { endpoint: "batch" as const })
    expect(enqueue).toHaveBeenCalledWith("bulk", expect.anything())
  })
})

describe("address lists", () => {
  // The contract allows a single address or an array; everything downstream
  // wants an array.
  it("normalises both shapes", () => {
    expect(asList("a@x.com")).toEqual(["a@x.com"])
    expect(asList(["a@x.com", "b@x.com"])).toEqual(["a@x.com", "b@x.com"])
    expect(asList(undefined)).toEqual([])
  })
})
