import { describe, expect, test } from "bun:test"
import { flowCovers } from "@/lib/sso-guides"
import {
  connectSummary,
  currentStep,
  emailDomain,
  isDomainName,
  isMicrosoftOwnedDomain,
  issuerFromInput,
  oidcIssuerCheck,
  recommendedProtocol,
  stepIsDone,
} from "@/lib/sso-setup-flow"

const live = [{ joinDomainId: "d", name: "acme.dev", live: true }]
const lapsed = [{ joinDomainId: "d", name: "acme.dev", live: false }]

describe("currentStep", () => {
  test("walks forward as each fact becomes true", () => {
    expect(currentStep({ connection: null, ready: false, passed: false })).toBe(
      "provider",
    )
    const draft = { status: "draft" as const, domains: [] }
    expect(currentStep({ connection: draft, ready: false, passed: false })).toBe(
      "domain",
    )
    const domained = { status: "draft" as const, domains: live }
    expect(currentStep({ connection: domained, ready: false, passed: false })).toBe(
      "connect",
    )
    const testing = { status: "testing" as const, domains: live }
    expect(currentStep({ connection: testing, ready: true, passed: false })).toBe(
      "test",
    )
    expect(currentStep({ connection: testing, ready: true, passed: true })).toBe("live")
    const active = { status: "active" as const, domains: live }
    expect(currentStep({ connection: active, ready: true, passed: true })).toBe("done")
  })

  test("a draft connection whose values are already ready stays on the connect step", () => {
    const googleDraft = { status: "draft" as const, domains: live }
    expect(currentStep({ connection: googleDraft, ready: true, passed: false })).toBe(
      "connect",
    )
  })

  test("a testing connection that is not ready returns to the connect step", () => {
    const unreadyTesting = { status: "testing" as const, domains: live }
    expect(
      currentStep({ connection: unreadyTesting, ready: false, passed: false }),
    ).toBe("connect")
  })

  test("a domain that lost its proof sends setup back to the domain step", () => {
    const connection = { status: "testing" as const, domains: lapsed }
    expect(currentStep({ connection, ready: true, passed: true })).toBe("domain")
  })
})

test("stepIsDone follows the order of the steps", () => {
  expect(stepIsDone("provider", "connect")).toBe(true)
  expect(stepIsDone("connect", "connect")).toBe(false)
  expect(stepIsDone("live", "done")).toBe(true)
})

test("recommendedProtocol prefers OpenID Connect and falls back to SAML", () => {
  expect(recommendedProtocol(["oidc", "saml"])).toBe("oidc")
  expect(recommendedProtocol(["saml"])).toBe("saml")
})

test("issuerFromInput accepts a bare org address or a pasted URL", () => {
  expect(issuerFromInput(" acme.okta.com/ ")).toBe("https://acme.okta.com")
  expect(issuerFromInput("https://acme.okta.com/oauth2/default")).toBe(
    "https://acme.okta.com/oauth2/default",
  )
  expect(issuerFromInput("  ")).toBe("")
})

test("issuerFromInput expands a bare Entra tenant ID", () => {
  const tenant = "00000000-1111-2222-3333-444455556666"
  expect(issuerFromInput(tenant)).toBe(
    `https://login.microsoftonline.com/${tenant}/v2.0`,
  )
})

test("emailDomain and isDomainName", () => {
  expect(emailDomain("Mo@Acme.Dev")).toBe("acme.dev")
  expect(emailDomain(null)).toBeNull()
  expect(isDomainName("acme.co.uk")).toBe(true)
  expect(isDomainName("https://acme.dev")).toBe(false)
  expect(isDomainName("localhost")).toBe(false)
})

test("isMicrosoftOwnedDomain detects onmicrosoft.com domains", () => {
  expect(isMicrosoftOwnedDomain("onmicrosoft.com")).toBe(true)
  expect(isMicrosoftOwnedDomain("corp.onmicrosoft.com")).toBe(true)
  expect(isMicrosoftOwnedDomain("ACME.ONMICROSOFT.COM ")).toBe(true)
  expect(isMicrosoftOwnedDomain("acme.dev")).toBe(false)
  expect(isMicrosoftOwnedDomain("notonmicrosoft.com")).toBe(false)
})

test("connectSummary formats OIDC and SAML identifiers", () => {
  expect(connectSummary({ issuer: "https://acme.okta.com/" }, "Fallback")).toBe(
    "acme.okta.com",
  )
  expect(
    connectSummary({ idpEntityId: "https://sts.windows.net/tenant-id/" }, "Fallback"),
  ).toBe("sts.windows.net/tenant-id")
  expect(
    connectSummary({ idpMetadataUrl: "https://idp.example.com/metadata" }, "Fallback"),
  ).toBe("idp.example.com/metadata")
  expect(connectSummary(null, "Okta")).toBe("Okta")
})

test("flowCovers is true for all required providers across their protocols", () => {
  const providers = [
    "okta",
    "entra",
    "google",
    "jumpcloud",
    "onelogin",
    "ping",
    "generic",
  ]
  const protocols = ["oidc", "saml"]
  for (const provider of providers) {
    for (const protocol of protocols) {
      expect(flowCovers(provider, protocol)).toBe(true)
    }
  }
})

describe("oidcIssuerCheck", () => {
  test("Okta takes its domain, bare or https, and nothing else", () => {
    const okta = oidcIssuerCheck("okta")
    expect(okta("acme.okta.com")).toBeNull()
    expect(okta("https://acme.okta.com/")).toBeNull()
    expect(okta("acme")).toBe("Enter your Okta domain, like acme.okta.com.")
    expect(okta("http://acme.okta.com")).toBe("Use https, not http.")
    expect(okta("acme.okta.com/oauth2/default")).toBe(
      "Just the Okta domain, leave off the path.",
    )
  })
  test("Entra takes a tenant ID or an https issuer, never a domain", () => {
    const entra = oidcIssuerCheck("entra")
    expect(entra("6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b")).toBeNull()
    expect(entra("https://login.microsoftonline.com/x/v2.0")).toBeNull()
    expect(entra("acme.com")).toBe(
      "Enter your Directory ID (UUID) or an https issuer URL.",
    )
  })
  test("any other provider takes an https issuer URL", () => {
    const generic = oidcIssuerCheck("generic")
    expect(generic("https://idp.example.com")).toBeNull()
    expect(generic("idp.example.com")).toBe(
      "Enter an https issuer URL, like https://idp.example.com.",
    )
  })
  test("an empty field is left to the required check", () => {
    expect(oidcIssuerCheck("okta")("  ")).toBeNull()
  })
})
