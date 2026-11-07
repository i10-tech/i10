import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { mountIdentity } from "../src/routes/console/identity.js"
import type { ConsoleDeps } from "../src/routes/console/deps.js"
import type { Role } from "../src/console/roles.js"
import type { Connection } from "../src/identity/model.js"
import { guardedFetch } from "../src/identity/oidc-fetch.js"
import { samlEngine, storedSaml } from "../src/identity/saml.js"
import { vetHost } from "../src/webhooks/egress.js"
import {
  CONNECTION,
  TENANT,
  connection,
  log,
  memoryClerk,
  memoryReplay,
  memorySaml,
  memoryStore,
} from "./identity-fakes.js"
import { ENTITY, keys } from "./saml-idp.js"

/**
 * The console's SAML routes (#339): every body parsed strictly, metadata
 * fetched through the egress guard, our private key never read back, and the
 * trust rule - an active connection's entity id, endpoints, metadata,
 * certificates, subject attribute and IdP-initiated switch are an owner's.
 */

const ROLES: Record<string, Role> = {
  user_owner: "owner",
  user_admin: "admin",
  user_m: "member",
}

const idp = keys()
const rotated = keys(2048, "next.idp.acme.test")

const metadata = (certs: string[], entity = ENTITY) =>
  `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${entity}"><md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">` +
  certs
    .map(
      (c) =>
        `<md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${c}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>`,
    )
    .join("") +
  `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.acme.test/sso"/>` +
  `<md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.acme.test/slo"/>` +
  `</md:IDPSSODescriptor></md:EntityDescriptor>`

function consoleApp(
  options: {
    status?: Connection["status"]
    config?: Record<string, unknown>
    serve?: () => string
  } = {},
) {
  const store = memoryStore({
    connections: [
      connection({
        protocol: "saml",
        provider: "okta",
        status: options.status ?? "draft",
        config: options.config ?? {},
      }),
    ],
  })
  const saml = memorySaml(store)
  const engine = samlEngine({
    store: store.store,
    saml: saml.saml,
    fetch: guardedFetch({
      vet: (host, signal) =>
        vetHost(host, {
          lookup: async (h) => [
            {
              address: h.startsWith("intranet") ? "10.1.2.3" : "93.184.216.34",
              family: 4,
            },
          ],
          signal,
        }),
      fetch: (async () =>
        new Response(
          options.serve ? options.serve() : metadata([idp.cert.certificate]),
        )) as unknown as typeof fetch,
    }),
    replay: memoryReplay().replay,
    authOrigin: "https://auth.i10.localhost",
    log,
  })
  const as = (userId: string) => {
    const app = new Hono()
    app.use("*", async (c, next) => {
      c.set("auth", {
        apiKeyId: "",
        tenantId: TENANT,
        scopes: [],
        mode: "live",
      } as never)
      c.set("user", { userId, orgId: "org_acme" } as never)
      c.set("freshAuth", (async () => ({ status: "fresh" })) as never)
      await next()
    })
    mountIdentity(app, {
      roles: { store: { roleOf: async (_t: string, u: string) => ROLES[u] ?? null } },
      identity: {
        store: store.store,
        clerk: memoryClerk().clerk,
        gate: { forget: () => {} },
        protocols: ["saml"],
        deprovision: {},
        log,
        saml: { engine, store: saml.saml, log },
      },
    } as unknown as ConsoleDeps)
    return app
  }
  const call = (userId: string, method: string, path: string, body?: unknown) =>
    as(userId).request(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const path = `/identity/connections/${CONNECTION}/saml`
  return { store, saml, call, path }
}

const live = { idpEntityId: ENTITY, ssoUrl: "https://idp.acme.test/sso" }

describe("refusals", () => {
  it("refuses members, unknown ids and other protocols", async () => {
    const w = consoleApp()
    expect((await w.call("user_m", "GET", w.path)).status).toBe(403)
    expect(
      (await w.call("user_admin", "GET", "/identity/connections/nope/saml")).status,
    ).toBe(404)
    w.store.connections.get(CONNECTION)!.protocol = "oidc"
    expect((await w.call("user_admin", "GET", w.path)).status).toBe(404)
  })

  it("refuses unknown fields, bad URLs, bad formats and oversized lists", async () => {
    const w = consoleApp()
    for (const body of [
      { evil: true },
      { ssoUrl: "http://idp.acme.test/sso" },
      { ssoUrl: "https://10.0.0.1/sso" },
      { nameIdFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:transient" },
      { mfaContextClasses: Array.from({ length: 11 }, (_, i) => `c${i}`) },
      { idpInitiated: "yes" },
      { metadataXml: "<!DOCTYPE x><x/>" },
    ])
      expect((await w.call("user_admin", "PUT", w.path, body)).status).toBe(422)
  })

  it("refuses a metadata URL inside our network without saying what it resolved to", async () => {
    const w = consoleApp()
    const res = await w.call("user_admin", "PUT", w.path, {
      metadataUrl: "https://intranet.acme.test/metadata",
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { message: string }
    expect(body.message).not.toContain("10.1.2.3")
  })

  it("refuses a weak, expired or second-of-a-pasted-pair certificate", async () => {
    const w = consoleApp()
    const add = (certificate: string) =>
      w.call("user_admin", "POST", `${w.path}/certificates`, { certificate })
    expect((await add(keys(1024, "weak").pem)).status).toBe(422)
    expect((await add(keys(2048, "old", -1).pem)).status).toBe(422)
    expect((await add(idp.pem + idp.pem)).status).toBe(422)
    expect((await add("not a certificate")).status).toBe(422)
  })

  it("refuses a sixth certificate", async () => {
    const w = consoleApp()
    for (let i = 0; i < 5; i++)
      expect(
        (
          await w.call("user_admin", "POST", `${w.path}/certificates`, {
            certificate: keys(2048, `c${i}`).pem,
          })
        ).status,
      ).toBe(201)
    expect(
      (
        await w.call("user_admin", "POST", `${w.path}/certificates`, {
          certificate: rotated.pem,
        })
      ).status,
    ).toBe(422)
  })

  it("refuses activating before the SAML settings are complete", async () => {
    const w = consoleApp({ status: "testing" })
    const res = await w.call(
      "user_admin",
      "PATCH",
      `/identity/connections/${CONNECTION}`,
      {
        status: "active",
      },
    )
    expect(res.status).toBe(422)
  })
})

describe("the trust rule on a live connection", () => {
  const owned = () => consoleApp({ status: "active", config: { saml: live } })
  const cases: [string, string, string, unknown][] = [
    ["the entity id", "PUT", "", { idpEntityId: "https://other.test" }],
    ["the SSO URL", "PUT", "", { ssoUrl: "https://other.test/sso" }],
    ["the metadata", "PUT", "", { metadataXml: metadata([idp.cert.certificate]) }],
    ["IdP-initiated sign-in", "PUT", "", { idpInitiated: true }],
    ["the subject attribute", "PUT", "", { subjectAttribute: "email" }],
    ["the MFA context classes", "PUT", "", { mfaContextClasses: ["weak"] }],
    ["requiring encryption", "PUT", "", { requireEncryption: true }],
    ["a certificate", "POST", "/certificates", { certificate: rotated.pem }],
    ["our SP key", "POST", "/sp-key", {}],
  ]
  for (const [what, method, suffix, body] of cases) {
    it(`refuses an admin changing ${what}, lets an owner`, async () => {
      const w = owned()
      expect((await w.call("user_admin", method, w.path + suffix, body)).status).toBe(
        403,
      )
      const res = await w.call("user_owner", method, w.path + suffix, body)
      expect([200, 201]).toContain(res.status)
    })
  }

  it("refuses an admin removing a certificate", async () => {
    const w = owned()
    await w.saml.saml.addCertificate(
      TENANT,
      CONNECTION,
      { ...idp.cert, source: "upload" },
      null,
    )
    const id = w.saml.certs[0]!.id
    expect(
      (await w.call("user_admin", "DELETE", `${w.path}/certificates/${id}`)).status,
    ).toBe(403)
    expect(
      (await w.call("user_owner", "DELETE", `${w.path}/certificates/${id}`)).status,
    ).toBe(200)
    expect(w.store.events.at(-1)).toMatchObject({
      type: "connection.certificate_removed",
      actorUserId: "user_owner",
    })
  })

  it("lets an admin turn on signed requests (not trust)", async () => {
    const w = owned()
    expect(
      (await w.call("user_admin", "PUT", w.path, { signRequests: true })).status,
    ).toBe(200)
  })
})

describe("setting a connection up", () => {
  it("fills everything in from metadata, makes our SP key, and never returns the private key", async () => {
    const w = consoleApp()
    const res = await w.call("user_admin", "PUT", w.path, {
      metadataXml: metadata([idp.cert.certificate]),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      idpEntityId: ENTITY,
      ssoUrl: "https://idp.acme.test/sso",
      idpSloUrl: "https://idp.acme.test/slo",
      acsUrl: `https://auth.i10.localhost/sso/saml/acs/${CONNECTION}`,
      entityId: `https://auth.i10.localhost/sso/saml/metadata/${CONNECTION}`,
      ready: true,
    })
    expect((body.certificates as unknown[]).length).toBe(1)
    expect((body.spCertificates as unknown[]).length).toBe(1)
    expect(JSON.stringify(body)).not.toContain("PRIVATE KEY")
    expect(JSON.stringify(w.store.connections.get(CONNECTION)!.config)).not.toContain(
      "PRIVATE KEY",
    )
    expect(JSON.stringify(w.store.secrets.get(CONNECTION))).toContain("PRIVATE KEY")
    expect(
      w.store.events.find((e) => e.type === "connection.saml_updated")!.data,
    ).toMatchObject({
      certificates: { added: [idp.cert.fingerprint], removed: [] },
    })
  })

  it("follows a metadata URL and its rotation; refresh replaces only metadata certificates", async () => {
    let served = [idp.cert.certificate]
    const w = consoleApp({ serve: () => metadata(served) })
    expect(
      (
        await w.call("user_admin", "PUT", w.path, {
          metadataUrl: "https://idp.acme.test/metadata",
        })
      ).status,
    ).toBe(200)
    await w.call("user_admin", "POST", `${w.path}/certificates`, {
      certificate: rotated.pem,
    })
    served = [rotated.cert.certificate]
    const res = await w.call("user_admin", "POST", `${w.path}/refresh`)
    expect(res.status).toBe(200)
    // The uploaded copy of `rotated` stays; the metadata row for `idp` goes.
    expect(w.saml.certs.map((c) => [c.fingerprint, c.source])).toEqual([
      [rotated.cert.fingerprint, "upload"],
    ])
  })

  it("rotates our SP key keeping exactly the previous one", async () => {
    const w = consoleApp()
    for (let i = 0; i < 3; i++) await w.call("user_admin", "POST", `${w.path}/sp-key`)
    const stored = storedSaml(w.store.connections.get(CONNECTION)!)
    expect(stored.spCertificates).toHaveLength(2)
    expect(
      (w.store.secrets.get(CONNECTION)!.saml as { spKeys: unknown[] }).spKeys,
    ).toHaveLength(2)
  })

  it("activates once ready", async () => {
    const w = consoleApp({ status: "testing" })
    await w.call("user_admin", "PUT", w.path, {
      metadataXml: metadata([idp.cert.certificate]),
    })
    w.store.live[CONNECTION] = ["acme.test"]
    const res = await w.call(
      "user_admin",
      "PATCH",
      `/identity/connections/${CONNECTION}`,
      { status: "active" },
    )
    expect(res.status).toBe(200)
  })
})
