import { describe, expect, test } from "bun:test"
import {
  activeLane,
  oidcMailBody,
  oidcMailDirty,
  oidcMailEnableBlock,
  oidcMailForm,
  oidcProviderName,
  passwordOf,
  providerName,
} from "./sso-mail"
import type { OidcMailSetup } from "./sso-types"

const setup = (over: Partial<OidcMailSetup> = {}): OidcMailSetup => ({
  preset: "okta",
  defaultPreset: "okta",
  presets: [
    { id: "okta", label: "Okta", issuerHint: "", clientIdHint: "", extras: [] },
    {
      id: "auth0",
      label: "Auth0",
      issuerHint: "",
      clientIdHint: "",
      extras: [{ key: "realm", label: "Realm" }],
    },
  ],
  issuer: "https://acme.okta.com/oauth2/default",
  clientId: "0oa1b2c3d4e5f6g7h8i9",
  tokenEndpoint: "https://acme.okta.com/oauth2/default/v1/token",
  extra: {},
  enabled: false,
  available: true,
  ldapEnabled: false,
  ...over,
})

const owner = { owner: true }

describe("activeLane", () => {
  test("is off when neither lane is on", () => {
    expect(activeLane({ enabled: false }, { enabled: false })).toBe("off")
    expect(activeLane(null, null)).toBe("off")
  })

  test("names the lane that is on", () => {
    expect(activeLane({ enabled: true }, { enabled: false })).toBe("oidc")
    expect(activeLane({ enabled: false }, { enabled: true })).toBe("ldap")
    expect(activeLane(null, { enabled: true })).toBe("ldap")
  })
})

describe("providerName", () => {
  test("names the providers that have a name and falls back to a phrase", () => {
    expect(providerName("okta")).toBe("Okta")
    expect(providerName("generic")).toBe("your identity provider")
    expect(providerName("something-new")).toBe("your identity provider")
  })
})

describe("passwordOf and oidcProviderName", () => {
  test("a named provider's password, or the company's when there is no name", () => {
    expect(passwordOf("Okta")).toBe("Okta password")
    expect(passwordOf(providerName("generic"))).toBe("company password")
  })

  test("the chosen preset names the provider, except the generic one", () => {
    const data = setup()
    expect(oidcProviderName(data, "okta")).toBe("Okta")
    expect(oidcProviderName({ ...data, preset: "auth0" }, "okta")).toBe("Auth0")
    expect(oidcProviderName({ ...data, preset: "generic" }, "generic")).toBe(
      "your identity provider",
    )
    expect(
      oidcProviderName({ ...data, preset: null, defaultPreset: "okta" }, "okta"),
    ).toBe("Okta")
  })
})

describe("oidcMailEnableBlock", () => {
  const data = setup()

  test("lets an owner turn on whole, saved settings", () => {
    expect(oidcMailEnableBlock(data, oidcMailForm(data), owner)).toBeNull()
  })

  test("says why an admin cannot", () => {
    expect(oidcMailEnableBlock(data, oidcMailForm(data), { owner: false })).toMatch(
      /owner/,
    )
  })

  test("waits for the settings to be saved", () => {
    const form = { ...oidcMailForm(data), clientId: "0oaZZZZZZZZZZZZZZZZZ" }
    expect(oidcMailEnableBlock(data, form, owner)).toMatch(/Save your changes/)
  })

  test("waits for the settings to exist", () => {
    const empty = setup({ issuer: null, clientId: null, tokenEndpoint: null })
    expect(oidcMailEnableBlock(empty, oidcMailForm(empty), owner)).toMatch(
      /issuer and client ID/,
    )
  })

  test("is blocked while the directory check is on", () => {
    const busy = setup({ ldapEnabled: true })
    expect(oidcMailEnableBlock(busy, oidcMailForm(busy), owner)).toMatch(/directory/)
  })
})

describe("oidcMailDirty", () => {
  const data = setup({ extra: { realm: "staff" } })

  test("is clean right after a fill", () => {
    expect(oidcMailDirty(oidcMailForm(data), data)).toBe(false)
  })

  test("ignores spaces around text and empty extras", () => {
    const form = oidcMailForm(data)
    expect(
      oidcMailDirty(
        { ...form, issuer: ` ${form.issuer} `, extra: { ...form.extra, scope: "" } },
        data,
      ),
    ).toBe(false)
  })

  test("sees a changed extra or preset", () => {
    const form = oidcMailForm(data)
    expect(oidcMailDirty({ ...form, extra: { realm: "ops" } }, data)).toBe(true)
    expect(oidcMailDirty({ ...form, preset: "auth0" }, data)).toBe(true)
  })

  test("a preset never chosen shows the provider's default and is not dirty", () => {
    const fresh = setup({ preset: null, issuer: null, clientId: null })
    expect(oidcMailForm(fresh).preset).toBe("okta")
    expect(oidcMailDirty(oidcMailForm(fresh), fresh)).toBe(false)
  })
})

describe("oidcMailBody", () => {
  test("trims, drops empty extras and extras the preset does not take", () => {
    const body = oidcMailBody(
      {
        preset: "auth0",
        issuer: " https://acme.auth0.com ",
        clientId: " abc ",
        extra: { realm: " staff ", audience: "", scope: "openid" },
      },
      ["realm", "audience"],
    )
    expect(body).toEqual({
      preset: "auth0",
      issuer: "https://acme.auth0.com",
      clientId: "abc",
      extra: { realm: "staff" },
    })
  })
})
