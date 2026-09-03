import { describe, expect, it } from "vitest"
import {
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

const SECRET = "whsec_0123456789abcdef0123456789abcdef"
const BODY = JSON.stringify({ id: "wh_1", type: "email.bounced" })
const AT = new Date("2026-09-03T10:00:00Z")

describe("signing", () => {
  it("round-trips", () => {
    const signature = signPayload(SECRET, BODY, AT)
    expect(verifySignature(SECRET, BODY, signature, timestampFor(AT), AT)).toBe(true)
  })

  it("is deterministic for the same second", () => {
    expect(signPayload(SECRET, BODY, AT)).toBe(signPayload(SECRET, BODY, AT))
  })

  it("is a bare hex digest, which is what the SDK parses", () => {
    expect(signPayload(SECRET, BODY, AT)).toMatch(/^[0-9a-f]{64}$/)
  })

  /**
   * ⚠ THE CROSS-PACKAGE CONTRACT, PINNED FROM BOTH SIDES. `@i10/next` ships its
   * own verifier, so the sender and the SDK are two implementations of one wire
   * format with nothing but this vector holding them together. The identical
   * constants are asserted in `packages/next/test/webhook.test.ts`; change one
   * without the other and a test fails here instead of every customer's
   * endpoint answering 401 in production.
   */
  it("matches the vector the SDK's test pins", () => {
    const at = new Date(1_788_386_400 * 1000)
    expect(timestampFor(at)).toBe("1788386400")
    expect(signPayload(SECRET, BODY, at)).toBe(
      "f2a6c9f650763a68c624af56852529eae40a53ed3da3b41efbf62edd6f650d5f",
    )
  })

  it("refuses a body that changed", () => {
    const signature = signPayload(SECRET, BODY, AT)
    expect(verifySignature(SECRET, `${BODY} `, signature, timestampFor(AT), AT)).toBe(
      false,
    )
  })

  it("refuses another secret", () => {
    const signature = signPayload(SECRET, BODY, AT)
    expect(verifySignature("whsec_other", BODY, signature, timestampFor(AT), AT)).toBe(
      false,
    )
  })

  // ⚠ THE WHOLE REASON THE TIMESTAMP IS SIGNED. Without it, anyone who captures
  // one delivery can replay it forever and every replay verifies.
  it("refuses a signature that is too old", () => {
    const signature = signPayload(SECRET, BODY, AT)
    const later = new Date(AT.getTime() + (SIGNATURE_TOLERANCE_SECONDS + 1) * 1000)
    expect(verifySignature(SECRET, BODY, signature, timestampFor(AT), later)).toBe(
      false,
    )
  })

  // ⚠ BOTH DIRECTIONS. Refusing only old timestamps lets a forger with a future
  // clock mint a signature valid for as long as they chose.
  it("refuses a signature from the future", () => {
    const ahead = new Date(AT.getTime() + (SIGNATURE_TOLERANCE_SECONDS + 60) * 1000)
    const signature = signPayload(SECRET, BODY, ahead)
    expect(verifySignature(SECRET, BODY, signature, timestampFor(ahead), AT)).toBe(
      false,
    )
  })

  it("refuses a timestamp it cannot parse", () => {
    const signature = signPayload(SECRET, BODY, AT)
    for (const timestamp of ["", "nonsense", "NaN"]) {
      expect(verifySignature(SECRET, BODY, signature, timestamp, AT)).toBe(false)
    }
  })

  // A length mismatch must not throw out of `timingSafeEqual` — a malformed
  // header from anywhere would otherwise crash a delivery worker.
  it("refuses a truncated signature without throwing", () => {
    expect(() =>
      verifySignature(SECRET, BODY, "ab", timestampFor(AT), AT),
    ).not.toThrow()
    expect(verifySignature(SECRET, BODY, "ab", timestampFor(AT), AT)).toBe(false)
  })
})

describe("the generated secret", () => {
  // ⚠ Greppable by a secret scanner and obvious to a human in a paste; 48
  // anonymous hex characters are neither.
  it("is prefixed and long", () => {
    const secret = generateSecret()
    expect(secret.startsWith("whsec_")).toBe(true)
    expect(secret.length).toBeGreaterThan(40)
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
