import { createHmac } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import { createWebhookHandler, verifySignature } from "../src/webhook.js"

const SECRET = "whsec_test"

const sign = (body: string, timestamp: string) =>
  createHmac("sha256", SECRET).update(`${timestamp}.${body}`).digest("hex")

const now = () => String(Math.floor(Date.now() / 1000))

describe("the wire format", () => {
  /**
   * ⚠ THE CROSS-PACKAGE CONTRACT, PINNED FROM BOTH SIDES. The sender lives in
   * `apps/api/src/webhooks/signing.ts` and is a separate implementation of this
   * same format — nothing but this vector holds the two together. The identical
   * constants are asserted in `apps/api/test/webhook-signing.test.ts`; change
   * one without the other and a test fails here rather than every customer's
   * endpoint answering 401 in production.
   *
   * Verified with a tolerance far past the fixed timestamp, because the point
   * is the digest rather than the freshness rule tested below.
   */
  const VECTOR = {
    secret: "whsec_0123456789abcdef0123456789abcdef",
    body: JSON.stringify({ id: "wh_1", type: "email.bounced" }),
    timestamp: "1788386400",
    signature: "f2a6c9f650763a68c624af56852529eae40a53ed3da3b41efbf62edd6f650d5f",
  }

  it("accepts the signature the API produces", () => {
    const forever = Math.abs(Date.now() / 1000 - Number(VECTOR.timestamp)) + 60
    expect(
      verifySignature(
        VECTOR.body,
        VECTOR.signature,
        VECTOR.timestamp,
        VECTOR.secret,
        forever,
      ),
    ).toBe(true)
  })

  it("reads the header names the API sends", async () => {
    const onEvent = vi.fn()
    const ts = now()
    const handler = createWebhookHandler({ secret: SECRET, onEvent })
    const body = JSON.stringify({ type: "email.sent" })

    const res = await handler(
      new Request("https://app.example.com/api/webhooks", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Exactly what webhooks/deliver.ts writes, third header included.
          "i10-webhook-id": "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6071",
          "i10-timestamp": ts,
          "i10-signature": sign(body, ts),
        },
        body,
      }),
    )

    expect(res.status).toBe(204)
    expect(onEvent).toHaveBeenCalled()
  })
})

describe("verifySignature", () => {
  const body = JSON.stringify({ type: "email.delivered" })

  it("accepts a signature over `${timestamp}.${body}`", () => {
    const ts = now()
    expect(verifySignature(body, sign(body, ts), ts, SECRET)).toBe(true)
  })

  it("rejects a signature made with a different secret", () => {
    const ts = now()
    const wrong = createHmac("sha256", "whsec_other")
      .update(`${ts}.${body}`)
      .digest("hex")
    expect(verifySignature(body, wrong, ts, SECRET)).toBe(false)
  })

  // The timestamp is inside the signed payload, not merely alongside it. A
  // signature covering only the body is replayable forever, and a delivered
  // `email.bounced` replayed a thousand times is a suppression list that
  // suppresses everyone.
  it("rejects a valid signature that is outside the tolerance window", () => {
    const old = String(Math.floor(Date.now() / 1000) - 3600)
    expect(verifySignature(body, sign(body, old), old, SECRET)).toBe(false)
  })

  it("rejects a non-numeric timestamp instead of treating it as 0", () => {
    expect(verifySignature(body, sign(body, "nope"), "nope", SECRET)).toBe(false)
  })

  // timingSafeEqual throws on a length mismatch, and the exception path would
  // itself leak the expected length.
  it("returns false rather than throwing on a short signature", () => {
    const ts = now()
    expect(() => verifySignature(body, "abc", ts, SECRET)).not.toThrow()
    expect(verifySignature(body, "abc", ts, SECRET)).toBe(false)
  })
})

describe("createWebhookHandler", () => {
  const body = JSON.stringify({ type: "email.delivered", data: {} })

  const post = (headers: Record<string, string>) =>
    new Request("https://app.i10.tech/api/webhooks/i10", {
      method: "POST",
      headers,
      body,
    })

  it("400s when the signature headers are missing", async () => {
    const onEvent = vi.fn()
    const handler = createWebhookHandler({ secret: SECRET, onEvent })
    expect((await handler(post({}))).status).toBe(400)
    expect(onEvent).not.toHaveBeenCalled()
  })

  it("401s on a bad signature without invoking the handler", async () => {
    const onEvent = vi.fn()
    const handler = createWebhookHandler({ secret: SECRET, onEvent })
    const res = await handler(
      post({ "i10-signature": "deadbeef", "i10-timestamp": now() }),
    )
    expect(res.status).toBe(401)
    expect(onEvent).not.toHaveBeenCalled()
  })

  it("204s and delivers the parsed event on a good signature", async () => {
    const onEvent = vi.fn()
    const ts = now()
    const handler = createWebhookHandler({ secret: SECRET, onEvent })
    const res = await handler(
      post({ "i10-signature": sign(body, ts), "i10-timestamp": ts }),
    )
    expect(res.status).toBe(204)
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "email.delivered" }),
    )
  })
})
