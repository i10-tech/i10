import { describe, expect, it } from "bun:test"
import { defaultConnectionName, idpChoices, protocolOptions } from "./sso-setup-choices"

describe("sso setup choices", () => {
  it("merges providers and only renames the generic dual-protocol choice", () => {
    expect(
      idpChoices({
        oidc: [
          {
            id: "okta",
            label: "Okta",
            issuerHint: "",
            requires: [],
            clientAuthMethods: [],
          },
          {
            id: "generic",
            label: "Other OpenID Connect provider",
            issuerHint: "",
            requires: [],
            clientAuthMethods: [],
          },
        ],
        saml: [
          { id: "okta", label: "Okta", entityIdHint: "", requires: [] },
          {
            id: "generic",
            label: "Other SAML 2.0 identity provider",
            entityIdHint: "",
            requires: [],
          },
        ],
      }),
    ).toEqual([
      { idp: "okta", label: "Okta", protocols: ["oidc", "saml"] },
      { idp: "generic", label: "Another provider", protocols: ["oidc", "saml"] },
    ])
  })

  it("describes protocols and builds the default names", () => {
    expect(protocolOptions(["saml"]).map((option) => option.value)).toEqual(["saml"])
    expect(protocolOptions(["oidc", "saml"]).map((option) => option.value)).toEqual([
      "oidc",
      "saml",
    ])
    expect(defaultConnectionName("Okta", "oidc")).toBe("Okta (OIDC)")
    expect(defaultConnectionName("Okta", "saml")).toBe("Okta (SAML)")
  })
})
