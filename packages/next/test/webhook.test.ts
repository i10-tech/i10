import { createHmac } from "node:crypto"
import { describe, expect, it, mock } from "bun:test"
import { createWebhookHandler, verifySignature } from "../src/webhook.js"

const SECRET = `whsec_${Buffer.from("a-test-signing-key-24byt").toString("base64")}`
const ID = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6071"

/**
 * ⚠ THIS HELPER IS THE SPEC, WRITTEN OUT ONCE, AND IT MUST NOT BORROW FROM THE
 * CODE UNDER TEST. If it called the SDK's own signer, the two would agree by
 * construction and the tests would pass just as happily on a scheme no other
 * library implements.
 */
const sign = (body: string, id: string, timestamp: string, secret = SECRET) =>
  `v1,${createHmac("sha256", Buffer.from(secret.slice("whsec_".length), "base64"))
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64")}`

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
   * ⚠ AND IT IS PLAIN STANDARD WEBHOOKS, so it is also a contract with every
   * conforming library a customer might reach for instead of this SDK. If it
   * ever needs changing to make our code pass, our code is what is wrong.
   *
   * Verified with a tolerance far past the fixed timestamp, because the point
   * is the digest rather than the freshness rule tested below.
   */
  const VECTOR = {
    secret: "whsec_MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3",
    id: "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6071",
    body: JSON.stringify({ id: "wh_1", type: "email.bounced" }),
    timestamp: "1788386400",
    signature: "v1,NhXfnNyuSgYe2dybGCQwOtgM8b4e9S3JueYvYYXSIpI=",
  }

  it("accepts the signature the API produces", () => {
    const forever = Math.abs(Date.now() / 1000 - Number(VECTOR.timestamp)) + 60
    expect(
      verifySignature(
        VECTOR.body,
        VECTOR.id,
        VECTOR.signature,
        VECTOR.timestamp,
        VECTOR.secret,
        forever,
      ),
    ).toBe(true)
  })

  it("reads the header names the API sends", async () => {
    const onEvent = mock()
    const ts = now()
    const handler = createWebhookHandler({ secret: SECRET, onEvent })
    const body = JSON.stringify({ type: "email.sent" })

    const res = await handler(
      new Request("https://app.example.com/api/webhooks", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Exactly what webhooks/deliver.ts writes. All three are signed.
          "webhook-id": ID,
          "webhook-timestamp": ts,
          "webhook-signature": sign(body, ID, ts),
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

  it("accepts a signature over `${id}.${timestamp}.${body}`", () => {
    const ts = now()
    expect(verifySignature(body, ID, sign(body, ID, ts), ts, SECRET)).toBe(true)
  })

  it("rejects a signature made with a different secret", () => {
    const ts = now()
    const other = `whsec_${Buffer.from("a-different-key-24bytes!").toString("base64")}`
    expect(verifySignature(body, ID, sign(body, ID, ts, other), ts, SECRET)).toBe(false)
  })

  /**
   * ⚠ THE ID IS SIGNED MATERIAL. It travels in its own header, so a receiver
   * that deduplicates on it needs to know it has not been rewritten in flight.
   */
  it("rejects a signature whose id does not match the header", () => {
    const ts = now()
    expect(verifySignature(body, "wh_other", sign(body, ID, ts), ts, SECRET)).toBe(
      false,
    )
  })

  /**
   * ⚠ WHAT THE SPACE-DELIMITED LIST IS FOR. During a secret rotation i10 signs
   * with both, and a verifier that read only the first entry would drop every
   * delivery signed by the outgoing key.
   */
  it("accepts a match anywhere in the list, so rotation does not drop deliveries", () => {
    const ts = now()
    const mine = sign(body, ID, ts)
    const stale = "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    expect(verifySignature(body, ID, `${stale} ${mine}`, ts, SECRET)).toBe(true)
    expect(verifySignature(body, ID, `${mine} ${stale}`, ts, SECRET)).toBe(true)
  })

  it("skips versions it does not implement rather than failing on them", () => {
    const ts = now()
    expect(
      verifySignature(body, ID, `v9,Ynl0ZXM= ${sign(body, ID, ts)}`, ts, SECRET),
    ).toBe(true)
  })

  // The timestamp is inside the signed payload, not merely alongside it. A
  // signature covering only the body is replayable forever, and a delivered
  // `email.bounced` replayed a thousand times is a suppression list that
  // suppresses everyone.
  it("rejects a valid signature that is outside the tolerance window", () => {
    const old = String(Math.floor(Date.now() / 1000) - 3600)
    expect(verifySignature(body, ID, sign(body, ID, old), old, SECRET)).toBe(false)
  })

  it("rejects a non-numeric timestamp instead of treating it as 0", () => {
    expect(verifySignature(body, ID, sign(body, ID, "nope"), "nope", SECRET)).toBe(
      false,
    )
  })

  // timingSafeEqual throws on a length mismatch, and the exception path would
  // itself leak the expected length.
  it("returns false rather than throwing on a malformed signature", () => {
    const ts = now()
    for (const bad of ["abc", "v1,abc", "", "v1,", ","]) {
      expect(() => verifySignature(body, ID, bad, ts, SECRET)).not.toThrow()
      expect(verifySignature(body, ID, bad, ts, SECRET)).toBe(false)
    }
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
    const onEvent = mock()
    const handler = createWebhookHandler({ secret: SECRET, onEvent })
    expect((await handler(post({}))).status).toBe(400)
    expect(onEvent).not.toHaveBeenCalled()
  })

  /**
   * ⚠ A MISSING ID IS A 400, NOT A 401. It is signed material now, so its
   * absence means the request cannot be verified at all rather than that it
   * failed verification — and the distinction is what tells an integrator to
   * check their proxy's header stripping instead of rotating a good secret.
   */
  it("400s when only the id is missing", async () => {
    const onEvent = mock()
    const ts = now()
    const handler = createWebhookHandler({ secret: SECRET, onEvent })
    const res = await handler(
      post({ "webhook-timestamp": ts, "webhook-signature": sign(body, ID, ts) }),
    )
    expect(res.status).toBe(400)
    expect(onEvent).not.toHaveBeenCalled()
  })

  it("401s on a bad signature without invoking the handler", async () => {
    const onEvent = mock()
    const handler = createWebhookHandler({ secret: SECRET, onEvent })
    const res = await handler(
      post({
        "webhook-id": ID,
        "webhook-signature": "v1,ZGVhZGJlZWY=",
        "webhook-timestamp": now(),
      }),
    )
    expect(res.status).toBe(401)
    expect(onEvent).not.toHaveBeenCalled()
  })

  it("204s and delivers the parsed event on a good signature", async () => {
    const onEvent = mock()
    const ts = now()
    const handler = createWebhookHandler({ secret: SECRET, onEvent })
    const res = await handler(
      post({
        "webhook-id": ID,
        "webhook-signature": sign(body, ID, ts),
        "webhook-timestamp": ts,
      }),
    )
    expect(res.status).toBe(204)
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "email.delivered" }),
    )
  })
})
