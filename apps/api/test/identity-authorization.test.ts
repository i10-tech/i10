import { describe, expect, test } from "bun:test"
import { connectionWriteNeedsFreshAuth } from "../src/identity/authorization.js"
import {
  defaultMaxSessionSeconds,
  specificRefusalMessage,
} from "../src/identity/model.js"

const connection = (status: "draft" | "testing" | "active" | "disabled") => ({
  status,
  enforcement: "off" as const,
})

describe("connection write authorization", () => {
  test("allows setup writes on draft and testing", () => {
    expect(connectionWriteNeedsFreshAuth(connection("draft"))).toBe(false)
    expect(connectionWriteNeedsFreshAuth(connection("testing"))).toBe(false)
  })

  describe("settled Entra guidance and defaults", () => {
    test("gives Entra onmicrosoft sign-ins customer guidance without provider data", () => {
      expect(
        specificRefusalMessage("domain_not_verified", {
          provider: "entra",
          email: "person@tenant.onmicrosoft.com",
        }),
      ).toBe(
        "Your login is on a Microsoft onmicrosoft.com address, which cannot be used for SSO here. Ask your administrator to add your company's domain in Entra and move your login to it.",
      )
    })

    test("gives new Okta and Entra a seven-day default without changing other providers", () => {
      expect(defaultMaxSessionSeconds("okta")).toBe(7 * 24 * 60 * 60)
      expect(defaultMaxSessionSeconds("entra")).toBe(7 * 24 * 60 * 60)
      expect(defaultMaxSessionSeconds("google")).toBeNull()
    })
  })

  test("requires fresh auth for active and disabled", () => {
    expect(connectionWriteNeedsFreshAuth(connection("active"))).toBe(true)
    expect(connectionWriteNeedsFreshAuth(connection("disabled"))).toBe(true)
  })

  test("requires fresh auth for activation and required enforcement", () => {
    expect(
      connectionWriteNeedsFreshAuth(connection("draft"), { status: "active" }),
    ).toBe(true)
    expect(
      connectionWriteNeedsFreshAuth(connection("testing"), {
        enforcement: "required_all",
      }),
    ).toBe(true)
  })
})
