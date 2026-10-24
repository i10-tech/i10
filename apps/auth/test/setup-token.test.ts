import { describe, expect, it } from "bun:test"
import { tokenFromLocation } from "../app/sso/setup/token"

const TOKEN = `i10_setup_${"A".repeat(43)}`

describe("a setup link's token", () => {
  it("is read from the path", () => {
    expect(tokenFromLocation(`/sso/setup/${TOKEN}`, "")).toBe(TOKEN)
    expect(tokenFromLocation(`/sso/setup/${TOKEN}/`, "")).toBe(TOKEN)
  })

  it("is read from a fragment", () => {
    expect(tokenFromLocation("/sso/setup", `#token=${TOKEN}`)).toBe(TOKEN)
  })

  it("is refused when it is not the shape we issue", () => {
    expect(tokenFromLocation("/sso/setup/nope", "")).toBeNull()
    expect(tokenFromLocation(`/sso/setup/${TOKEN}x`, "")).toBeNull()
    expect(tokenFromLocation("/sso/setup", "#token=short")).toBeNull()
    expect(tokenFromLocation("/sso/setup", "")).toBeNull()
  })

  it("is not taken from anywhere else on the site", () => {
    expect(tokenFromLocation(`/other/${TOKEN}`, "")).toBeNull()
    expect(tokenFromLocation(`/sso/setup/a/${TOKEN}`, "")).toBeNull()
  })
})
