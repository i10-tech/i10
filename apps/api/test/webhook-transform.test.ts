import { describe, expect, it, mock } from "bun:test"
import {
  deliverWebhook,
  type AttemptLog,
  type DeliveryRecord,
  type FailureDecision,
} from "../src/webhooks/deliver.js"
import { verifySignature } from "../src/webhooks/signing.js"
import {
  applyTransformation,
  MAX_TRANSFORMED_BODY_BYTES,
  transformer,
  type TransformCall,
  type Transformer,
} from "../src/webhooks/transform.js"

const ENDPOINT = "https://hooks.example.com/i10?v=1"

describe("applyTransformation: nothing a function returns is believed", () => {
  const base = { payload: { a: 1 }, method: "POST", url: ENDPOINT, headers: {} }

  it("sends what it made: method, path and query, headers, JSON body", () => {
    expect(
      applyTransformation(ENDPOINT, {
        ...base,
        method: "PUT",
        url: "https://hooks.example.com/other?x=2#frag",
        headers: { "X-Tag": "t" },
      }),
    ).toEqual({
      ok: true,
      request: {
        method: "PUT",
        url: "/other?x=2",
        headers: { "x-tag": "t" },
        body: '{"a":1}',
      },
    })
    // A relative path works too.
    expect(applyTransformation(ENDPOINT, { ...base, url: "/z" })).toMatchObject({
      ok: true,
      request: { url: "/z" },
    })
  })

  for (const [what, url] of [
    ["another host", "https://evil.example.net/x"],
    ["a protocol-relative host", "//evil.example.net/x"],
    ["another scheme", "http://hooks.example.com/i10"],
    ["another port", "https://hooks.example.com:8443/i10"],
    ["credentials", "https://user:pw@hooks.example.com/i10"],
  ] as const) {
    it(`refuses ${what}`, () => {
      const r = applyTransformation(ENDPOINT, { ...base, url })
      expect(r.ok).toBe(false)
    })
  }

  it("refuses a method off the list, signing headers, oversized bodies and non-objects", () => {
    expect(applyTransformation(ENDPOINT, { ...base, method: "DELETE" }).ok).toBe(false)
    expect(
      applyTransformation(ENDPOINT, {
        ...base,
        headers: { "webhook-signature": "v1,x" },
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("set by i10") })
    expect(applyTransformation(ENDPOINT, { ...base, headers: { host: "x" } }).ok).toBe(
      false,
    )
    expect(applyTransformation(ENDPOINT, { ...base, headers: { a: 1 } }).ok).toBe(false)
    expect(
      applyTransformation(ENDPOINT, {
        ...base,
        payload: "x".repeat(MAX_TRANSFORMED_BODY_BYTES),
      }).ok,
    ).toBe(false)
    expect(applyTransformation(ENDPOINT, null).ok).toBe(false)
    expect(applyTransformation(ENDPOINT, [1]).ok).toBe(false)
  })
})

describe("the sandbox client", () => {
  const answering = (status: number, body: unknown) =>
    transformer({
      url: "http://renderer.test",
      secret: "s",
      fetch: (async () =>
        new Response(JSON.stringify(body), { status })) as unknown as typeof fetch,
    })
  const input = { payload: {}, method: "POST" as const, url: ENDPOINT, headers: {} }

  it("reads 200 and 422 as the function's answer", async () => {
    expect(await answering(200, { ok: true, value: { a: 1 } }).run("c", input)).toEqual(
      {
        status: "ok",
        value: { a: 1 },
      },
    )
    expect(await answering(422, { ok: false, error: "CPU" }).run("c", input)).toEqual({
      status: "error",
      error: "CPU",
    })
  })

  it("reads everything else as our sandbox being unavailable, never the customer's fault", async () => {
    for (const status of [401, 500, 503]) {
      expect((await answering(status, {}).run("c", input)).status).toBe("unavailable")
    }
    const down = transformer({
      url: "http://renderer.test",
      secret: "s",
      fetch: (async () => {
        throw new Error("ECONNREFUSED")
      }) as unknown as typeof fetch,
    })
    expect((await down.run("c", input)).status).toBe("unavailable")
  })
})

const SECRET =
  "whsec_" + Buffer.from("0123456789abcdef0123456789abcdef").toString("base64")
const record = (over: Partial<DeliveryRecord> = {}): DeliveryRecord => ({
  id: "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f60aa",
  tenantId: "ten-1",
  endpointId: "ep-1",
  url: ENDPOINT,
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
  headers: {},
  transformation: "export default (w) => w",
  transformed: null,
  sqs: null,
  ...over,
})
const job = { deliveryId: record().id, endpointId: "ep-1", tenantId: "ten-1" }

function setup(answer: TransformCall, over: Partial<DeliveryRecord> = {}) {
  const run = mock<Transformer["run"]>(async () => answer)
  const saveTransformed = mock(async () => {})
  const release = mock(async () => {})
  const markDelivered = mock(async () => {})
  const markFailed = mock<
    (
      d: DeliveryRecord,
      o: { reason: string },
      x: FailureDecision,
      a: AttemptLog,
    ) => Promise<void>
  >(async () => {})
  const doFetch = mock(async () => new Response("", { status: 200 }))
  return {
    run,
    saveTransformed,
    release,
    markDelivered,
    markFailed,
    doFetch,
    deps: {
      load: async () => record(over),
      markDelivered,
      markFailed,
      saveTransformed,
      release,
      transformer: { run },
      fetch: doFetch as unknown as typeof fetch,
      vet: async () => ({
        ok: true as const,
        address: "93.184.215.14",
        family: 4 as const,
      }),
      log: { info: mock(), warn: mock(), error: mock() },
    },
  }
}

describe("delivering through a transformation", () => {
  it("sends what the function made, signed over those bytes, and fixes it for every retry", async () => {
    const s = setup({
      status: "ok",
      value: {
        payload: { text: "hi" },
        method: "PUT",
        url: "/slack",
        headers: { "x-a": "1" },
      },
    })
    expect(await deliverWebhook(job, s.deps)).toEqual({
      status: "delivered",
      responseStatus: 200,
    })
    // The function saw the envelope, exactly as a receiver would.
    const [, input] = s.run.mock.calls[0]!
    expect(input.payload).toMatchObject({ id: record().id, type: "email.bounced" })

    const [url, init] = s.doFetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://93.184.215.14/slack")
    expect(init.method).toBe("PUT")
    expect(init.body).toBe('{"text":"hi"}')
    const headers = init.headers as Record<string, string>
    expect(headers["x-a"]).toBe("1")
    expect(
      verifySignature(
        SECRET,
        headers["webhook-id"]!,
        String(init.body),
        headers["webhook-signature"]!,
        headers["webhook-timestamp"]!,
      ),
    ).toBe(true)
    expect(s.saveTransformed).toHaveBeenCalledTimes(1)
  })

  it("a delivery already transformed is sent as fixed, without running the function", async () => {
    const s = setup(
      { status: "ok", value: {} },
      {
        transformed: { method: "PATCH", url: "/fixed", headers: {}, body: '"same"' },
      },
    )
    await deliverWebhook(job, s.deps)
    expect(s.run).not.toHaveBeenCalled()
    const [url, init] = s.doFetch.mock.calls[0] as unknown as [string, RequestInit]
    // On the endpoint's CURRENT origin, whatever it was when it was fixed.
    expect(url).toBe("https://93.184.215.14/fixed")
    expect(init.body).toBe('"same"')
  })

  it("a failing function is a failed attempt, saying so, and nothing is sent or fixed", async () => {
    const s = setup({ status: "error", error: "Worker exceeded CPU limit of 50 ms" })
    const outcome = await deliverWebhook(job, s.deps)
    expect(outcome.status).toBe("failed")
    expect(s.doFetch).not.toHaveBeenCalled()
    expect(s.saveTransformed).not.toHaveBeenCalled()
    const [, reason, , attempt] = s.markFailed.mock.calls[0]!
    expect(reason.reason).toContain("CPU limit")
    expect(attempt.errorKind).toBe("transform")
  })

  it("a result that tries to leave the endpoint's origin is refused the same way", async () => {
    const s = setup({
      status: "ok",
      value: { payload: {}, url: "https://evil.example.net/" },
    })
    await deliverWebhook(job, s.deps)
    expect(s.doFetch).not.toHaveBeenCalled()
    expect(s.markFailed.mock.calls[0]![3].errorKind).toBe("transform")
  })

  it("our sandbox being down defers: no attempt, no failure, the row released", async () => {
    const s = setup({ status: "unavailable", error: "ECONNREFUSED" })
    const outcome = await deliverWebhook(job, s.deps)
    expect(outcome.status).toBe("deferred")
    expect(s.release).toHaveBeenCalledTimes(1)
    expect(s.markFailed).not.toHaveBeenCalled()
    expect(s.markDelivered).not.toHaveBeenCalled()
    expect(s.doFetch).not.toHaveBeenCalled()
  })
})
