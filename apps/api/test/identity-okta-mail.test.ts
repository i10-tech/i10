import { describe, expect, it } from "bun:test"
import { passthroughFor } from "../src/identity/ldap.js"
import {
  canonicalIssuer,
  completeOktaMail,
  isClientId,
  oktaMailFor,
  oktaMailInput,
} from "../src/identity/okta-mail.js"
import { CONNECTION, connection, memoryStore } from "./identity-fakes.js"

/**
 * Okta as the place a managed account's mail password is asked (#383): what is
 * accepted on save, and what authd is told. services/authd/internal/okta checks
 * the same rules again (Settings.Validate); the two must agree.
 */

const ID = "0oa1b2c3d4e5f6g7h8i9"
const ISSUER = "https://acme.okta.com/oauth2/default"

describe("the issuer", () => {
  it("accepts a custom authorization server and writes it one way", () => {
    expect(canonicalIssuer(ISSUER)).toBe(ISSUER)
    expect(
      canonicalIssuer("https://acme.oktapreview.com/oauth2/aus1b2c3d4e5f6g7h8i9"),
    ).toBe("https://acme.oktapreview.com/oauth2/aus1b2c3d4e5f6g7h8i9")
    expect(canonicalIssuer("https://id.acme.example/oauth2/default")).toBe(
      "https://id.acme.example/oauth2/default",
    )
    // Normalised, so what is stored is what authd compares.
    expect(canonicalIssuer(`${ISSUER}/`)).toBe(ISSUER)
    expect(canonicalIssuer("https://ACME.Okta.com/oauth2/default")).toBe(ISSUER)
    expect(canonicalIssuer("https://acme.okta.com:443/oauth2/default")).toBe(ISSUER)
  })

  it("refuses anything that is not that", () => {
    for (const bad of [
      "",
      "acme.okta.com/oauth2/default",
      "http://acme.okta.com/oauth2/default",
      "ftp://acme.okta.com/oauth2/default",
      // The org authorization server has no password grant.
      "https://acme.okta.com",
      "https://acme.okta.com/",
      "https://acme.okta.com/oauth2",
      "https://acme.okta.com/oauth2/default/v1/token",
      "https://acme.okta.com/api/v1/users",
      "https://acme.okta.com/oauth2/de%66ault",
      "https://acme.okta.com/oauth2/default?x=1",
      "https://acme.okta.com/oauth2/default#frag",
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
    ])
      expect(canonicalIssuer(bad)).toBeNull()
  })
})

describe("the client id", () => {
  it("is an Okta app's, and nothing else", () => {
    expect(isClientId(ID)).toBe(true)
    for (const bad of [
      "",
      "0oa123",
      "00u1b2c3d4e5f6g7h8i9",
      `${ID}x`,
      "0oa1b2c3d4e5f6g7h&i9",
      " 0oa1b2c3d4e5f6g7h8i9",
    ])
      expect(isClientId(bad)).toBe(false)
  })
})

describe("the PUT body", () => {
  it("normalises the issuer, and takes only what is present", () => {
    expect(
      oktaMailInput.parse({
        issuer: ` ${ISSUER}/ `,
        clientId: ` ${ID} `,
        enabled: true,
      }),
    ).toEqual({ issuer: ISSUER, clientId: ID, enabled: true })
    expect(oktaMailInput.parse({ enabled: false })).toEqual({ enabled: false })
    expect(oktaMailInput.parse({})).toEqual({})
  })

  it("says what is wrong, and refuses a field it does not know", () => {
    const bad = oktaMailInput.safeParse({
      issuer: "http://acme.okta.com/oauth2/default",
    })
    expect(bad.success).toBe(false)
    expect(bad.error?.issues[0]?.message).toMatch(/https URL like/)
    expect(
      oktaMailInput.safeParse({ clientId: "nope" }).error?.issues[0]?.message,
    ).toMatch(/Okta client id/)
    // Nothing secret is taken here, so nothing can be smuggled in as a field.
    expect(oktaMailInput.safeParse({ clientSecret: "x" }).success).toBe(false)
    expect(oktaMailInput.safeParse({ enabled: "yes" }).success).toBe(false)
  })
})

describe("what is read back from the row", () => {
  it("re-checks the stored value, which anything with write access can change", () => {
    expect(completeOktaMail({ issuer: ISSUER, clientId: ID })).toEqual({
      issuer: ISSUER,
      clientId: ID,
    })
    expect(completeOktaMail({ issuer: ISSUER })).toBeNull()
    expect(completeOktaMail({ clientId: ID })).toBeNull()
    expect(
      completeOktaMail({ issuer: "http://acme.okta.com/oauth2/default", clientId: ID }),
    ).toBeNull()
    // Not the form authd compares: refused, rather than normalised behind the admin's back.
    expect(completeOktaMail({ issuer: `${ISSUER}/`, clientId: ID })).toBeNull()
    expect(
      completeOktaMail({ issuer: ISSUER, clientId: "00u1b2c3d4e5f6g7h8i9" }),
    ).toBeNull()
  })

  it("is a lane only for an Okta connection that is enabled and whole", () => {
    const whole = { issuer: ISSUER, clientId: ID, enabled: true }
    expect(oktaMailFor({ provider: "okta", config: { oktaMail: whole } })).toEqual({
      issuer: ISSUER,
      clientId: ID,
    })
    for (const config of [
      {},
      { oktaMail: { ...whole, enabled: false } },
      { oktaMail: { issuer: ISSUER, enabled: true } },
      { oktaMail: "not an object" },
    ])
      expect(oktaMailFor({ provider: "okta", config })).toBeNull()
    // ⚠ A provider that is not Okta has no such lane, whatever the row says.
    for (const provider of ["entra", "google", "generic"])
      expect(oktaMailFor({ provider, config: { oktaMail: whole } })).toBeNull()
  })
})

describe("what authd is told", () => {
  const okta = { oktaMail: { issuer: ISSUER, clientId: ID, enabled: true } }
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
      connections: [connection({ config, provider: over.provider ?? "okta" })],
    })
    if (over.secrets) w.secrets.set(CONNECTION, over.secrets)
    return w.store
  }

  it("answers the Okta lane with the issuer and the client id, and no secret", async () => {
    expect(await passthroughFor(world(okta), CONNECTION)).toEqual({
      enabled: true,
      lane: "okta",
      issuer: ISSUER,
      clientId: ID,
    })
  })

  it("never opens the connection's secrets for the Okta lane", async () => {
    const store = world(okta)
    store.connectionSecrets = async () => {
      throw new Error("must not be asked: Okta mail holds no secret")
    }
    expect(await passthroughFor(store, CONNECTION)).toMatchObject({ lane: "okta" })
  })

  it("answers off for an Okta lane that is off, half set, or on the wrong provider", async () => {
    const off = { enabled: false } as const
    expect(
      await passthroughFor(
        world({ oktaMail: { ...okta.oktaMail, enabled: false } }),
        CONNECTION,
      ),
    ).toEqual(off)
    expect(
      await passthroughFor(
        world({ oktaMail: { issuer: ISSUER, enabled: true } }),
        CONNECTION,
      ),
    ).toEqual(off)
    expect(
      await passthroughFor(world(okta, { provider: "entra" }), CONNECTION),
    ).toEqual(off)
    expect(await passthroughFor(world({}), CONNECTION)).toEqual(off)
  })

  /*
   * ⚠ ONE LANE, THE LDAP ONE IF BOTH ARE ON. The routes cannot produce this; a
   * row edited by hand can. Adding Okta must never change where an existing
   * LDAP connection's passwords go.
   */
  it("lets LDAP win when both are on, and says so in the answer", async () => {
    const both = { ...ldap.ldap, enabled: true }
    const answer = await passthroughFor(
      world({ ldap: both, ...okta }, { secrets: sealed }),
      CONNECTION,
    )
    expect(answer).toMatchObject({
      enabled: true,
      lane: "ldap",
      host: "ldap.acme.test",
    })
    expect(JSON.stringify(answer)).not.toContain(ISSUER)
  })

  it("does not fall through to Okta when the LDAP lane is on but half set", async () => {
    // No service account sealed: the LDAP lane is whole in neither sense.
    const answer = await passthroughFor(
      world({ ldap: { ...ldap.ldap, enabled: true }, ...okta }),
      CONNECTION,
    )
    expect(answer).toEqual({ enabled: false })
  })

  it("runs the LDAP lane on a connection with Okta settings that are off", async () => {
    const answer = await passthroughFor(
      world(
        {
          ldap: { ...ldap.ldap, enabled: true },
          oktaMail: { ...okta.oktaMail, enabled: false },
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
