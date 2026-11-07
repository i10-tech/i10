import { describe, expect, it } from "bun:test"
import { ssoFailure } from "../src/identity/failure.js"
import { readCallbackQuery } from "../src/identity/oidc.js"

describe("sanitized SSO failure catalog", () => {
  it("maps SAML verifier failures without retaining provider prose", () => {
    const failure = ssoFailure({
      protocol: "saml",
      provider: "entra",
      reason: "invalid_response",
      extra: {
        failure: "audience",
        StatusMessage: "secret user data",
      },
    })
    expect(failure?.code).toBe("audience")
    expect(failure?.adminNextStep).toContain("entity ID")
    expect(JSON.stringify(failure)).not.toContain("secret user data")
  })

  it("extracts an AADSTS code but never the error description", () => {
    expect(
      readCallbackQuery({
        error_description: "AADSTS50011: personal tenant and user@example.com",
      }),
    ).toEqual({ code: null, iss: null, error: null, aadsts: "AADSTS50011" })
    const failure = ssoFailure({
      protocol: "oidc",
      provider: "entra",
      reason: "idp_error",
      extra: {
        aadsts: "AADSTS50011",
        error_description: "contains a tenant and user address",
      },
    })
    expect(failure?.code).toBe("AADSTS50011")
    expect(failure?.adminNextStep).toContain("redirect URI")
    expect(JSON.stringify(failure)).not.toContain("tenant")
  })

  it("does not offer retry for configuration failures", () => {
    const failure = ssoFailure({
      protocol: "oidc",
      provider: "okta",
      reason: "idp_error",
      extra: { error: "unauthorized_client" },
    })
    expect(failure?.retry).toBe(false)
  })
})
