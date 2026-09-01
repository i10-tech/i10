import { createHmac } from "node:crypto"
import { describe, expect, it } from "vitest"
import { readSvixHeaders, verifySvixSignature } from "../src/webhooks/svix.js"

const SECRET =
  "whsec_" + Buffer.from("a-32-byte-test-signing-key-here!").toString("base64")
const NOW = new Date("2026-09-01T12:00:00Z")

function sign(body: string, id: string, timestamp: string, secret = SECRET) {
  const key = Buffer.from(secret.slice("whsec_".length), "base64")
  const mac = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64")
  return `v1,${mac}`
}

const body = JSON.stringify({ type: "user.created", data: { id: "user_1" } })
const id = "msg_abc"
const ts = String(Math.floor(NOW.getTime() / 1000))

function headers(over: Partial<Record<"id" | "timestamp" | "signature", string>> = {}) {
  return {
    id: over.id ?? id,
    timestamp: over.timestamp ?? ts,
    signature: over.signature ?? sign(body, id, ts),
  }
}

describe("svix signature verification", () => {
  it("accepts a correctly signed payload", () => {
    expect(verifySvixSignature(body, headers(), SECRET, NOW)).toEqual({ ok: true })
  })

  it("rejects a tampered body", () => {
    const tampered = JSON.stringify({
      type: "user.created",
      data: { id: "user_ATTACKER" },
    })
    expect(verifySvixSignature(tampered, headers(), SECRET, NOW).ok).toBe(false)
  })

  it("rejects a signature made with a different secret", () => {
    const other =
      "whsec_" + Buffer.from("a-different-32-byte-signing-key!!").toString("base64")
    const res = verifySvixSignature(
      body,
      headers({ signature: sign(body, id, ts, other) }),
      SECRET,
      NOW,
    )
    expect(res).toEqual({ ok: false, reason: "no matching signature" })
  })

  it("rejects a replayed request outside the tolerance window", () => {
    // A captured `user.deleted` would otherwise stay valid forever.
    const old = String(Math.floor(NOW.getTime() / 1000) - 6 * 60)
    const res = verifySvixSignature(
      body,
      headers({ timestamp: old, signature: sign(body, id, old) }),
      SECRET,
      NOW,
    )
    expect(res).toEqual({ ok: false, reason: "timestamp outside tolerance" })
  })

  it("rejects a timestamp too far in the future", () => {
    const future = String(Math.floor(NOW.getTime() / 1000) + 6 * 60)
    const res = verifySvixSignature(
      body,
      headers({ timestamp: future, signature: sign(body, id, future) }),
      SECRET,
      NOW,
    )
    expect(res.ok).toBe(false)
  })

  it("accepts a timestamp inside the tolerance window", () => {
    const recent = String(Math.floor(NOW.getTime() / 1000) - 4 * 60)
    const res = verifySvixSignature(
      body,
      headers({ timestamp: recent, signature: sign(body, id, recent) }),
      SECRET,
      NOW,
    )
    expect(res).toEqual({ ok: true })
  })

  it("binds the signature to the message id", () => {
    // Signature valid for msg_abc must not verify when replayed under another id.
    const res = verifySvixSignature(body, headers({ id: "msg_other" }), SECRET, NOW)
    expect(res.ok).toBe(false)
  })

  it("accepts one valid signature among several, for secret rotation", () => {
    const other =
      "whsec_" + Buffer.from("a-different-32-byte-signing-key!!").toString("base64")
    const both = `${sign(body, id, ts, other)} ${sign(body, id, ts)}`
    expect(
      verifySvixSignature(body, headers({ signature: both }), SECRET, NOW),
    ).toEqual({ ok: true })
  })

  it.each([
    ["missing headers", { id: undefined, timestamp: ts, signature: "x" }],
    ["malformed timestamp", { id, timestamp: "not-a-number", signature: "x" }],
    ["unknown version prefix", { id, timestamp: ts, signature: "v2,abcd" }],
    ["no comma", { id, timestamp: ts, signature: "garbage" }],
    ["empty signature", { id, timestamp: ts, signature: "" }],
  ])("rejects %s", (_name, h) => {
    expect(verifySvixSignature(body, h as never, SECRET, NOW).ok).toBe(false)
  })

  it("rejects a signature of the right shape but wrong length", () => {
    const short = `v1,${Buffer.from("short").toString("base64")}`
    expect(
      verifySvixSignature(body, headers({ signature: short }), SECRET, NOW).ok,
    ).toBe(false)
  })

  it("rejects a malformed signing secret rather than throwing", () => {
    expect(verifySvixSignature(body, headers(), "whsec_", NOW)).toEqual({
      ok: false,
      reason: "malformed signing secret",
    })
  })
})

describe("readSvixHeaders", () => {
  it("reads Clerk's svix- names", () => {
    const map: Record<string, string> = {
      "svix-id": "a",
      "svix-timestamp": "b",
      "svix-signature": "c",
    }
    expect(readSvixHeaders((n) => map[n])).toEqual({
      id: "a",
      timestamp: "b",
      signature: "c",
    })
  })

  it("falls back to the Standard Webhooks names", () => {
    const map: Record<string, string> = {
      "webhook-id": "a",
      "webhook-timestamp": "b",
      "webhook-signature": "c",
    }
    expect(readSvixHeaders((n) => map[n])).toEqual({
      id: "a",
      timestamp: "b",
      signature: "c",
    })
  })
})
