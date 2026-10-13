import { describe, expect, it } from "bun:test"
import { senderName } from "../src/routes/console/account.js"

// The onboarding welcome email goes from the customer's domain under the
// workspace's name (2026-10-14), so the name has to be safe in a `From` header.
describe("senderName", () => {
  it("uses the workspace's name", () => {
    expect(senderName("PSL")).toBe("PSL")
  })

  it("falls back to i10 when there is no name left", () => {
    expect(senderName(null)).toBe("i10")
    expect(senderName("  <>  ")).toBe("i10")
  })

  it("drops what would break the header or read as an address", () => {
    expect(senderName('Acme <x@evil.test>, "Ltd"\r\nBcc: y')).toBe(
      "Acme xevil.test Ltd Bcc y",
    )
  })
})
