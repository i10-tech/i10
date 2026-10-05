import { describe, expect, it, mock } from "bun:test"
import { deliverWebhook } from "../src/webhooks/deliver.js"
import { checkCustomHeaders, RESERVED_HEADERS } from "../src/webhooks/headers.js"
import {
  generateKey,
  MAX_GRACE_SECONDS,
  planRotation,
  publicKeyFor,
  signWithKeys,
  verifyEd25519,
  type RetiringSecret,
} from "../src/webhooks/keys.js"
import { verifySignature } from "../src/webhooks/signing.js"

const at = new Date(1614265330 * 1000)

describe("signing keys", () => {
  // ⚠ PINNED TO SVIX'S OWN VECTOR (server/svix-server/src/worker.rs,
  // `test_asymmetric_key_signing`). Ed25519 is deterministic, so a byte-equal
  // signature proves our `v1a` matches another conforming implementation
  // rather than only agreeing with itself.
  it("produces Svix's published ed25519 signature for the same input", () => {
    const keypair = Buffer.from(
      "6Xb/dCcHpPea21PS1N9VY/NZW723CEc77N4rJCubMbfVKIDij2HKpMKkioLlX0dRqSKJp4AJ6p9lMicMFs6Kvg==",
      "base64",
    )
    const secret = `whsk_${keypair.subarray(0, 32).toString("base64")}`
    const header = signWithKeys(
      [{ scheme: "ed25519", secret }],
      "msg_p5jXN8AQM9LWM0D4loKWxJek",
      '{"test": 2432232314}',
      at,
    )
    expect(header).toBe(
      "v1a,hnO3f9T8Ytu9HwrXslvumlUpqtNVqkhqw/enGzPCXe5BdqzCInXqYXFymVJaA7AZdpXwVLPo3mNl8EM+m7TBAg==",
    )
    expect(publicKeyFor(secret)).toBe(`whpk_${keypair.subarray(32).toString("base64")}`)
  })

  it("signs and verifies a fresh ed25519 key with its public key only", () => {
    const key = generateKey("ed25519")
    expect(key.secret.startsWith("whsk_")).toBe(true)
    expect(key.publicKey!.startsWith("whpk_")).toBe(true)
    const header = signWithKeys([key], "msg_1", "{}", at)
    expect(verifyEd25519(key.publicKey!, "msg_1", "1614265330", "{}", header)).toBe(
      true,
    )
    expect(
      verifyEd25519(key.publicKey!, "msg_1", "1614265330", '{"x":1}', header),
    ).toBe(false)
    expect(
      verifyEd25519(
        generateKey("ed25519").publicKey!,
        "msg_1",
        "1614265330",
        "{}",
        header,
      ),
    ).toBe(false)
  })

  it("puts one signature per live key in the header, current first", () => {
    const current = generateKey("hmac_sha256")
    const old = generateKey("hmac_sha256")
    const asym = generateKey("ed25519")
    const header = signWithKeys([current, old, asym], "msg_1", "{}", at)
    const parts = header.split(" ")
    expect(parts).toHaveLength(3)
    expect(parts[0]!.startsWith("v1,")).toBe(true)
    expect(parts[2]!.startsWith("v1a,")).toBe(true)
    // A receiver holding either HMAC secret verifies.
    for (const k of [current, old]) {
      expect(verifySignature(k.secret, "msg_1", "{}", header, "1614265330", at)).toBe(
        true,
      )
    }
    expect(verifyEd25519(asym.publicKey!, "msg_1", "1614265330", "{}", header)).toBe(
      true,
    )
  })

  it("refuses to sign with no key at all", () => {
    expect(() => signWithKeys([], "msg_1", "{}", at)).toThrow()
  })
})

describe("rotation", () => {
  const now = new Date("2026-10-05T12:00:00Z")
  const current = { ciphertext: "sealed-current", scheme: "hmac_sha256" as const }
  const retiring = (hours: number): RetiringSecret => ({
    ciphertext: `sealed-${hours}`,
    scheme: "hmac_sha256",
    expiresAt: new Date(now.getTime() + hours * 3600_000).toISOString(),
  })

  it("revoke: the replaced key stops now, earlier choices keep their expiry", () => {
    const plan = planRotation(current, [retiring(5)], { action: "revoke" }, now)
    expect(plan).toEqual({ ok: true, retiring: [retiring(5)] })
  })

  it("expire: the replaced key signs until the chosen time", () => {
    const plan = planRotation(
      current,
      [],
      { action: "expire", expiresInSeconds: 3600 },
      now,
    )
    expect(plan).toEqual({
      ok: true,
      retiring: [{ ...current, expiresAt: "2026-10-05T13:00:00.000Z" }],
    })
  })

  it.each([59, MAX_GRACE_SECONDS + 1, 1.5, 0, -60])(
    "refuses a grace period of %p seconds",
    (s) => {
      expect(
        planRotation(current, [], { action: "expire", expiresInSeconds: s }, now).ok,
      ).toBe(false)
    },
  )

  it("accepts exactly 72 hours", () => {
    expect(
      planRotation(
        current,
        [],
        { action: "expire", expiresInSeconds: MAX_GRACE_SECONDS },
        now,
      ).ok,
    ).toBe(true)
  })

  it("caps live keys at three and says when room opens", () => {
    const plan = planRotation(
      current,
      [retiring(2), retiring(9)],
      { action: "expire", expiresInSeconds: 60 },
      now,
    )
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.reason).toContain(retiring(2).expiresAt)
    // Revoking is always possible, whatever is live.
    expect(
      planRotation(current, [retiring(2), retiring(9)], { action: "revoke" }, now).ok,
    ).toBe(true)
  })

  it("drops expired keys rather than carrying them forward", () => {
    const plan = planRotation(current, [retiring(-1)], { action: "revoke" }, now)
    expect(plan).toEqual({ ok: true, retiring: [] })
  })
})

describe("delivery during a grace period", () => {
  it("sends a header that both the old and new secret verify", async () => {
    const fresh = generateKey("hmac_sha256")
    const old = generateKey("hmac_sha256")
    const doFetch = mock(async () => new Response("", { status: 200 }))
    await deliverWebhook(
      { deliveryId: "d", endpointId: "e", tenantId: "t" },
      {
        load: async () => ({
          id: "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f60aa",
          tenantId: "t",
          endpointId: "e",
          url: "https://hooks.example.com/i10",
          keys: [fresh, old],
          eventType: "email.sent",
          occurredAt: new Date(),
          payload: {},
          attempts: 0,
        }),
        markDelivered: mock(async () => {}),
        markFailed: mock(async () => {}),
        fetch: doFetch as unknown as typeof fetch,
        vet: async () => ({
          ok: true as const,
          address: "93.184.215.14",
          family: 4 as const,
        }),
        log: { info: mock(), warn: mock(), error: mock() },
        maxAttempts: 5,
      },
    )
    const init = (doFetch.mock.calls[0] as unknown as [string, RequestInit])[1]
    const h = init.headers as Record<string, string>
    for (const k of [fresh, old]) {
      expect(
        verifySignature(
          k.secret,
          h["webhook-id"]!,
          String(init.body),
          h["webhook-signature"]!,
          h["webhook-timestamp"]!,
        ),
      ).toBe(true)
    }
  })
})

describe("custom headers", () => {
  it.each([
    ...RESERVED_HEADERS,
    "Webhook-Signature",
    "webhook-anything",
    "svix-whatever",
  ])("refuses to let a customer set %s", (name) => {
    expect(checkCustomHeaders({ [name]: "x" }).ok).toBe(false)
  })

  it("accepts ordinary headers and lowercases their names", () => {
    expect(
      checkCustomHeaders({ "X-Tenant": "abc", Authorization: "Bearer t" }),
    ).toEqual({
      ok: true,
      headers: { "x-tenant": "abc", authorization: "Bearer t" },
    })
  })

  it.each([
    [{ "x-a": "one\r\nx-b: two" }, "a line break"],
    [{ "bad name": "x" }, "an invalid name"],
    [{ "x-a": 1 }, "a non-string value"],
    [{ "x-a": "a", "X-A": "b" }, "the same name twice"],
    [{ "x-a": "x".repeat(1025) }, "a value too long"],
    [
      Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`x-${i}`, "v"])),
      "too many",
    ],
  ])("refuses %j (%s)", (input) => {
    expect(checkCustomHeaders(input as Record<string, unknown>).ok).toBe(false)
  })
})
