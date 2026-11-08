import { describe, expect, it } from "bun:test"
import { passthroughFor } from "../src/identity/ldap.js"
import {
  DiscoveryFailed,
  OIDC_MAIL_PRESETS,
  applyInput,
  canonicalIssuer,
  canonicalTokenEndpoint,
  completeOidcMail,
  defaultPresetFor,
  discoverTokenEndpoint,
  oidcMailEnabled,
  oidcMailFor,
  oidcMailInput,
  settingsProblem,
  storedOidcMail,
  type OidcMailPreset,
} from "../src/identity/oidc-mail.js"
import { IdpUnreachable, type OidcFetch } from "../src/identity/oidc-fetch.js"
import { CONNECTION, connection, memoryStore } from "./identity-fakes.js"

/**
 * An OIDC provider as the place a managed account's mail password is asked
 * (#383): what is accepted on save, what discovery may say, and what authd is
 * told. services/authd/internal/oidc checks the same rules again
 * (Settings.Validate); the two must agree.
 */

const OKTA_ID = "0oa1b2c3d4e5f6g7h8i9"
const OKTA_ISSUER = "https://acme.okta.com/oauth2/default"
const OKTA_TOKEN = `${OKTA_ISSUER}/v1/token`

const KEYCLOAK = {
  preset: "keycloak",
  issuer: "https://sso.acme.example/realms/acme",
  tokenEndpoint: "https://sso.acme.example/realms/acme/protocol/openid-connect/token",
  clientId: "mail-client",
  extra: {},
} as const

describe("the issuer", () => {
  it("accepts any public https name with a plain path, and writes it one way", () => {
    expect(canonicalIssuer(OKTA_ISSUER)).toBe(OKTA_ISSUER)
    expect(canonicalIssuer(KEYCLOAK.issuer)).toBe(KEYCLOAK.issuer)
    expect(canonicalIssuer("https://acme.eu.auth0.com")).toBe(
      "https://acme.eu.auth0.com",
    )
    // Auth0's issuer ends in a slash; what is stored does not.
    expect(canonicalIssuer("https://acme.eu.auth0.com/")).toBe(
      "https://acme.eu.auth0.com",
    )
    // Normalised, so what is stored is what authd compares.
    expect(canonicalIssuer(`${OKTA_ISSUER}/`)).toBe(OKTA_ISSUER)
    expect(canonicalIssuer("https://ACME.Okta.com/oauth2/default")).toBe(OKTA_ISSUER)
    expect(canonicalIssuer("https://acme.okta.com:443/oauth2/default")).toBe(
      OKTA_ISSUER,
    )
  })

  it("refuses anything that is not that", () => {
    for (const bad of [
      "",
      "acme.okta.com/oauth2/default",
      "http://acme.okta.com/oauth2/default",
      "ftp://acme.okta.com/oauth2/default",
      "https://acme.okta.com/oauth2/de%66ault",
      "https://acme.okta.com/oauth2/default?x=1",
      "https://acme.okta.com/oauth2/default?",
      "https://acme.okta.com/oauth2/default#frag",
      "https://acme.okta.com/a/.../b",
      "https://user:pw@acme.okta.com/oauth2/default",
      "https://acme.okta.com:8443/oauth2/default",
      // Addresses, whatever they are written as.
      "https://93.184.216.34/oauth2/default",
      "https://127.0.0.1/oauth2/default",
      "https://2130706433/oauth2/default",
      "https://0x7f.1/oauth2/default",
      "https://[::1]/oauth2/default",
      "https://[2606:4700::1111]/oauth2/default",
      // Not a public name.
      "https://localhost/oauth2/default",
      "https://okta/oauth2/default",
      "https://acme.okta.com./oauth2/default",
      "https://acme.okta.com/oauth2/default\n",
      "https://acme.okta.com/oauth2/de fault",
    ])
      expect(canonicalIssuer(bad)).toBeNull()
  })
})

// ⚠ THE TOKEN ENDPOINT IS WHERE EVERY MEMBER'S PASSWORD GOES, and it is read from a
// document the provider controls.
describe("the token endpoint", () => {
  const ok = (raw: unknown, host = "acme.okta.com") => canonicalTokenEndpoint(raw, host)

  it("is accepted on the issuer's own host", () => {
    expect(ok(OKTA_TOKEN)).toEqual({ ok: true, value: OKTA_TOKEN })
    expect(ok("https://acme.okta.com/oauth2/v1/token")).toMatchObject({ ok: true })
  })

  it("is refused on any other host, however close", () => {
    for (const bad of [
      "https://evil.example.org/oauth2/default/v1/token",
      // A sibling under the same registrable domain.
      "https://evil.okta.com/oauth2/default/v1/token",
      // The parent, and a longer name that merely starts the same.
      "https://okta.com/oauth2/default/v1/token",
      "https://acme.okta.com.evil.example/oauth2/default/v1/token",
      // A subdomain of the issuer's host.
      "https://tokens.acme.okta.com/oauth2/default/v1/token",
    ]) {
      const r = ok(bad)
      expect(r.ok).toBe(false)
      expect(r.ok ? "" : r.message).toMatch(/issuer's host|issuer's own host/)
    }
  })

  it("is refused unless it is a plain https URL with a plain path", () => {
    for (const bad of [
      undefined,
      null,
      42,
      "",
      "http://acme.okta.com/oauth2/default/v1/token",
      "https://acme.okta.com:8443/token",
      "https://acme.okta.com/token?x=1",
      "https://acme.okta.com/token#f",
      "https://user:pw@acme.okta.com/token",
      "https://acme.okta.com",
      "https://acme.okta.com/",
      "https://acme.okta.com/token/",
      "https://acme.okta.com/a/.../token",
      "https://93.184.216.34/token",
    ])
      expect(ok(bad, "acme.okta.com").ok).toBe(false)
  })
})

describe("what each preset takes", () => {
  it("has Okta keep its own client id and its custom-server issuer", () => {
    const okta = { preset: "okta", issuer: OKTA_ISSUER, clientId: OKTA_ID }
    expect(settingsProblem(okta)).toBeNull()
    expect(settingsProblem({ ...okta, clientId: "mail-client" })).toMatch(
      /Okta client id/,
    )
    for (const id of [
      "0oa123",
      "00u1b2c3d4e5f6g7h8i9",
      `${OKTA_ID}x`,
      "0oa1b2c3d4e5f6g7h&i9",
    ])
      expect(settingsProblem({ ...okta, clientId: id })).not.toBeNull()
    // The org authorization server has no password grant.
    for (const issuer of [
      "https://acme.okta.com",
      "https://acme.okta.com/oauth2",
      "https://acme.okta.com/oauth2/default/v1",
      "https://acme.okta.com/api/v1/users",
    ])
      expect(settingsProblem({ ...okta, issuer })).toMatch(
        /custom authorization server/,
      )
  })

  it("takes a bounded printable client id everywhere else", () => {
    for (const preset of OIDC_MAIL_PRESETS.filter((p) => p !== "okta")) {
      expect(settingsProblem({ preset, clientId: "mail-client" })).toBeNull()
      expect(settingsProblem({ preset, clientId: "" })).not.toBeNull()
      expect(settingsProblem({ preset, clientId: "mail client" })).not.toBeNull()
      expect(settingsProblem({ preset, clientId: "a".repeat(257) })).not.toBeNull()
    }
  })

  it("takes only the plain form fields its preset names", () => {
    expect(
      settingsProblem({
        preset: "auth0",
        extra: { realm: "Employees", audience: "https://mail" },
      }),
    ).toBeNull()
    expect(
      settingsProblem({ preset: "ping", extra: { validator_id: "ldap-pcv" } }),
    ).toBeNull()
    expect(
      settingsProblem({ preset: "keycloak", extra: { scope: "openid email" } }),
    ).toBeNull()
    expect(settingsProblem({ preset: "keycloak", extra: { realm: "x" } })).toMatch(
      /does not take the field "realm"/,
    )
    // ⚠ NOTHING THE REQUEST OWNS, AND NOTHING SECRET.
    for (const key of [
      "grant_type",
      "username",
      "password",
      "client_id",
      "client_secret",
      "client_assertion",
    ])
      for (const preset of OIDC_MAIL_PRESETS)
        expect(settingsProblem({ preset, extra: { [key]: "x" } })).not.toBeNull()
    expect(
      settingsProblem({ preset: "auth0", extra: { audience: "a\nb" } }),
    ).not.toBeNull()
    expect(
      settingsProblem({ preset: "auth0", extra: { audience: " a" } }),
    ).not.toBeNull()
    expect(
      settingsProblem({ preset: "auth0", extra: { audience: "a " } }),
    ).not.toBeNull()
    expect(
      settingsProblem({ preset: "auth0", extra: { audience: "a".repeat(257) } }),
    ).not.toBeNull()
    expect(
      settingsProblem({ preset: "auth0", extra: { audience: 3 } as never }),
    ).not.toBeNull()
  })

  it("has a default preset for the providers that have the lane, and none for those that do not", () => {
    expect(defaultPresetFor("okta")).toBe("okta")
    expect(defaultPresetFor("ping")).toBe("ping")
    expect(defaultPresetFor("generic")).toBe("generic")
    expect(defaultPresetFor("jumpcloud")).toBe("generic")
    // Their own mail sign-in, or a password grant that needs a client secret.
    for (const provider of [
      "entra",
      "google",
      "onelogin",
      "something-new",
      "constructor",
    ])
      expect(defaultPresetFor(provider)).toBeNull()
  })
})

describe("the PUT body", () => {
  it("normalises the issuer, and takes only what is present", () => {
    expect(
      oidcMailInput.parse({
        preset: "okta",
        issuer: ` ${OKTA_ISSUER}/ `,
        clientId: ` ${OKTA_ID} `,
        enabled: true,
      }),
    ).toEqual({ preset: "okta", issuer: OKTA_ISSUER, clientId: OKTA_ID, enabled: true })
    expect(oidcMailInput.parse({ enabled: false })).toEqual({ enabled: false })
    expect(oidcMailInput.parse({})).toEqual({})
  })

  it("drops an empty extra field, which means it is not set", () => {
    expect(
      oidcMailInput.parse({
        extra: { realm: " Employees ", audience: "  ", scope: "" },
      }),
    ).toEqual({ extra: { realm: "Employees" } })
    expect(oidcMailInput.parse({ extra: {} })).toEqual({ extra: {} })
  })

  it("says what is wrong, and refuses a field it does not know", () => {
    expect(
      oidcMailInput.safeParse({ issuer: "http://acme.okta.com/oauth2/default" }).error
        ?.issues[0]?.message,
    ).toMatch(/https URL/)
    expect(
      oidcMailInput.safeParse({ preset: "azure" }).error?.issues[0]?.message,
    ).toMatch(/preset must be one of okta, keycloak, auth0, ping, fusionauth, generic/)
    // OneLogin is not a preset: its password grant needs a client secret.
    expect(oidcMailInput.safeParse({ preset: "onelogin" }).success).toBe(false)
    // Nothing secret is taken here, so nothing can be smuggled in as a field.
    expect(oidcMailInput.safeParse({ clientSecret: "x" }).success).toBe(false)
    expect(
      oidcMailInput.safeParse({ tokenEndpoint: "https://evil.example/token" }).success,
    ).toBe(false)
    expect(oidcMailInput.safeParse({ enabled: "yes" }).success).toBe(false)
    expect(oidcMailInput.safeParse({ extra: { a: 1 } }).success).toBe(false)
    expect(oidcMailInput.safeParse({ clientId: "" }).success).toBe(false)
  })
})

describe("what a PUT would write", () => {
  const stored = {
    preset: "auth0",
    issuer: "https://acme.auth0.com",
    clientId: "abc",
    extra: { realm: "Employees" },
    enabled: true,
  }

  it("moves nothing when nothing differs", () => {
    const { next, changed } = applyInput(
      stored,
      oidcMailInput.parse({
        issuer: stored.issuer,
        extra: { realm: "Employees" },
        preset: "auth0",
      }),
      "generic",
    )
    expect(changed).toEqual([])
    expect(next).toEqual(stored)
  })

  it("names every setting it moves", () => {
    const { next, changed } = applyInput(
      stored,
      oidcMailInput.parse({ clientId: "xyz", extra: { realm: "Customers" } }),
      "generic",
    )
    expect(changed).toEqual(["clientId", "extra"])
    expect(next).toMatchObject({ clientId: "xyz", extra: { realm: "Customers" } })
  })

  // ⚠ AN AUTH0 REALM MEANS NOTHING TO KEYCLOAK.
  it("clears the extras when the preset moves and says nothing about them", () => {
    const { next, changed } = applyInput(
      stored,
      oidcMailInput.parse({ preset: "keycloak" }),
      "generic",
    )
    expect(changed).toEqual(["preset", "extra"])
    expect(next).toMatchObject({ preset: "keycloak", extra: {} })
    const kept = applyInput(
      stored,
      oidcMailInput.parse({ preset: "generic", extra: { audience: "x" } }),
      "generic",
    )
    expect(kept.next.extra).toEqual({ audience: "x" })
  })

  it("gives a row with no preset its provider's once anything moves, and not before", () => {
    expect(
      applyInput({}, oidcMailInput.parse({ enabled: false }), "keycloak").next,
    ).toEqual({})
    expect(
      applyInput({}, oidcMailInput.parse({ clientId: "x" }), "keycloak").next,
    ).toEqual({
      preset: "keycloak",
      clientId: "x",
    })
  })
})

describe("what is read back from the row", () => {
  const whole = { ...KEYCLOAK, enabled: true }

  it("re-checks the stored value, which anything with write access can change", () => {
    expect(completeOidcMail(whole)).toEqual(KEYCLOAK)
    for (const broken of [
      { ...whole, preset: undefined },
      { ...whole, preset: "azure" },
      { ...whole, issuer: undefined },
      { ...whole, tokenEndpoint: undefined },
      { ...whole, clientId: undefined },
      { ...whole, issuer: "http://sso.acme.example/realms/acme" },
      // Not the form authd compares: refused, rather than normalised behind the admin's back.
      { ...whole, issuer: `${KEYCLOAK.issuer}/` },
      { ...whole, clientId: "has space" },
      { ...whole, extra: { password: "x" } },
      { ...whole, extra: "nope" },
    ])
      expect(completeOidcMail(broken as never)).toBeNull()
  })

  // ⚠ A ROW EDITED BY HAND CANNOT POINT AN APPROVED ISSUER'S PASSWORDS ELSEWHERE.
  it("refuses a token endpoint on another host than the issuer", () => {
    for (const tokenEndpoint of [
      "https://evil.example.org/token",
      "https://evil.acme.example/realms/acme/protocol/openid-connect/token",
      "http://sso.acme.example/token",
      "https://sso.acme.example:8443/token",
    ])
      expect(completeOidcMail({ ...whole, tokenEndpoint })).toBeNull()
  })

  it("is a lane only for a provider that has one, enabled and whole", () => {
    expect(oidcMailFor({ provider: "generic", config: { oidcMail: whole } })).toEqual(
      KEYCLOAK,
    )
    for (const config of [
      {},
      { oidcMail: { ...whole, enabled: false } },
      { oidcMail: { ...whole, tokenEndpoint: undefined } },
      { oidcMail: "not an object" },
    ])
      expect(oidcMailFor({ provider: "generic", config })).toBeNull()
    // ⚠ A provider with no such lane has none, whatever the row says.
    for (const provider of ["entra", "google", "onelogin"])
      expect(oidcMailFor({ provider, config: { oidcMail: whole } })).toBeNull()
  })

  describe("a row from before the lane was generic", () => {
    const legacy = { issuer: OKTA_ISSUER, clientId: OKTA_ID, enabled: true }

    it("is the okta preset, with the issuer's /v1/token", () => {
      expect(oidcMailFor({ provider: "okta", config: { oktaMail: legacy } })).toEqual({
        preset: "okta",
        issuer: OKTA_ISSUER,
        tokenEndpoint: OKTA_TOKEN,
        clientId: OKTA_ID,
        extra: {},
      })
      expect(
        storedOidcMail({ provider: "okta", config: { oktaMail: legacy } }),
      ).toMatchObject({
        preset: "okta",
        tokenEndpoint: OKTA_TOKEN,
        enabled: true,
      })
    })

    it("is read only for an Okta connection, and never over an oidcMail", () => {
      for (const provider of ["generic", "entra"])
        expect(oidcMailFor({ provider, config: { oktaMail: legacy } })).toBeNull()
      const config = { oktaMail: legacy, oidcMail: { ...KEYCLOAK, enabled: false } }
      expect(oidcMailFor({ provider: "okta", config })).toBeNull()
    })

    it("counts as on for LDAP's one-place check, on any provider", () => {
      expect(oidcMailEnabled({ oktaMail: legacy })).toBe(true)
      expect(oidcMailEnabled({ oktaMail: { ...legacy, enabled: false } })).toBe(false)
      expect(oidcMailEnabled({ oidcMail: { enabled: true } })).toBe(true)
      // oidcMail, once there, is the one that speaks.
      expect(oidcMailEnabled({ oktaMail: legacy, oidcMail: { enabled: false } })).toBe(
        false,
      )
      expect(oidcMailEnabled({})).toBe(false)
    })

    it("keeps whatever else is in the object", () => {
      expect(
        storedOidcMail({
          provider: "okta",
          config: { oktaMail: { ...legacy, note: "x" } },
        }),
      ).toMatchObject({ note: "x" })
    })
  })
})

describe("discovery", () => {
  const ISSUER = "https://sso.acme.example/realms/acme"
  const DOC_URL = `${ISSUER}/.well-known/openid-configuration`
  const doc = (over: Record<string, unknown> = {}) => ({
    issuer: ISSUER,
    token_endpoint: KEYCLOAK.tokenEndpoint,
    grant_types_supported: ["authorization_code", "password", "refresh_token"],
    ...over,
  })

  /** A fetch that answers one document, and remembers what it was asked. */
  function fetchOf(reply: () => Response | Promise<Response>) {
    const asked: Array<{ url: string; method: string; redirect?: string }> = []
    const fetch: OidcFetch = async (url, options) => {
      asked.push({ url, method: options.method, redirect: options.redirect })
      return reply()
    }
    return { fetch, asked }
  }
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })
  const discover = (
    f: OidcFetch,
    over: {
      preset?: OidcMailPreset
      extra?: Record<string, string>
      issuer?: string
    } = {},
  ) =>
    discoverTokenEndpoint({
      issuer: over.issuer ?? ISSUER,
      preset: over.preset ?? "keycloak",
      extra: over.extra ?? {},
      fetch: f,
    })
  const refused = async (p: Promise<unknown>) => {
    try {
      await p
    } catch (error) {
      expect(error).toBeInstanceOf(DiscoveryFailed)
      return error as DiscoveryFailed
    }
    throw new Error("discovery was accepted")
  }

  it("reads the token endpoint, from that one URL and no other", async () => {
    const { fetch, asked } = fetchOf(() => json(doc()))
    expect(await discover(fetch)).toBe(KEYCLOAK.tokenEndpoint)
    expect(asked).toEqual([{ url: DOC_URL, method: "GET", redirect: "manual" }])
  })

  // The shape of a real Okta custom authorization server's document, read from a
  // live org on 2026-11-08 (an org authorization server's names /oauth2/v1/token).
  it("accepts what a real Okta custom authorization server publishes", async () => {
    const issuer = "https://integrator-2590605.okta.com/oauth2/default"
    const { fetch } = fetchOf(() =>
      json({
        issuer,
        token_endpoint: `${issuer}/v1/token`,
        grant_types_supported: [
          "authorization_code",
          "implicit",
          "refresh_token",
          "password",
          "urn:ietf:params:oauth:grant-type:device_code",
          "urn:okta:params:oauth:grant-type:otp",
          "http://auth0.com/oauth/grant-type/mfa-otp",
        ],
      }),
    )
    expect(await discover(fetch, { preset: "okta", issuer })).toBe(`${issuer}/v1/token`)
  })

  it("does not compare the document's issuer, which FusionAuth does not make a URL", async () => {
    const { fetch } = fetchOf(() => json(doc({ issuer: "acme.com" })))
    expect(await discover(fetch)).toBe(KEYCLOAK.tokenEndpoint)
  })

  // ⚠ THE PROVIDER'S DOCUMENT IS NOT WHERE PASSWORDS MAY BE SENT BY ITSELF.
  it("refuses a token endpoint on another host than the issuer", async () => {
    for (const token_endpoint of [
      "https://evil.example.org/token",
      "https://evil.acme.example/realms/acme/protocol/openid-connect/token",
      "http://sso.acme.example/token",
    ]) {
      const e = await refused(
        discover(fetchOf(() => json(doc({ token_endpoint }))).fetch),
      )
      expect(e.kind).toBe("refused")
    }
    const e = await refused(
      discover(
        fetchOf(() => json(doc({ token_endpoint: "https://evil.example.org/token" })))
          .fetch,
      ),
    )
    expect(e.message).toMatch(/not on the issuer's host sso\.acme\.example/)
  })

  it("refuses a document with no token endpoint, or that is not JSON, or not an object", async () => {
    expect(
      (
        await refused(
          discover(fetchOf(() => json(doc({ token_endpoint: undefined }))).fetch),
        )
      ).message,
    ).toMatch(/no token_endpoint/)
    expect(
      (await refused(discover(fetchOf(() => new Response("<html>")).fetch))).message,
    ).toMatch(/not JSON/)
    expect((await refused(discover(fetchOf(() => json(["x"])).fetch))).message).toMatch(
      /not JSON/,
    )
  })

  it("refuses a provider that lists grants and not the password one", async () => {
    const e = await refused(
      discover(
        fetchOf(() =>
          json(doc({ grant_types_supported: ["authorization_code", "refresh_token"] })),
        ).fetch,
      ),
    )
    expect(e.kind).toBe("refused")
    expect(e.message).toMatch(/password grant/)
    expect(
      await discover(
        fetchOf(() => json(doc({ grant_types_supported: ["password"] }))).fetch,
      ),
    ).toBe(KEYCLOAK.tokenEndpoint)
    // Not listing grants at all says nothing either way.
    expect(
      await discover(
        fetchOf(() => json(doc({ grant_types_supported: undefined }))).fetch,
      ),
    ).toBe(KEYCLOAK.tokenEndpoint)
  })

  it("accepts Auth0's realm grant when a realm is set", async () => {
    const realmOnly = doc({
      token_endpoint: KEYCLOAK.tokenEndpoint,
      grant_types_supported: ["http://auth0.com/oauth/grant-type/password-realm"],
    })
    const { fetch } = fetchOf(() => json(realmOnly))
    expect(
      await discover(fetch, { preset: "auth0", extra: { realm: "Employees" } }),
    ).toBe(KEYCLOAK.tokenEndpoint)
    // ...and only then.
    await refused(discover(fetch, { preset: "auth0" }))
    await refused(discover(fetch, { preset: "keycloak", extra: { realm: "x" } }))
  })

  it("separates a document that is wrong from a provider that cannot be reached", async () => {
    expect(
      (
        await refused(
          discover(
            fetchOf(
              () =>
                new Response("", {
                  status: 302,
                  headers: { location: "https://elsewhere.example/" },
                }),
            ).fetch,
          ),
        )
      ).kind,
    ).toBe("refused")
    expect(
      (await refused(discover(fetchOf(() => new Response("", { status: 404 })).fetch)))
        .message,
    ).toMatch(/404/)
    expect(
      (await refused(discover(fetchOf(() => new Response("", { status: 503 })).fetch)))
        .kind,
    ).toBe("unreachable")
    for (const kind of [
      "blocked",
      "unresolved",
      "timeout",
      "network",
      "too_large",
    ] as const) {
      const e = await refused(
        discover(
          fetchOf(() => {
            throw new IdpUnreachable("10.0.0.1 is internal", kind)
          }).fetch,
        ),
      )
      expect(e.kind).toBe("unreachable")
      // Words of ours, never the guard's (which can name an address).
      expect(e.message).not.toContain("10.0.0.1")
    }
  })
})

describe("what authd is told", () => {
  const oidc = { oidcMail: { ...KEYCLOAK, enabled: true } }
  const ldap = {
    ldap: {
      host: "ldap.acme.test",
      port: 636,
      tlsMode: "ldaps",
      caPem: null,
      searchBase: "dc=acme,dc=test",
      userFilter: "(mail={email})",
      serviceSet: true,
    },
  }
  const sealed = { ldap: { bindDn: "cn=svc", bindSecret: "secret" } }

  const world = (
    config: Record<string, unknown>,
    over: { provider?: string; secrets?: Record<string, unknown> } = {},
  ) => {
    const w = memoryStore({
      connections: [connection({ config, provider: over.provider ?? "generic" })],
    })
    if (over.secrets) w.secrets.set(CONNECTION, over.secrets)
    return w.store
  }

  it("answers the OIDC lane with the preset, the endpoint and the client id, and no secret", async () => {
    expect(await passthroughFor(world(oidc), CONNECTION)).toEqual({
      enabled: true,
      lane: "oidc",
      ...KEYCLOAK,
    })
  })

  it("answers an Okta connection's old row as the okta preset", async () => {
    expect(
      await passthroughFor(
        world(
          { oktaMail: { issuer: OKTA_ISSUER, clientId: OKTA_ID, enabled: true } },
          { provider: "okta" },
        ),
        CONNECTION,
      ),
    ).toEqual({
      enabled: true,
      lane: "oidc",
      preset: "okta",
      issuer: OKTA_ISSUER,
      tokenEndpoint: OKTA_TOKEN,
      clientId: OKTA_ID,
      extra: {},
    })
  })

  it("carries the preset's extra fields, and nothing a client could be asked for", async () => {
    const auth0 = {
      preset: "auth0" as const,
      issuer: "https://acme.auth0.com",
      tokenEndpoint: "https://acme.auth0.com/oauth/token",
      clientId: "Zk3q9XvYw0aB5cD7",
      extra: { realm: "Employees", audience: "https://mail" },
    }
    const answer = await passthroughFor(
      world({ oidcMail: { ...auth0, enabled: true } }),
      CONNECTION,
    )
    expect(answer).toEqual({ enabled: true, lane: "oidc", ...auth0 })
    expect(JSON.stringify(answer)).not.toMatch(/secret/i)
  })

  it("never opens the connection's secrets for the OIDC lane", async () => {
    const store = world(oidc)
    store.connectionSecrets = async () => {
      throw new Error("must not be asked: OIDC mail holds no secret")
    }
    expect(await passthroughFor(store, CONNECTION)).toMatchObject({ lane: "oidc" })
  })

  it("answers off for a lane that is off, half set, or on a provider that has none", async () => {
    const off = { enabled: false } as const
    expect(
      await passthroughFor(
        world({ oidcMail: { ...oidc.oidcMail, enabled: false } }),
        CONNECTION,
      ),
    ).toEqual(off)
    expect(
      await passthroughFor(
        world({ oidcMail: { ...oidc.oidcMail, tokenEndpoint: undefined } }),
        CONNECTION,
      ),
    ).toEqual(off)
    // ⚠ A token endpoint on another host than the issuer is not handed over.
    expect(
      await passthroughFor(
        world({
          oidcMail: {
            ...oidc.oidcMail,
            tokenEndpoint: "https://evil.example.org/token",
          },
        }),
        CONNECTION,
      ),
    ).toEqual(off)
    expect(
      await passthroughFor(world(oidc, { provider: "entra" }), CONNECTION),
    ).toEqual(off)
    expect(
      await passthroughFor(world(oidc, { provider: "onelogin" }), CONNECTION),
    ).toEqual(off)
    expect(await passthroughFor(world({}), CONNECTION)).toEqual(off)
  })

  /*
   * ⚠ ONE LANE, THE LDAP ONE IF BOTH ARE ON. The routes cannot produce this; a
   * row edited by hand can. Adding an OIDC lane must never change where an
   * existing LDAP connection's passwords go.
   */
  it("lets LDAP win when both are on, and says so in the answer", async () => {
    const both = { ...ldap.ldap, enabled: true }
    const answer = await passthroughFor(
      world({ ldap: both, ...oidc }, { secrets: sealed }),
      CONNECTION,
    )
    expect(answer).toMatchObject({
      enabled: true,
      lane: "ldap",
      host: "ldap.acme.test",
    })
    expect(JSON.stringify(answer)).not.toContain(KEYCLOAK.issuer)
  })

  it("does not fall through to OIDC when the LDAP lane is on but half set", async () => {
    // No service account sealed: the LDAP lane is whole in neither sense.
    expect(
      await passthroughFor(
        world({ ldap: { ...ldap.ldap, enabled: true }, ...oidc }),
        CONNECTION,
      ),
    ).toEqual({
      enabled: false,
    })
  })

  it("runs the LDAP lane on a connection with OIDC settings that are off", async () => {
    const answer = await passthroughFor(
      world(
        {
          ldap: { ...ldap.ldap, enabled: true },
          oidcMail: { ...oidc.oidcMail, enabled: false },
        },
        { secrets: sealed },
      ),
      CONNECTION,
    )
    expect(answer).toMatchObject({ enabled: true, lane: "ldap" })
  })

  it("does not turn a failure into an answer", async () => {
    const store = world({ ldap: { ...ldap.ldap, enabled: true } }, { secrets: sealed })
    store.connectionSecrets = async () => {
      throw new Error("could not unseal")
    }
    await expect(passthroughFor(store, CONNECTION)).rejects.toThrow()
  })
})
