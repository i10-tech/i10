import { describe, expect, it, mock } from "bun:test"
import {
  deliverWebhook,
  type AttemptLog,
  type DeliveryRecord,
  type FailureDecision,
} from "../src/webhooks/deliver.js"
import { verifySignature } from "../src/webhooks/signing.js"

const SECRET = "whsec_MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3"

const record = (over: Partial<DeliveryRecord> = {}): DeliveryRecord => ({
  id: "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f60aa",
  tenantId: "ten-1",
  endpointId: "ep-1",
  url: "https://hooks.example.com/i10",
  keys: [{ scheme: "hmac_sha256", secret: SECRET }],
  eventType: "email.bounced",
  occurredAt: new Date("2026-09-03T10:00:00Z"),
  payload: { email_id: "msg-1" },
  attempts: 0,
  retryPolicy: "pro",
  sequence: 7,
  firstFailedAt: null,
  lane: "ordered",
  rateLimit: null,
  ...over,
})

const job = { deliveryId: record().id, endpointId: "ep-1", tenantId: "ten-1" }

function deps(over: Record<string, unknown> = {}) {
  const markDelivered = mock(async () => {})
  // Typed so the assertions below can index the recorded arguments.
  const markFailed = mock<
    (
      delivery: DeliveryRecord,
      outcome: { reason: string; responseStatus?: number },
      decision: FailureDecision,
      attempt: AttemptLog,
    ) => Promise<void>
  >(async () => {})
  const log = { info: mock(), warn: mock(), error: mock() }
  const doFetch = mock(async () => new Response("", { status: 200 }))
  return {
    deps: {
      load: async () => record(),
      markDelivered,
      markFailed,
      fetch: doFetch as unknown as typeof fetch,
      // A public answer for every host. Vetting itself is covered in
      // webhook-egress.test.ts; these tests are about what is sent.
      vet: async () => ({
        ok: true as const,
        address: "93.184.215.14",
        family: 4 as const,
      }),
      log,
      ...over,
    },
    markDelivered,
    markFailed,
    doFetch,
    log,
  }
}

const requestOf = (doFetch: ReturnType<typeof mock>) =>
  doFetch.mock.calls[0] as unknown as [string, RequestInit]

describe("a successful delivery", () => {
  it("posts the signed envelope and records it", async () => {
    const { deps: d, markDelivered, doFetch } = deps()

    const outcome = await deliverWebhook(job, d)

    expect(outcome).toEqual({ status: "delivered", responseStatus: 200 })
    expect(markDelivered).toHaveBeenCalledTimes(1)

    const [url, init] = requestOf(doFetch)
    // ⚠ PINNED: the vetted address in the URL, the customer's name in Host and
    // in the TLS server name. See webhooks/egress.ts.
    expect(url).toBe("https://93.184.215.14/i10")
    const headers = init.headers as Record<string, string>
    expect(headers.host).toBe("hooks.example.com")
    expect((init as { tls?: { serverName?: string } }).tls?.serverName).toBe(
      "hooks.example.com",
    )
    // ⚠ VERIFIED THE WAY A RECEIVER VERIFIES IT - the three Standard Webhooks
    // headers, with the id and timestamp read back off the request rather than
    // assumed. This is the assertion that would catch the sender and any
    // conforming verifier disagreeing on the wire format.
    expect(
      verifySignature(
        SECRET,
        headers["webhook-id"]!,
        String(init.body),
        headers["webhook-signature"]!,
        headers["webhook-timestamp"]!,
      ),
    ).toBe(true)
  })

  // ⚠ STABLE ACROSS RETRIES, WHICH IS THE ONLY THING THAT LETS A CUSTOMER BE
  // IDEMPOTENT. We deliver at least once - a timeout after their handler
  // committed is indistinguishable from a failure - so they need a key to store.
  it("sends the delivery id as the idempotency key", async () => {
    const { deps: d, doFetch } = deps()
    await deliverWebhook(job, d)
    const headers = requestOf(doFetch)[1].headers as Record<string, string>
    expect(headers["webhook-id"]).toBe(record().id)
  })

  it("sends the event envelope, not the bare payload", async () => {
    const { deps: d, doFetch } = deps()
    await deliverWebhook(job, d)
    expect(JSON.parse(String(requestOf(doFetch)[1].body))).toEqual({
      id: record().id,
      type: "email.bounced",
      created_at: "2026-09-03T10:00:00.000Z",
      sequence: 7,
      data: { email_id: "msg-1" },
    })
  })

  it.each([200, 201, 202, 204])("treats %d as success", async (status) => {
    const { deps: d, markDelivered } = deps({
      // 204 must carry a null body - the Response constructor refuses "".
      fetch: mock(async () => new Response(status === 204 ? null : "", { status })),
    })
    await deliverWebhook(job, d)
    expect(markDelivered).toHaveBeenCalledTimes(1)
  })
})

describe("a failing delivery", () => {
  // ⚠ ANYTHING THAT IS NOT 2xx IS A FAILURE. Treating "the server answered at
  // all" as success would silently drop every event for a mis-configured route.
  it.each([301, 400, 401, 404, 500])("treats %d as failure", async (status) => {
    const { deps: d, markFailed } = deps({
      fetch: mock(async () => new Response("", { status })),
    })
    expect(await deliverWebhook(job, d)).toMatchObject({ status: "failed" })
    expect(markFailed).toHaveBeenCalledTimes(1)
  })

  // ⚠ THE FAILURE THAT TAKES DOWN A QUEUE IS NOT AN ERROR - it is a socket that
  // accepts the connection and says nothing.
  it("bounds the request with a timeout", async () => {
    const { deps: d, doFetch } = deps()
    await deliverWebhook(job, d)
    expect(requestOf(doFetch)[1].signal).toBeDefined()
  })

  it("names a timeout in words a human can act on", async () => {
    const timeout = Object.assign(new Error("aborted"), { name: "TimeoutError" })
    const { deps: d, markFailed } = deps({
      fetch: mock(async () => {
        throw timeout
      }),
    })
    await deliverWebhook(job, d)
    expect(markFailed.mock.calls[0]![1]).toMatchObject({
      reason: "timed out waiting for a response",
    })
  })

  // ⚠ NEVER THROWN. The next attempt is returned as `retryAt` for the engine
  // to schedule, and the last attempt has nothing to schedule - a customer's
  // dead endpoint must not fill the failed-job list a real bug needs.
  it("has no next attempt once the budget is gone", async () => {
    const { deps: d, markFailed } = deps({
      // Pro allows 8 attempts; this is the eighth.
      load: async () => record({ attempts: 7 }),
      fetch: mock(async () => new Response("", { status: 500 })),
    })

    const outcome = await deliverWebhook(job, d)

    expect(outcome).toMatchObject({ status: "failed" })
    expect(outcome).not.toHaveProperty("retryAt")
    expect(markFailed.mock.calls[0]![2].nextAttemptAt).toBeNull()
  })

  it("marks intermediate attempts as not final", async () => {
    const { deps: d, markFailed } = deps({
      load: async () => record({ attempts: 1 }),
      fetch: mock(async () => new Response("", { status: 503 })),
    })
    const before = Date.now()
    const outcome = await deliverWebhook(job, d)
    // ⚠ THE ROW LEARNS WHEN IT IS OWED IN THE SAME CALL THAT RECORDS THE
    // FAILURE, before anything is queued, so the sweep can find it (#279).
    // Pro's second gap is 5 minutes, give or take 20% jitter.
    const next = markFailed.mock.calls[0]![2].nextAttemptAt!
    expect(next.getTime() - before).toBeGreaterThanOrEqual(240_000)
    expect(next.getTime() - before).toBeLessThanOrEqual(360_500)
    expect(outcome).toMatchObject({ status: "failed", retryAt: next })
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

describe("what the endpoint says about itself (#276)", () => {
  const failWith = (response: () => Response, attempts = 0) =>
    deps({
      load: async () => record({ attempts }),
      fetch: mock(async () => response()),
    })
  const gapOf = async (d: ReturnType<typeof deps>) => {
    const before = Date.now()
    await deliverWebhook(job, d.deps)
    return d.markFailed.mock.calls[0]![2].nextAttemptAt!.getTime() - before
  }

  it("waits at least a minute after a 429, whatever the schedule says", async () => {
    // Pro's first gap is 5 seconds.
    expect(
      await gapOf(failWith(() => new Response("", { status: 429 }))),
    ).toBeGreaterThanOrEqual(60_000)
  })

  it("waits at least a minute after a timeout", async () => {
    const timeout = Object.assign(new Error("aborted"), { name: "TimeoutError" })
    const d = deps({
      fetch: mock(async () => {
        throw timeout
      }),
    })
    expect(await gapOf(d)).toBeGreaterThanOrEqual(60_000)
  })

  it("honours Retry-After in seconds, and jitter never shortens it", async () => {
    for (let i = 0; i < 20; i++) {
      const gap = await gapOf(
        failWith(
          () => new Response("", { status: 503, headers: { "retry-after": "120" } }),
        ),
      )
      expect(gap).toBeGreaterThanOrEqual(120_000)
    }
  })

  it("honours Retry-After as an HTTP date", async () => {
    const at = new Date(Date.now() + 300_000).toUTCString()
    const gap = await gapOf(
      failWith(() => new Response("", { status: 503, headers: { "retry-after": at } })),
    )
    expect(gap).toBeGreaterThanOrEqual(298_000)
  })

  it("caps Retry-After at an hour", async () => {
    const gap = await gapOf(
      failWith(
        () => new Response("", { status: 503, headers: { "retry-after": "86400" } }),
      ),
    )
    expect(gap).toBeLessThanOrEqual(3_600_500)
  })

  it("ignores a Retry-After it cannot read", async () => {
    const gap = await gapOf(
      failWith(
        () => new Response("", { status: 503, headers: { "retry-after": "soon" } }),
      ),
    )
    expect(gap).toBeLessThan(10_000)
  })

  // ⚠ A 410 IS THE RECEIVER SAYING IT IS NOT COMING BACK. The delivery ends
  // and the endpoint is switched off at once, with the reason recorded.
  it("ends the delivery and disables the endpoint on 410 Gone", async () => {
    const d = failWith(() => new Response("", { status: 410 }))
    const outcome = await deliverWebhook(job, d.deps)
    const decision = d.markFailed.mock.calls[0]![2]
    expect(decision.nextAttemptAt).toBeNull()
    expect(decision.disable).toEqual({
      kind: "gone",
      reason: "The endpoint answered 410 Gone.",
    })
    expect(outcome).not.toHaveProperty("retryAt")
  })

  it("asks for time-based disabling, by plan, on other failures", async () => {
    const d = failWith(() => new Response("", { status: 500 }))
    await deliverWebhook(job, d.deps)
    expect(d.markFailed.mock.calls[0]![2].disable).toEqual({
      kind: "after",
      seconds: 5 * 86_400,
    })
  })
})

describe("ordered while healthy (#277, decision 1)", () => {
  const failing = (over: Partial<DeliveryRecord>) =>
    deps({
      load: async () => record(over),
      fetch: mock(async () => new Response("", { status: 500 })),
    })

  it("keeps a young failure on the ordered lane, holding the endpoint", async () => {
    const d = failing({ attempts: 0 })
    const outcome = await deliverWebhook(job, d.deps)
    expect(d.markFailed.mock.calls[0]![2].lane).toBe("ordered")
    expect(outcome).toMatchObject({ lane: "ordered" })
  })

  it("moves it to the retry lane once the next attempt would pass the hold", async () => {
    // First failed six minutes ago; the hold is five.
    const d = failing({ attempts: 2, firstFailedAt: new Date(Date.now() - 6 * 60_000) })
    const outcome = await deliverWebhook(job, d.deps)
    expect(d.markFailed.mock.calls[0]![2].lane).toBe("retry")
    expect(outcome).toMatchObject({ lane: "retry" })
  })

  it("never moves one back once it has been set aside", async () => {
    const d = failing({ attempts: 1, lane: "retry", firstFailedAt: new Date() })
    await deliverWebhook(job, d.deps)
    expect(d.markFailed.mock.calls[0]![2].lane).toBe("retry")
  })

  it("leaves the envelope without a sequence for rows from before it existed", async () => {
    const { deps: dd, doFetch } = deps({ load: async () => record({ sequence: null }) })
    await deliverWebhook(job, dd)
    expect(JSON.parse(String(requestOf(doFetch)[1].body))).not.toHaveProperty(
      "sequence",
    )
  })
})

describe("the attempt log (#280)", () => {
  const logOf = (d: ReturnType<typeof deps>, which: "delivered" | "failed") =>
    which === "delivered"
      ? (
          d.markDelivered.mock.calls[0] as unknown as [
            DeliveryRecord,
            number,
            AttemptLog,
          ]
        )[2]
      : (
          d.markFailed.mock.calls[0] as unknown as [
            DeliveryRecord,
            unknown,
            FailureDecision,
            AttemptLog,
          ]
        )[3]

  it("keeps what was sent, but never the signature", async () => {
    const d = deps()
    await deliverWebhook(job, d.deps)
    const log = logOf(d, "delivered")
    expect(log.requestHeaders["webhook-id"]).toBe(record().id)
    expect(log.requestHeaders).not.toHaveProperty("webhook-signature")
    expect(log).toMatchObject({
      attempt: 1,
      trigger: "scheduled",
      lane: "ordered",
      responseStatus: 200,
    })
    expect(log.durationMs).toBeGreaterThanOrEqual(0)
  })

  it("keeps the endpoint's answer, cut at 20KB", async () => {
    const d = deps({
      fetch: mock(
        async () =>
          new Response("x".repeat(50_000), {
            status: 500,
            headers: { "x-req": "abc" },
          }),
      ),
    })
    await deliverWebhook(job, d.deps)
    const log = logOf(d, "failed")
    expect(log.responseBody).toHaveLength(20_000)
    expect(log.responseHeaders?.["x-req"]).toBe("abc")
    expect(log).toMatchObject({ errorKind: "status", responseStatus: 500 })
  })

  it.each([
    [Object.assign(new Error("aborted"), { name: "TimeoutError" }), "timeout"],
    [
      Object.assign(new Error("bad cert"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" }),
      "tls",
    ],
    [Object.assign(new Error("refused"), { code: "ECONNREFUSED" }), "connect"],
  ])("names %s as %s", async (err, kind) => {
    const d = deps({
      fetch: mock(async () => {
        throw err
      }),
    })
    await deliverWebhook(job, d.deps)
    expect(logOf(d, "failed")).toMatchObject({ errorKind: kind })
    expect(logOf(d, "failed").responseStatus).toBeUndefined()
  })

  it("names a refused address as blocked, with nothing sent", async () => {
    const d = deps({
      vet: async () => ({
        ok: false as const,
        kind: "blocked" as const,
        reason: "x resolves to 10.0.0.1",
      }),
    })
    await deliverWebhook(job, d.deps)
    expect(logOf(d, "failed")).toMatchObject({
      errorKind: "blocked",
      requestHeaders: {},
    })
  })

  it("records the trigger the job carries", async () => {
    const d = deps()
    await deliverWebhook({ ...job, trigger: "manual" }, d.deps)
    expect(logOf(d, "delivered").trigger).toBe("manual")
  })
})
