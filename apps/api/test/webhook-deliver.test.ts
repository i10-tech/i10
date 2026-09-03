import { describe, expect, it, vi } from "vitest"
import { deliverWebhook, type DeliveryRecord } from "../src/webhooks/deliver.js"
import { verifySignature } from "../src/webhooks/signing.js"

const SECRET = "whsec_0123456789abcdef0123456789abcdef"

const record = (over: Partial<DeliveryRecord> = {}): DeliveryRecord => ({
  id: "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f60aa",
  tenantId: "ten-1",
  endpointId: "ep-1",
  url: "https://hooks.example.com/i10",
  secret: SECRET,
  eventType: "email.bounced",
  occurredAt: new Date("2026-09-03T10:00:00Z"),
  payload: { email_id: "msg-1" },
  attempts: 0,
  ...over,
})

const job = { deliveryId: record().id, endpointId: "ep-1", tenantId: "ten-1" }

function deps(over: Record<string, unknown> = {}) {
  const markDelivered = vi.fn(async () => {})
  // Typed so the assertions below can index the recorded arguments.
  const markFailed = vi.fn<
    (
      delivery: DeliveryRecord,
      outcome: { reason: string; responseStatus?: number },
      final: boolean,
    ) => Promise<void>
  >(async () => {})
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const doFetch = vi.fn(async () => new Response("", { status: 200 }))
  return {
    deps: {
      load: async () => record(),
      markDelivered,
      markFailed,
      fetch: doFetch as unknown as typeof fetch,
      log,
      maxAttempts: 5,
      ...over,
    },
    markDelivered,
    markFailed,
    doFetch,
    log,
  }
}

const requestOf = (doFetch: ReturnType<typeof vi.fn>) =>
  doFetch.mock.calls[0] as unknown as [string, RequestInit]

describe("a successful delivery", () => {
  it("posts the signed envelope and records it", async () => {
    const { deps: d, markDelivered, doFetch } = deps()

    const outcome = await deliverWebhook(job, d)

    expect(outcome).toEqual({ status: "delivered", responseStatus: 200 })
    expect(markDelivered).toHaveBeenCalledOnce()

    const [url, init] = requestOf(doFetch)
    expect(url).toBe("https://hooks.example.com/i10")
    const headers = init.headers as Record<string, string>
    // ⚠ VERIFIED THE WAY THE SHIPPED SDK VERIFIES IT — separate signature and
    // timestamp headers, bare hex digest. This is the assertion that would have
    // caught the sender and `@i10/next` disagreeing on the wire format.
    expect(
      verifySignature(
        SECRET,
        String(init.body),
        headers["i10-signature"]!,
        headers["i10-timestamp"]!,
      ),
    ).toBe(true)
  })

  // ⚠ STABLE ACROSS RETRIES, WHICH IS THE ONLY THING THAT LETS A CUSTOMER BE
  // IDEMPOTENT. We deliver at least once — a timeout after their handler
  // committed is indistinguishable from a failure — so they need a key to store.
  it("sends the delivery id as the idempotency key", async () => {
    const { deps: d, doFetch } = deps()
    await deliverWebhook(job, d)
    const headers = requestOf(doFetch)[1].headers as Record<string, string>
    expect(headers["i10-webhook-id"]).toBe(record().id)
  })

  it("sends the event envelope, not the bare payload", async () => {
    const { deps: d, doFetch } = deps()
    await deliverWebhook(job, d)
    expect(JSON.parse(String(requestOf(doFetch)[1].body))).toEqual({
      id: record().id,
      type: "email.bounced",
      created_at: "2026-09-03T10:00:00.000Z",
      data: { email_id: "msg-1" },
    })
  })

  it.each([200, 201, 202, 204])("treats %d as success", async (status) => {
    const { deps: d, markDelivered } = deps({
      // 204 must carry a null body — the Response constructor refuses "".
      fetch: vi.fn(async () => new Response(status === 204 ? null : "", { status })),
    })
    await deliverWebhook(job, d)
    expect(markDelivered).toHaveBeenCalledOnce()
  })
})

describe("a failing delivery", () => {
  // ⚠ ANYTHING THAT IS NOT 2xx IS A FAILURE. Treating "the server answered at
  // all" as success would silently drop every event for a mis-configured route.
  it.each([301, 400, 401, 404, 500])("treats %d as failure", async (status) => {
    const { deps: d, markFailed } = deps({
      fetch: vi.fn(async () => new Response("", { status })),
    })
    await expect(deliverWebhook(job, d)).rejects.toThrow()
    expect(markFailed).toHaveBeenCalledOnce()
  })

  // ⚠ THE FAILURE THAT TAKES DOWN A QUEUE IS NOT AN ERROR — it is a socket that
  // accepts the connection and says nothing.
  it("bounds the request with a timeout", async () => {
    const { deps: d, doFetch } = deps()
    await deliverWebhook(job, d)
    expect(requestOf(doFetch)[1].signal).toBeDefined()
  })

  it("names a timeout in words a human can act on", async () => {
    const timeout = Object.assign(new Error("aborted"), { name: "TimeoutError" })
    const { deps: d, markFailed } = deps({
      fetch: vi.fn(async () => {
        throw timeout
      }),
    })
    await expect(deliverWebhook(job, d)).rejects.toThrow()
    expect(markFailed.mock.calls[0]![1]).toMatchObject({
      reason: "timed out waiting for a response",
    })
  })

  // ⚠ THROWN WHILE THERE IS BUDGET SO groupmq SCHEDULES THE RETRY, AND NOT ON
  // THE LAST ATTEMPT — a customer's dead endpoint must not fill the failed-job
  // list that a real bug needs to be visible in.
  it("stops throwing once the budget is gone", async () => {
    const { deps: d, markFailed } = deps({
      load: async () => record({ attempts: 4 }),
      fetch: vi.fn(async () => new Response("", { status: 500 })),
    })

    const outcome = await deliverWebhook(job, d)

    expect(outcome).toMatchObject({ status: "failed" })
    expect(markFailed.mock.calls[0]![2]).toBe(true)
  })

  it("marks intermediate attempts as not final", async () => {
    const { deps: d, markFailed } = deps({
      load: async () => record({ attempts: 1 }),
      fetch: vi.fn(async () => new Response("", { status: 503 })),
    })
    await expect(deliverWebhook(job, d)).rejects.toThrow()
    expect(markFailed.mock.calls[0]![2]).toBe(false)
  })

  // A customer's 302 to somewhere else is not somewhere we should sign a
  // payload for.
  it("does not follow redirects", async () => {
    const { deps: d, doFetch } = deps()
    await deliverWebhook(job, d)
    expect(requestOf(doFetch)[1].redirect).toBe("manual")
  })
})

describe("a delivery that no longer applies", () => {
  // ⚠ NOT AN ERROR. The row is gone, or another worker already delivered it;
  // throwing would make groupmq retry a job whose work no longer exists.
  it("skips without sending anything", async () => {
    const { deps: d, doFetch, markFailed } = deps({ load: async () => null })
    expect(await deliverWebhook(job, d)).toEqual({ status: "skipped" })
    expect(doFetch).not.toHaveBeenCalled()
    expect(markFailed).not.toHaveBeenCalled()
  })
})
