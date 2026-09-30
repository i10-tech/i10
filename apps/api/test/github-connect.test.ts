import { createHmac } from "node:crypto"
import { describe, expect, it } from "bun:test"
import { signState, verifyState, verifyWebhook } from "../src/github/connect.js"

/** The two checks that stand between GitHub and a workspace's templates (#235). */
describe("the install state", () => {
  const secret = "client-secret"
  const tenant = "11111111-1111-4111-8111-111111111111"

  it("names the workspace it was signed for", () => {
    expect(verifyState(signState(tenant, secret), secret)).toBe(tenant)
  })

  it("is refused once expired, tampered with, or signed with another secret", () => {
    const old = signState(tenant, secret, Date.now() - 31 * 60_000)
    expect(verifyState(old, secret)).toBeNull()

    const [payload, mac] = signState(tenant, secret).split(".")
    const forged = Buffer.from(
      JSON.stringify({
        t: "22222222-2222-4222-8222-222222222222",
        e: Date.now() + 60_000,
      }),
    ).toString("base64url")
    expect(verifyState(`${forged}.${mac}`, secret)).toBeNull()
    expect(verifyState(`${payload}.${mac}`, "another-secret")).toBeNull()
    expect(verifyState("garbage", secret)).toBeNull()
  })
})

describe("the webhook signature", () => {
  const body = '{"zen":"Keep it logically awesome."}'
  const sign = (s: string) =>
    `sha256=${createHmac("sha256", s).update(body).digest("hex")}`

  it("accepts exactly the raw body under the secret", () => {
    expect(verifyWebhook(body, sign("webhook-secret-123"), "webhook-secret-123")).toBe(
      true,
    )
    expect(
      verifyWebhook(`${body} `, sign("webhook-secret-123"), "webhook-secret-123"),
    ).toBe(false)
    expect(verifyWebhook(body, sign("other"), "webhook-secret-123")).toBe(false)
    expect(verifyWebhook(body, undefined, "webhook-secret-123")).toBe(false)
    expect(verifyWebhook(body, "sha1=abc", "webhook-secret-123")).toBe(false)
  })
})
