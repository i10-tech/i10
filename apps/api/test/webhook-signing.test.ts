import { createHmac } from "node:crypto"
import { describe, expect, it } from "bun:test"
import {
  decodeSecret,
  generateSecret,
  secretBox,
  signPayload,
  SIGNATURE_TOLERANCE_SECONDS,
  timestampFor,
  verifySignature,
} from "../src/webhooks/signing.js"

/**
 * The signature is the only thing between a customer's endpoint and anyone who
 * learns its URL, so what these assert is mostly what must NOT verify.
 */

const SECRET = "whsec_MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3"
const ID = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6071"
const BODY = JSON.stringify({ id: "wh_1", type: "email.bounced" })
const AT = new Date("2026-09-03T10:00:00Z")

describe("signing", () => {
  it("round-trips", () => {
    const signature = signPayload(SECRET, ID, BODY, AT)
    expect(verifySignature(SECRET, ID, BODY, signature, timestampFor(AT), AT)).toBe(
      true,
    )
  })

  it("is deterministic for the same second", () => {
    expect(signPayload(SECRET, ID, BODY, AT)).toBe(signPayload(SECRET, ID, BODY, AT))
  })

  it("is a v1-tagged base64 digest, as the spec defines", () => {
    expect(signPayload(SECRET, ID, BODY, AT)).toMatch(/^v1,[A-Za-z0-9+/]{43}=$/)
  })

  /**
   * ⚠ THE CROSS-PACKAGE CONTRACT, PINNED FROM BOTH SIDES. `@i10/next` ships its
   * own verifier, so the sender and the SDK are two implementations of one wire
   * format with nothing but this vector holding them together. The identical
   * constants are asserted in `packages/next/test/webhook.test.ts`; change one
   * without the other and a test fails here instead of every customer's
   * endpoint answering 401 in production.
   *
   * ⚠ AND IT IS NOW A CONTRACT WITH EVERY CONFORMING LIBRARY, NOT JUST OURS.
   * This vector is plain Standard Webhooks: HMAC-SHA256 over `id.timestamp.body`
   * keyed by the base64-decoded secret. If it ever needs changing to make our
   * own code pass, our own code is what is wrong.
   */
  it("matches the vector the SDK's test pins", () => {
    const at = new Date(1_788_386_400 * 1000)
    expect(timestampFor(at)).toBe("1788386400")
    expect(signPayload(SECRET, ID, BODY, at)).toBe(
      "v1,NhXfnNyuSgYe2dybGCQwOtgM8b4e9S3JueYvYYXSIpI=",
    )
  })

  /**
   * ⚠ THE MISTAKE THAT LOOKS CORRECT FROM INSIDE THIS REPOSITORY. Keying the
   * HMAC with the printable `whsec_…` string instead of its decoded bytes
   * round-trips perfectly against our own verifier and fails against every
   * off-the-shelf library — which is the one thing the move to this format was
   * for. Nothing else in the suite would catch it.
   */
  it("keys the HMAC with the decoded secret, not the printable string", () => {
    const wrong = createHmac("sha256", SECRET)
      .update(`${ID}.${timestampFor(AT)}.${BODY}`)
      .digest("base64")
    expect(signPayload(SECRET, ID, BODY, AT)).not.toBe(`v1,${wrong}`)
  })

  /**
   * ⚠ WHAT THE LIST FORM IS FOR. During a rotation both secrets sign the same
   * delivery and the receiver takes either. A verifier that read only the first
   * entry would drop every delivery signed by the outgoing key.
   */
  it("accepts a match anywhere in the list, which is what rotation needs", () => {
    const mine = signPayload(SECRET, ID, BODY, AT)
    const stale = "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    const ts = timestampFor(AT)
    expect(verifySignature(SECRET, ID, BODY, `${stale} ${mine}`, ts, AT)).toBe(true)
    expect(verifySignature(SECRET, ID, BODY, `${mine} ${stale}`, ts, AT)).toBe(true)
  })

  it("skips entries whose version it does not implement", () => {
    const mine = signPayload(SECRET, ID, BODY, AT)
    const future = "v9,Ynl0ZXM="
    expect(
      verifySignature(SECRET, ID, BODY, `${future} ${mine}`, timestampFor(AT), AT),
    ).toBe(true)
  })

  it("refuses a body that changed", () => {
    const signature = signPayload(SECRET, ID, BODY, AT)
    expect(
      verifySignature(SECRET, ID, `${BODY} `, signature, timestampFor(AT), AT),
    ).toBe(false)
  })

  /**
   * ⚠ THE REASON THE ID MOVED INSIDE THE SIGNATURE. Under the old scheme the
   * delivery id travelled beside the signature and could be rewritten freely,
   * so a receiver deduplicating on it would count one replayed delivery as
   * many distinct events.
   */
  it("refuses an id that changed", () => {
    const signature = signPayload(SECRET, ID, BODY, AT)
    expect(
      verifySignature(SECRET, "wh_other", BODY, signature, timestampFor(AT), AT),
    ).toBe(false)
  })

  it("refuses another secret", () => {
    const signature = signPayload(SECRET, ID, BODY, AT)
    const other = `whsec_${Buffer.from("another-key-entirely!!!!!").toString("base64")}`
    expect(verifySignature(other, ID, BODY, signature, timestampFor(AT), AT)).toBe(
      false,
    )
  })

  // ⚠ THE WHOLE REASON THE TIMESTAMP IS SIGNED. Without it, anyone who captures
  // one delivery can replay it forever and every replay verifies.
  it("refuses a signature that is too old", () => {
    const signature = signPayload(SECRET, ID, BODY, AT)
    const later = new Date(AT.getTime() + (SIGNATURE_TOLERANCE_SECONDS + 1) * 1000)
    expect(verifySignature(SECRET, ID, BODY, signature, timestampFor(AT), later)).toBe(
      false,
    )
  })

  // ⚠ BOTH DIRECTIONS. Refusing only old timestamps lets a forger with a future
  // clock mint a signature valid for as long as they chose.
  it("refuses a signature from the future", () => {
    const ahead = new Date(AT.getTime() + (SIGNATURE_TOLERANCE_SECONDS + 60) * 1000)
    const signature = signPayload(SECRET, ID, BODY, ahead)
    expect(verifySignature(SECRET, ID, BODY, signature, timestampFor(ahead), AT)).toBe(
      false,
    )
  })

  it("refuses a timestamp it cannot parse", () => {
    const signature = signPayload(SECRET, ID, BODY, AT)
    for (const timestamp of ["", "nonsense", "NaN"]) {
      expect(verifySignature(SECRET, ID, BODY, signature, timestamp, AT)).toBe(false)
    }
  })

  // A length mismatch must not throw out of `timingSafeEqual` — a malformed
  // header from anywhere would otherwise crash a delivery worker.
  it("refuses a truncated signature without throwing", () => {
    const ts = timestampFor(AT)
    for (const bad of ["v1,ab", "ab", "", "v1,", ","]) {
      expect(() => verifySignature(SECRET, ID, BODY, bad, ts, AT)).not.toThrow()
      expect(verifySignature(SECRET, ID, BODY, bad, ts, AT)).toBe(false)
    }
  })
})

describe("the generated secret", () => {
  // ⚠ Greppable by a secret scanner and obvious to a human in a paste; 32
  // anonymous base64 characters are neither.
  it("is prefixed", () => {
    expect(generateSecret().startsWith("whsec_")).toBe(true)
  })

  /**
   * ⚠ THE PAYLOAD IS BASE64 AND MUST DECODE INTO THE SPEC'S 24–64 BYTE RANGE.
   * A hex secret — what this generated until 2026-09-04 — is still valid base64
   * on its face, so nothing throws; it simply decodes to different bytes than
   * the customer's library will use, and every delivery 401s.
   */
  it("decodes to the byte length the spec requires", () => {
    const decoded = decodeSecret(generateSecret())
    expect(decoded.length).toBe(24)
    expect(decoded.length).toBeGreaterThanOrEqual(24)
    expect(decoded.length).toBeLessThanOrEqual(64)
  })

  it("does not repeat", () => {
    const many = new Set(Array.from({ length: 100 }, generateSecret))
    expect(many.size).toBe(100)
  })
})

describe("the secret at rest", () => {
  const key = "a".repeat(64)
  const box = secretBox(key)

  it("round-trips", () => {
    const secret = generateSecret()
    expect(box.open(box.seal(secret))).toBe(secret)
  })

  // ⚠ A DATABASE DUMP MUST NOT CARRY THE SECRET. If the ciphertext contained
  // it, the whole point of encrypting at rest would be gone.
  it("does not leak the plaintext into the ciphertext", () => {
    const secret = generateSecret()
    expect(box.seal(secret)).not.toContain(secret.slice(6))
  })

  it("is not deterministic, so two identical secrets do not look identical", () => {
    expect(box.seal("same")).not.toBe(box.seal("same"))
  })

  // ⚠ AUTHENTICATED, WHICH IS WHY GCM RATHER THAN CBC. A row edited by anyone
  // with write access would otherwise decrypt to a different secret, and the
  // only symptom would be every signature failing at the customer's end.
  it("refuses a tampered ciphertext", () => {
    const sealed = box.seal("original")
    const [v, iv, tag, ct] = sealed.split(".")
    const flipped = `${v}.${iv}.${tag}.${ct!.slice(0, -2)}AA`
    expect(() => box.open(flipped)).toThrow()
  })

  it("refuses another key's ciphertext", () => {
    const other = secretBox("b".repeat(64))
    expect(() => other.open(box.seal("secret"))).toThrow()
  })

  it("refuses a key of the wrong size rather than padding it", () => {
    expect(() => secretBox("tooshort")).toThrow(/32 bytes/)
  })

  it("accepts base64 as well as hex", () => {
    const b64 = Buffer.alloc(32, 7).toString("base64")
    expect(() => secretBox(b64)).not.toThrow()
  })
})
