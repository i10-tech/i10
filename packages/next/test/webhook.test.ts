import { createHmac } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import { createWebhookHandler, verifySignature } from "../src/webhook.js"

const SECRET = "whsec_test"

const sign = (body: string, timestamp: string) =>
  createHmac("sha256", SECRET).update(`${timestamp}.${body}`).digest("hex")

const now = () => String(Math.floor(Date.now() / 1000))

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
