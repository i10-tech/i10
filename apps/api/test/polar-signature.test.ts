import { createHmac } from "node:crypto"
import { describe, expect, it } from "vitest"
import { verifyPolarWebhook } from "../src/billing/signature.js"

/**
 * ⚠ THE TWO KEY DERIVATIONS ARE THE POINT OF THIS FILE. Polar signs with the
 * UTF-8 bytes of the whole secret, `whsec_` included; the Standard Webhooks
 * specification says the key is the base64 decode of the part after the prefix.
 * A verifier that implements only the specification rejects every webhook Polar
 * sends today, and one that implements only Polar's breaks on the day they
 * switch. Both vectors are pinned here so neither change is silent.
 */

const SECRET = "whsec_c2VjcmV0LWJ5dGVzLWZvci10ZXN0aW5n"
const BODY = JSON.stringify({ type: "subscription.active", data: { id: "sub_1" } })
const ID = "msg_2KWPBgLlAfxdpx2AI54pPJ85f4W"

const now = new Date("2026-09-03T12:00:00.000Z")
const TS = String(Math.floor(now.getTime() / 1000))

const sign = (key: Buffer, timestamp = TS, id = ID) =>
  `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${BODY}`).digest("base64")}`

const polarKey = Buffer.from(SECRET, "utf8")
const specKey = Buffer.from(SECRET.slice("whsec_".length), "base64")

describe("verifyPolarWebhook", () => {
  it("accepts Polar's own key derivation — the whole secret as UTF-8 bytes", () => {
    const result = verifyPolarWebhook(
      BODY,
      { id: ID, timestamp: TS, signature: sign(polarKey) },
      SECRET,
      now,
    )
    expect(result).toEqual({ ok: true, id: ID })
  })

  // The migration Polar has said is coming. It must not be an outage.
  it("also accepts the Standard Webhooks key — base64 after the prefix", () => {
    const result = verifyPolarWebhook(
      BODY,
      { id: ID, timestamp: TS, signature: sign(specKey) },
      SECRET,
      now,
    )
    expect(result).toEqual({ ok: true, id: ID })
  })

  it("accepts one good signature among several, for secret rotation", () => {
    const signature = `${sign(Buffer.from("whsec_old", "utf8"))} ${sign(polarKey)}`
    const result = verifyPolarWebhook(
      BODY,
      { id: ID, timestamp: TS, signature },
      SECRET,
      now,
    )
    expect(result.ok).toBe(true)
  })

  it("rejects a signature made with a different secret", () => {
    const result = verifyPolarWebhook(
      BODY,
      { id: ID, timestamp: TS, signature: sign(Buffer.from("whsec_wrong", "utf8")) },
      SECRET,
      now,
    )
    expect(result).toEqual({ ok: false, reason: "mismatch" })
  })

  // ⚠ THE ID AND THE TIMESTAMP ARE SIGNED MATERIAL. If they were not, whoever
  // relays the request could edit either — which is what makes the replay
  // window below enforceable at all.
  it("rejects a body, id or timestamp that was changed after signing", () => {
    const signature = sign(polarKey)
    expect(
      verifyPolarWebhook(`${BODY} `, { id: ID, timestamp: TS, signature }, SECRET, now)
        .ok,
    ).toBe(false)
    expect(
      verifyPolarWebhook(
        BODY,
        { id: "msg_other", timestamp: TS, signature },
        SECRET,
        now,
      ).ok,
    ).toBe(false)
  })

  it("rejects a stale delivery", () => {
    const old = String(Number(TS) - 3600)
    const result = verifyPolarWebhook(
      BODY,
      { id: ID, timestamp: old, signature: sign(polarKey, old) },
      SECRET,
      now,
    )
    expect(result).toEqual({ ok: false, reason: "stale" })
  })

  // ⚠ BOTH DIRECTIONS. Refusing only old timestamps lets a forger pick a future
  // one and mint something that stays valid for as long as they chose.
  it("rejects a timestamp from the future", () => {
    const ahead = String(Number(TS) + 3600)
    const result = verifyPolarWebhook(
      BODY,
      { id: ID, timestamp: ahead, signature: sign(polarKey, ahead) },
      SECRET,
      now,
    )
    expect(result).toEqual({ ok: false, reason: "stale" })
  })

  it("rejects a request with no signature headers at all", () => {
    expect(verifyPolarWebhook(BODY, {}, SECRET, now)).toEqual({
      ok: false,
      reason: "missing_headers",
    })
  })

  it("rejects a non-numeric timestamp rather than treating it as zero", () => {
    const result = verifyPolarWebhook(
      BODY,
      { id: ID, timestamp: "yesterday", signature: sign(polarKey) },
      SECRET,
      now,
    )
    expect(result).toEqual({ ok: false, reason: "bad_timestamp" })
  })

  it("ignores signature entries of an unknown version", () => {
    const signature = `v2,${"A".repeat(44)}`
    expect(
      verifyPolarWebhook(BODY, { id: ID, timestamp: TS, signature }, SECRET, now),
    ).toEqual({ ok: false, reason: "mismatch" })
  })
})
