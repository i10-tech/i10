import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { mountIdentity } from "../src/routes/console/identity.js"
import { readIdpUrl, readOidcInput } from "../src/routes/console/identity-oidc.js"
import { createSsoRoutes, type SsoRouteDeps } from "../src/routes/sso.js"
import type { ConsoleDeps } from "../src/routes/console/deps.js"
import type { Role } from "../src/console/roles.js"
import type { Connection } from "../src/identity/model.js"
import { oidcEngine } from "../src/identity/oidc.js"
import { guardedFetch } from "../src/identity/oidc-fetch.js"
import { OIDC_PRESETS } from "../src/identity/oidc-presets.js"
import { vetHost } from "../src/webhooks/egress.js"
import {
  CONNECTION,
  TENANT,
  connection,
  log,
  memoryClerk,
  memoryStore,
} from "./identity-fakes.js"
import { testIssuer } from "./oidc-issuer.js"

/**
 * The console's OIDC routes (#338): secrets are write-only, every field is
 * validated, the issuer is proved through the egress guard before it is
 * saved, and the trust rule - an active connection's issuer, client, secret
 * and keys are an owner's to change.
 */

const ROLES: Record<string, Role> = {
  user_owner: "owner",
  user_admin: "admin",
  user_m: "member",
}

async function consoleApp(
  options: {
    status?: Connection["status"]
    provider?: string
    google?: boolean
    config?: Record<string, unknown>
  } = {},
) {
  const idp = await testIssuer()
  const store = memoryStore({
    connections: [
      connection({
        protocol: "oidc",
        provider: options.provider ?? "okta",
        status: options.status ?? "draft",
        config: options.config ?? {},
      }),
    ],
  })
  const engine = oidcEngine({
    store: store.store,
    fetch: guardedFetch({
      // DNS as the admin's zone says: idp.acme.test is public, intranet.acme.test is not.
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
      fetch: idp.fetch,
    }),
    redirectUri: "https://auth.i10.localhost/sso/callback",
    google: options.google
      ? { clientId: "g.apps.googleusercontent.com", clientSecret: "google-secret" }
      : null,
    log,
  })
  const apps = new Map<string, Hono>()
  const as = (userId: string) => {
    const cached = apps.get(userId)
    if (cached) return cached
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
        protocols: ["oidc"],
        deprovision: {},
        log,
        oidc: {
          engine,
          jwksUrl: (id: string) => `https://auth.i10.localhost/sso/jwks/${id}`,
        },
      },
    } as unknown as ConsoleDeps)
    apps.set(userId, app)
    return app
  }
  const call = (userId: string, method: string, path: string, body?: unknown) =>
    as(userId).request(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const path = `/identity/connections/${CONNECTION}/oidc`
  const settings = {
    issuer: idp.issuer,
    clientId: "client-acme",
    clientAuth: "client_secret_basic",
  }
  return { idp, store, engine, call, path, settings }
}

describe("OIDC settings", () => {
  it("returns what to paste into the IdP", async () => {
    const w = await consoleApp()
    const res = await w.call("user_admin", "GET", w.path)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      redirectUri: "https://auth.i10.localhost/sso/callback",
      jwksUrl: `https://auth.i10.localhost/sso/jwks/${CONNECTION}`,
      label: "Okta",
      clientSecretSet: false,
      ready: false,
    })
    expect((await w.call("user_m", "GET", w.path)).status).toBe(403)
  })

  it("saves validated settings once discovery proves the issuer", async () => {
    const w = await consoleApp()
    const res = await w.call("user_admin", "PUT", w.path, {
      ...w.settings,
      scopes: ["openid", "email", "profile", "groups"],
    })
    expect(res.status).toBe(200)
    expect(w.idp.calls.discovery).toBe(1)
    expect(w.store.connections.get(CONNECTION)!.config.oidc).toMatchObject({
      issuer: "https://idp.acme.test",
      clientId: "client-acme",
      scopes: ["openid", "email", "profile", "groups"],
    })
    expect(w.store.events.at(-1)).toMatchObject({
      type: "connection.oidc_updated",
      actorUserId: "user_admin",
      data: { trust: true, status: "draft" },
    })
  })

  it("refuses an issuer that resolves to a private address (the egress guard)", async () => {
    const w = await consoleApp()
    const res = await w.call("user_admin", "PUT", w.path, {
      ...w.settings,
      issuer: "https://intranet.acme.test",
    })
    expect(res.status).toBe(422)
    // ⚠ Generic: the guard's reason (what the name resolved to) stays in our log.
    const message = ((await res.json()) as { message: string }).message
    expect(message).toMatch(/could not reach that issuer/)
    expect(message).not.toMatch(/10\.1\.2\.3|public address/)
    expect(w.store.connections.get(CONNECTION)!.config.oidc).toBeUndefined()
  })

  it("refuses an issuer whose discovery names another one", async () => {
    const w = await consoleApp()
    const res = await w.call("user_admin", "PUT", w.path, {
      ...w.settings,
      issuer: "https://idp.acme.test/other",
      discoveryUrl: "https://idp.acme.test/.well-known/openid-configuration",
    })
    expect(res.status).toBe(422)
  })

  it("validates every field", () => {
    const okta = OIDC_PRESETS.okta
    const bad: Record<string, unknown>[] = [
      { issuer: "http://idp.acme.test" },
      { issuer: "https://user:pw@idp.acme.test" },
      { issuer: "https://idp.acme.test/#x" },
      { issuer: "https://idp.acme.test/?a=1" },
      { issuer: "https://localhost" },
      { issuer: "https://10.0.0.1" },
      { issuer: "https://[::1]" },
      { discoveryUrl: "ftp://x.test/" },
      { clientId: "has space" },
      { clientId: "" },
      { clientAuth: "none" },
      { scopes: ["email"] },
      { scopes: "openid" },
      { scopes: ["openid", 'bad"scope'] },
      { acrValues: ["a b"] },
      { mfaAcrValues: new Array(11).fill("x") },
    ]
    for (const body of bad) expect(typeof readOidcInput(body, okta, {})).toBe("string")
    expect(
      readOidcInput({ discoveryUrl: null }, okta, { discoveryUrl: "https://x.test/d" }),
    ).toMatchObject({
      next: { discoveryUrl: null },
      changed: ["discoveryUrl"],
    })
    expect(
      typeof readIdpUrl("https://idp.acme.test/oauth2/default", "issuer", {
        query: false,
      }),
    ).toBe("string")
  })

  it("holds Entra to its tenant issuer and to client secrets", () => {
    const entra = OIDC_PRESETS.entra
    for (const issuer of [
      "https://login.microsoftonline.com/common/v2.0",
      "https://login.microsoftonline.com/organizations/v2.0",
      "https://sts.windows.net/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0/",
    ])
      expect(typeof readOidcInput({ issuer }, entra, {})).toBe("string")
    expect(
      readOidcInput(
        {
          issuer:
            "https://login.microsoftonline.com/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0/v2.0",
        },
        entra,
        {},
      ),
    ).toMatchObject({ changed: ["issuer"] })
    expect(typeof readOidcInput({ clientAuth: "private_key_jwt" }, entra, {})).toBe(
      "string",
    )
  })

  it("has nothing to set on a Google connection", () => {
    expect(typeof readOidcInput({ clientId: "x" }, OIDC_PRESETS.google, {})).toBe(
      "string",
    )
  })
})

describe("secrets are write-only", () => {
  it("never returns the client secret, anywhere", async () => {
    const w = await consoleApp()
    await w.call("user_admin", "PUT", w.path, w.settings)
    const secret = "very-secret-client-value-123"
    const set = await w.call("user_admin", "PUT", `${w.path}/secret`, {
      clientSecret: secret,
    })
    expect(set.status).toBe(200)
    const bodies = [
      await set.text(),
      await (await w.call("user_admin", "GET", w.path)).text(),
      await (await w.call("user_admin", "GET", "/identity/connections")).text(),
      JSON.stringify(w.store.events),
    ]
    for (const body of bodies) expect(body).not.toContain(secret)
    expect(JSON.parse(bodies[0]!)).toMatchObject({ clientSecretSet: true, ready: true })
    expect(w.store.secrets.get(CONNECTION)).toMatchObject({
      oidc: { clientSecret: secret },
    })
    expect(w.store.events.at(-1)).toMatchObject({
      type: "connection.secret_set",
      data: { kind: "client_secret", rotated: false },
    })
  })

  it("never returns a private key, and keeps the previous public key for a rotation", async () => {
    const w = await consoleApp()
    const first = await w.call("user_admin", "POST", `${w.path}/keys`)
    expect(first.status).toBe(201)
    const second = await w.call("user_admin", "POST", `${w.path}/keys`)
    const third = await w.call("user_admin", "POST", `${w.path}/keys`)
    const view = (await third.json()) as { keys: { kid: string }[] }
    expect(view.keys).toHaveLength(2)
    for (const res of [first, second])
      expect(await res.clone().text()).not.toContain('"d"')
    expect(JSON.stringify(w.store.connections.get(CONNECTION)!.config)).not.toContain(
      '"d"',
    )
    const sealed = w.store.secrets.get(CONNECTION) as {
      oidc: { privateKeys: { kid: string; jwk: { d?: string } }[] }
    }
    expect(sealed.oidc.privateKeys).toHaveLength(2)
    expect(sealed.oidc.privateKeys[0]!.jwk.d).toBeString()
    expect(sealed.oidc.privateKeys.map((k) => k.kid)).toEqual(
      view.keys.map((k) => k.kid),
    )
  })

  it("serves the public JWKS at the public route, and nothing for other protocols", async () => {
    const w = await consoleApp()
    await w.call("user_admin", "POST", `${w.path}/keys`)
    const sso = createSsoRoutes({
      bridge: { store: w.store.store, log } as never,
      oidc: w.engine,
    } as unknown as SsoRouteDeps)
    const res = await sso.request(`/oidc/jwks/${CONNECTION}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { keys: Record<string, unknown>[] }
    expect(body.keys).toHaveLength(1)
    expect(body.keys[0]).not.toHaveProperty("d")
    w.store.connections.set(CONNECTION, {
      ...w.store.connections.get(CONNECTION)!,
      protocol: "saml",
    })
    expect((await sso.request(`/oidc/jwks/${CONNECTION}`)).status).toBe(404)
  })
})

describe("the trust rule", () => {
  it("lets an admin change everything on a draft or testing connection", async () => {
    for (const status of ["draft", "testing"] as const) {
      const w = await consoleApp({ status })
      expect((await w.call("user_admin", "PUT", w.path, w.settings)).status).toBe(200)
      expect(
        (
          await w.call("user_admin", "PUT", `${w.path}/secret`, {
            clientSecret: "x".repeat(20),
          })
        ).status,
      ).toBe(200)
      expect((await w.call("user_admin", "POST", `${w.path}/keys`)).status).toBe(201)
    }
  })

  it("keeps an active or disabled connection's trust settings for owners", async () => {
    for (const status of ["active", "disabled"] as const) {
      const w = await consoleApp({ status })
      const put = await w.call("user_admin", "PUT", w.path, w.settings)
      expect(put.status).toBe(403)
      expect(
        (
          await w.call("user_admin", "PUT", `${w.path}/secret`, {
            clientSecret: "x".repeat(20),
          })
        ).status,
      ).toBe(403)
      expect((await w.call("user_admin", "POST", `${w.path}/keys`)).status).toBe(403)
      expect(w.store.connections.get(CONNECTION)!.config.oidc).toBeUndefined()
      expect(w.store.secrets.get(CONNECTION)).toBeUndefined()

      expect((await w.call("user_owner", "PUT", w.path, w.settings)).status).toBe(200)
      expect(
        (
          await w.call("user_owner", "PUT", `${w.path}/secret`, {
            clientSecret: "x".repeat(20),
          })
        ).status,
      ).toBe(200)
      expect(w.store.events.map((e) => [e.type, e.actorUserId])).toEqual([
        ["connection.oidc_updated", "user_owner"],
        ["connection.secret_set", "user_owner"],
      ])
    }
  })

  it("still lets an admin change what is not trust on an active connection", async () => {
    const w = await consoleApp({ status: "active" })
    const res = await w.call("user_admin", "PUT", w.path, {
      acrValues: ["urn:acme:loa2"],
    })
    expect(res.status).toBe(200)
    expect(w.store.events.at(-1)).toMatchObject({ data: { trust: false } })
  })

  it("treats which acr proves MFA as trust, and loosening a live connection as an owner's", async () => {
    const w = await consoleApp({ status: "active" })
    expect(
      (await w.call("user_admin", "PUT", w.path, { mfaAcrValues: ["urn:weak"] }))
        .status,
    ).toBe(403)
    const patch = (userId: string, body: unknown) =>
      w.call(userId, "PATCH", `/identity/connections/${CONNECTION}`, body)
    expect((await patch("user_admin", { mfaRequired: true })).status).toBe(200)
    expect((await patch("user_admin", { mfaRequired: false })).status).toBe(403)
    expect(
      (await patch("user_admin", { attributeMapping: { mail: "email" } })).status,
    ).toBe(403)
    expect((await patch("user_owner", { mfaRequired: false })).status).toBe(200)
  })

  it("does not let an admin step around it by moving an active connection back to setup", async () => {
    const w = await consoleApp({
      status: "active",
      config: {
        oidc: {
          issuer: "https://idp.acme.test",
          clientId: "client-acme",
          clientAuth: "client_secret_basic",
          clientSecretSet: true,
        },
      },
    })
    const patch = (userId: string, status: string) =>
      w.call(userId, "PATCH", `/identity/connections/${CONNECTION}`, { status })
    expect((await patch("user_admin", "testing")).status).toBe(403)
    expect((await patch("user_admin", "draft")).status).toBe(403)
    // Disabling is always allowed: stopping sign-ins is the safe direction.
    expect((await patch("user_admin", "disabled")).status).toBe(200)
    expect((await patch("user_admin", "testing")).status).toBe(403)
    expect((await patch("user_owner", "testing")).status).toBe(200)
  })

  it("keeps an active connection's domains for owners too", async () => {
    const w = await consoleApp({ status: "active" })
    const domain = "33333333-3333-4333-8333-333333333333"
    const add = (userId: string) =>
      w.call(userId, "POST", `/identity/connections/${CONNECTION}/domains`, {
        joinDomainId: domain,
      })
    const remove = (userId: string) =>
      w.call(userId, "DELETE", `/identity/connections/${CONNECTION}/domains/${domain}`)
    expect((await add("user_admin")).status).toBe(403)
    expect((await remove("user_admin")).status).toBe(403)
    // The owner gets past the rule (and then to the store's own answer).
    expect((await add("user_owner")).status).not.toBe(403)
    expect((await remove("user_owner")).status).not.toBe(403)
  })

  it("will not test or activate an OIDC connection that is not configured", async () => {
    const w = await consoleApp()
    const patch = (status: string) =>
      w.call("user_admin", "PATCH", `/identity/connections/${CONNECTION}`, { status })
    expect((await patch("testing")).status).toBe(422)
    await w.call("user_admin", "PUT", w.path, w.settings)
    expect((await patch("testing")).status).toBe(422)
    await w.call("user_admin", "PUT", `${w.path}/secret`, {
      clientSecret: "x".repeat(20),
    })
    expect((await patch("testing")).status).toBe(200)
  })
})

describe("creating OIDC connections", () => {
  const create = async (provider: string, google = false) => {
    const w = await consoleApp({ google })
    return w.call("user_admin", "POST", "/identity/connections", {
      name: "Acme",
      protocol: "oidc",
      provider,
    })
  }
  it("takes a preset", async () => {
    expect((await create("okta")).status).toBe(201)
    expect((await create("generic")).status).toBe(201)
    expect((await create("something")).status).toBe(422)
  })
  it("offers Google only with our Google client configured", async () => {
    expect((await create("google")).status).toBe(422)
    expect((await create("google", true)).status).toBe(201)
  })
})
