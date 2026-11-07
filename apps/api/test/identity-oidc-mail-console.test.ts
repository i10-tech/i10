import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { mountIdentity } from "../src/routes/console/identity.js"
import type { ConsoleDeps } from "../src/routes/console/deps.js"
import type { Role } from "../src/console/roles.js"
import type { Connection } from "../src/identity/model.js"
import { storedOidcMail } from "../src/identity/oidc-mail.js"
import { IdpUnreachable, type OidcFetch } from "../src/identity/oidc-fetch.js"
import {
  CONNECTION,
  TENANT,
  connection,
  memoryClerk,
  memoryStore,
} from "./identity-fakes.js"

/**
 * The console's OIDC mail routes (#383): an owner's move on every status, step-up
 * on every write, the token endpoint read from discovery and never typed,
 * validation that agrees with authd, one place for a connection's passwords, and
 * the cached passwords revoked on every change.
 */

const ROLES: Record<string, Role> = {
  user_owner: "owner",
  user_admin: "admin",
  user_m: "member",
}

const ISSUER = "https://acme.okta.com/oauth2/default"
const TOKEN = `${ISSUER}/v1/token`
const CLIENT = "0oa1b2c3d4e5f6g7h8i9"
const OTHER_CLIENT = "0oa9z8y7x6w5v4u3t2s1"
const SETTINGS = { issuer: ISSUER, clientId: CLIENT }

const KC_ISSUER = "https://sso.acme.example/realms/acme"
const KC_TOKEN = `${KC_ISSUER}/protocol/openid-connect/token`

const doc = (issuer: string, over: Record<string, unknown> = {}) => ({
  issuer,
  token_endpoint: `${issuer}/v1/token`,
  grant_types_supported: ["authorization_code", "password", "refresh_token"],
  ...over,
})
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

function app(
  options: {
    status?: Connection["status"]
    provider?: string
    config?: Record<string, unknown>
    fresh?: boolean
    wired?: boolean
    invalidate?: (connectionId: string) => Promise<void>
    /** What the provider's discovery URL answers. Default: a document for that issuer. */
    discovery?: (url: string) => Response | Promise<Response>
  } = {},
) {
  const store = memoryStore({
    connections: [
      connection({
        status: options.status ?? "draft",
        provider: options.provider ?? "okta",
        config: options.config ?? {},
      }),
    ],
  })
  const revoked: string[] = []
  const errors: object[] = []
  const asked: string[] = []
  const log = { ...console, error: (o: object) => errors.push(o), warn: () => {} }
  const fetch: OidcFetch = async (url) => {
    asked.push(url)
    return options.discovery
      ? options.discovery(url)
      : json(doc(url.replace("/.well-known/openid-configuration", "")))
  }
  let fresh = options.fresh ?? true
  const apps = new Map<string, Hono>()
  const as = (userId: string) => {
    const cached = apps.get(userId)
    if (cached) return cached
    const a = new Hono()
    a.use("*", async (c, next) => {
      c.set("auth", {
        apiKeyId: "",
        tenantId: TENANT,
        scopes: [],
        mode: "live",
      } as never)
      c.set("user", { userId, orgId: "org_acme" } as never)
      c.set("freshAuth", (async () => ({ status: fresh ? "fresh" : "stale" })) as never)
      await next()
    })
    mountIdentity(a, {
      roles: { store: { roleOf: async (_t: string, u: string) => ROLES[u] ?? null } },
      identity: {
        store: store.store,
        clerk: memoryClerk().clerk,
        gate: { forget: () => {} },
        protocols: ["test"],
        deprovision: {},
        log,
        ...(options.wired === false
          ? {}
          : {
              oidcMail: {
                fetch,
                invalidate:
                  options.invalidate ??
                  (async (id: string) => {
                    revoked.push(id)
                  }),
              },
            }),
      },
    } as unknown as ConsoleDeps)
    apps.set(userId, a)
    return a
  }
  const call = (userId: string, method: string, path: string, body?: unknown) =>
    as(userId).request(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const base = `/identity/connections/${CONNECTION}/oidc-mail`
  return {
    store,
    call,
    base,
    revoked,
    errors,
    asked,
    setFresh: (v: boolean) => (fresh = v),
    stored: () =>
      storedOidcMail({
        config: store.connections.get(CONNECTION)!.config,
        provider: store.connections.get(CONNECTION)!.provider,
      }),
    config: () => store.connections.get(CONNECTION)!.config,
    last: () => store.events.at(-1),
  }
}

const events = (w: ReturnType<typeof app>, type: string) =>
  w.store.events.filter((e) => e.type === type)
const body = async (res: Response) => (await res.json()) as Record<string, unknown>

describe("OIDC mail settings: refusals", () => {
  it("needs a fresh step-up for a write, and changes nothing without it", async () => {
    const w = app({ fresh: false })
    expect((await w.call("user_owner", "PUT", w.base, SETTINGS)).status).toBe(403)
    expect(w.stored()).toEqual({})
    expect(w.store.events).toEqual([])
    expect(w.revoked).toEqual([])
    expect(w.asked).toEqual([])
    expect((await w.call("user_owner", "GET", w.base)).status).toBe(200)
  })

  it("is for admins: a member sees and changes nothing", async () => {
    const w = app()
    expect((await w.call("user_m", "GET", w.base)).status).toBe(403)
    expect((await w.call("user_m", "PUT", w.base, SETTINGS)).status).toBe(403)
    expect(w.stored()).toEqual({})
    expect(w.asked).toEqual([])
  })

  it("answers 404 for a malformed id and for another workspace's connection", async () => {
    const w = app()
    expect(
      (await w.call("user_admin", "GET", "/identity/connections/nope/oidc-mail"))
        .status,
    ).toBe(404)
    const other = "99999999-9999-4999-8999-999999999999"
    expect(
      (await w.call("user_admin", "GET", `/identity/connections/${other}/oidc-mail`))
        .status,
    ).toBe(404)
  })

  it("answers 501 where the deployment does not wire it", async () => {
    const w = app({ wired: false })
    expect((await w.call("user_owner", "GET", w.base)).status).toBe(501)
    expect((await w.call("user_owner", "PUT", w.base, SETTINGS)).status).toBe(501)
  })

  // ⚠ THE TOKEN ENDPOINT IS WHERE EVERY MEMBER'S MAIL PASSWORD GOES. An owner's, on
  // every status - a draft included, unlike LDAP's. And an admin's refusal costs no
  // outbound request: it is not a way to make us fetch a URL.
  it("keeps every change and turning it on an owner's, whatever the status", async () => {
    for (const status of ["draft", "testing", "active", "disabled"] as const) {
      const w = app({ status })
      for (const b of [
        SETTINGS,
        { issuer: ISSUER },
        { clientId: CLIENT },
        { preset: "keycloak" },
        { extra: { scope: "openid" } },
        { enabled: true },
      ]) {
        const res = await w.call("user_admin", "PUT", w.base, b)
        expect(res.status).toBe(403)
        expect(((await res.json()) as { message: string }).message).toMatch(/owner/)
      }
      expect(w.stored()).toEqual({})
      expect(w.store.events).toEqual([])
      expect(w.revoked).toEqual([])
      expect(w.asked).toEqual([])
      expect((await w.call("user_owner", "PUT", w.base, SETTINGS)).status).toBe(200)
    }
  })

  // The owner check is made from the row as it was read AND again from the row as
  // it is, under the lock. An admin's "same value" must not become a change
  // because an owner's landed between the two.
  it("checks the owner against the row under the lock, not only the one it read", async () => {
    const stored = {
      preset: "okta",
      issuer: ISSUER,
      tokenEndpoint: TOKEN,
      clientId: OTHER_CLIENT,
      enabled: false,
    }
    const w = app({ config: { oidcMail: stored } })
    const real = w.store.store.connection
    // The route reads a row where the client id is already the one being sent.
    w.store.store.connection = async (tenantId, id) => {
      const row = await real(tenantId, id)
      return row
        ? { ...row, config: { oidcMail: { ...stored, clientId: CLIENT } } }
        : row
    }
    const res = await w.call("user_admin", "PUT", w.base, {
      clientId: CLIENT,
      enabled: false,
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { message: string }).message).toMatch(/owner/)
    expect(w.stored().clientId).toBe(OTHER_CLIENT)
    expect(w.store.events).toEqual([])
    expect(w.revoked).toEqual([])
  })

  it("lets an admin turn it OFF on a live connection, and nothing else", async () => {
    const w = app({ status: "active" })
    expect(
      (await w.call("user_owner", "PUT", w.base, { ...SETTINGS, enabled: true }))
        .status,
    ).toBe(200)
    expect(w.stored().enabled).toBe(true)

    expect((await w.call("user_admin", "PUT", w.base, { enabled: false })).status).toBe(
      200,
    )
    expect(w.stored().enabled).toBe(false)
    // Off and a setting at once is a change of setting.
    expect(
      (
        await w.call("user_admin", "PUT", w.base, {
          enabled: false,
          clientId: OTHER_CLIENT,
        })
      ).status,
    ).toBe(403)
    expect(w.stored().clientId).toBe(CLIENT)
  })

  it("is only for a provider that has the lane, and says so on the record", async () => {
    for (const provider of ["entra", "google", "onelogin", "something-new"]) {
      const w = app({ provider })
      const res = await w.call("user_owner", "PUT", w.base, {
        ...SETTINGS,
        preset: "generic",
      })
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({
        name: "oidc_mail_refused",
        reason: "not_supported",
      })
      expect(w.stored()).toEqual({})
      expect(w.last()).toMatchObject({
        type: "connection.oidc_mail_refused",
        reason: "not_supported",
      })
      expect(w.revoked).toEqual([])
      expect(w.asked).toEqual([])
      expect(await body(await w.call("user_owner", "GET", w.base))).toMatchObject({
        available: false,
        defaultPreset: null,
      })
    }
  })

  it("refuses to enable while a setting is missing", async () => {
    const w = app()
    await w.call("user_owner", "PUT", w.base, { issuer: ISSUER })
    const res = await w.call("user_owner", "PUT", w.base, { enabled: true })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ reason: "incomplete" })
    expect(w.stored().enabled).toBeFalsy()
    expect(w.last()).toMatchObject({
      type: "connection.oidc_mail_refused",
      reason: "incomplete",
    })
  })

  // ⚠ ONE PLACE FOR A CONNECTION'S PASSWORDS.
  it("refuses to turn on while LDAP pass-through is on", async () => {
    const w = app({ config: { ldap: { host: "ldap.acme.test", enabled: true } } })
    await w.call("user_owner", "PUT", w.base, SETTINGS)
    const res = await w.call("user_owner", "PUT", w.base, { enabled: true })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ reason: "ldap_enabled" })
    expect(w.stored().enabled).toBeFalsy()
    // The settings may be prepared while LDAP is on; it is turning on that is refused.
    expect(w.stored()).toMatchObject(SETTINGS)
  })

  it("refuses the same move in the same request that sets the settings", async () => {
    const w = app({ config: { ldap: { enabled: true } } })
    const res = await w.call("user_owner", "PUT", w.base, {
      ...SETTINGS,
      enabled: true,
    })
    expect(res.status).toBe(409)
    expect(w.stored()).toEqual({})
  })

  it("validates what it is given, the way authd will, before it asks anyone", async () => {
    const w = app()
    for (const b of [
      { issuer: "http://acme.okta.com/oauth2/default" },
      // The org authorization server has no password grant.
      { issuer: "https://acme.okta.com" },
      { issuer: "https://acme.okta.com/oauth2/default/v1/token" },
      { issuer: "https://127.0.0.1/oauth2/default" },
      { issuer: "https://acme.okta.com:8443/oauth2/default" },
      { issuer: "https://user:pw@acme.okta.com/oauth2/default" },
      { clientId: "nope" },
      { clientId: "00u1b2c3d4e5f6g7h8i9" },
      { preset: "azure" },
      // OneLogin's password grant needs a client secret.
      { preset: "onelogin" },
      { extra: { realm: "x" } },
      { extra: { client_secret: "s" } },
      { extra: { password: "s" } },
      { enabled: "yes" },
      // Nothing secret is taken, and the token endpoint is never typed.
      { clientSecret: "s" },
      { tokenEndpoint: "https://evil.example.org/token" },
      {},
    ]) {
      const res = await w.call("user_owner", "PUT", w.base, b)
      expect(res.status).toBe(422)
    }
    expect(w.stored()).toEqual({})
    expect(w.store.events).toEqual([])
    expect(w.asked).toEqual([])
  })
})

describe("OIDC mail settings: the token endpoint is read, not typed", () => {
  it("reads it from the issuer's discovery document, once, and stores it", async () => {
    const w = app()
    const res = await w.call("user_owner", "PUT", w.base, SETTINGS)
    expect(res.status).toBe(200)
    expect(w.asked).toEqual([`${ISSUER}/.well-known/openid-configuration`])
    expect(w.stored()).toMatchObject({ issuer: ISSUER, tokenEndpoint: TOKEN })
    expect(await body(res)).toMatchObject({ tokenEndpoint: TOKEN })
  })

  it("does not ask again for a client id, or for turning it on or off", async () => {
    const w = app()
    await w.call("user_owner", "PUT", w.base, SETTINGS)
    w.asked.length = 0
    await w.call("user_owner", "PUT", w.base, { clientId: OTHER_CLIENT })
    await w.call("user_owner", "PUT", w.base, { enabled: true })
    await w.call("user_admin", "PUT", w.base, { enabled: false })
    expect(w.asked).toEqual([])
    expect(w.stored().tokenEndpoint).toBe(TOKEN)
  })

  it("asks again when the issuer, the preset or the extra fields change", async () => {
    const w = app({ provider: "generic" })
    await w.call("user_owner", "PUT", w.base, { issuer: KC_ISSUER, clientId: "mail" })
    w.asked.length = 0
    await w.call("user_owner", "PUT", w.base, { preset: "keycloak" })
    await w.call("user_owner", "PUT", w.base, { extra: { scope: "openid email" } })
    await w.call("user_owner", "PUT", w.base, {
      issuer: "https://sso.acme.example/realms/other",
    })
    expect(w.asked).toEqual([
      `${KC_ISSUER}/.well-known/openid-configuration`,
      `${KC_ISSUER}/.well-known/openid-configuration`,
      "https://sso.acme.example/realms/other/.well-known/openid-configuration",
    ])
  })

  it("takes the token endpoint a Keycloak realm names, as it names it", async () => {
    const w = app({
      provider: "generic",
      discovery: () => json(doc(KC_ISSUER, { token_endpoint: KC_TOKEN })),
    })
    const res = await w.call("user_owner", "PUT", w.base, {
      preset: "keycloak",
      issuer: KC_ISSUER,
      clientId: "mail-client",
      enabled: true,
    })
    expect(res.status).toBe(200)
    expect(w.stored()).toEqual({
      preset: "keycloak",
      issuer: KC_ISSUER,
      clientId: "mail-client",
      tokenEndpoint: KC_TOKEN,
      enabled: true,
    })
  })

  // ⚠ THE PROVIDER'S DOCUMENT DOES NOT GET TO PICK WHERE PASSWORDS GO.
  it("refuses a document whose token endpoint is on another host, and stores nothing", async () => {
    for (const token_endpoint of [
      "https://evil.example.org/oauth2/default/v1/token",
      "https://evil.okta.com/oauth2/default/v1/token",
      "http://acme.okta.com/oauth2/default/v1/token",
    ]) {
      const w = app({ discovery: () => json(doc(ISSUER, { token_endpoint })) })
      const res = await w.call("user_owner", "PUT", w.base, {
        ...SETTINGS,
        enabled: true,
      })
      expect(res.status).toBe(422)
      expect(w.stored()).toEqual({})
      expect(w.store.events).toEqual([])
      expect(w.revoked).toEqual([])
    }
    const w = app({
      discovery: () =>
        json(doc(ISSUER, { token_endpoint: "https://evil.example.org/t" })),
    })
    expect(
      (await body(await w.call("user_owner", "PUT", w.base, SETTINGS)))
        .message as string,
    ).toMatch(/not on the issuer's host acme\.okta\.com/)
  })

  it("refuses a provider that says it has no password grant, in words", async () => {
    const w = app({
      discovery: () =>
        json(doc(ISSUER, { grant_types_supported: ["authorization_code"] })),
    })
    const res = await w.call("user_owner", "PUT", w.base, SETTINGS)
    expect(res.status).toBe(422)
    expect((await body(res)).message).toMatch(/password grant/)
    expect(w.stored()).toEqual({})
  })

  it("is a 422 for a document that is wrong and a 503 for a provider that cannot be reached", async () => {
    for (const discovery of [
      () => new Response("", { status: 404 }),
      () => new Response("<html>", { status: 200 }),
      () => json({}),
      () =>
        new Response("", {
          status: 302,
          headers: { location: "https://elsewhere.example/" },
        }),
    ]) {
      const w = app({ discovery })
      expect((await w.call("user_owner", "PUT", w.base, SETTINGS)).status).toBe(422)
      expect(w.stored()).toEqual({})
    }
    for (const discovery of [
      () => new Response("", { status: 503 }),
      () => {
        throw new IdpUnreachable("10.0.0.1 is not public", "blocked")
      },
    ]) {
      const w = app({ discovery })
      const res = await w.call("user_owner", "PUT", w.base, SETTINGS)
      expect(res.status).toBe(503)
      const answer = await body(res)
      expect(answer).toMatchObject({ name: "idp_unreachable" })
      // Words of ours: the guard's reason can name an address.
      expect(JSON.stringify(answer)).not.toContain("10.0.0.1")
      expect(w.stored()).toEqual({})
      expect(w.store.events).toEqual([])
      expect(w.revoked).toEqual([])
    }
  })

  // The provider is asked before the row is locked; what it said belongs to the
  // issuer it was asked about.
  it("will not use what a provider said about an issuer the row no longer has", async () => {
    const stored = {
      preset: "okta",
      issuer: "https://other.okta.com/oauth2/default",
      tokenEndpoint: "https://other.okta.com/oauth2/default/v1/token",
      clientId: CLIENT,
    }
    const w = app({ config: { oidcMail: stored } })
    const real = w.store.store.connection
    // The route reads a row that already has the issuer being sent, so it does not
    // ask; the row under the lock does not.
    w.store.store.connection = async (tenantId, id) => {
      const row = await real(tenantId, id)
      return row
        ? {
            ...row,
            config: { oidcMail: { ...stored, issuer: ISSUER, tokenEndpoint: TOKEN } },
          }
        : row
    }
    const res = await w.call("user_owner", "PUT", w.base, { issuer: ISSUER })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ reason: "stale" })
    expect(w.stored()).toMatchObject({
      issuer: "https://other.okta.com/oauth2/default",
    })
  })
})

describe("OIDC mail settings: a row that moves while the provider is asked", () => {
  // ⚠ DISCOVERY WAS FOR ISSUER A, THE ROW NOW SAYS B, and the request names no
  // issuer, so nothing in the body tells the lock. B must not be saved with A's
  // token endpoint: a row that says one host and sends passwords to another.
  it("will not attach one issuer's token endpoint to another's row", async () => {
    const A = "https://a.okta.com/oauth2/default"
    const B = "https://b.okta.com/oauth2/default"
    const row = (issuer: string) => ({
      preset: "okta",
      issuer,
      tokenEndpoint: `${issuer}/v1/token`,
      clientId: CLIENT,
      enabled: false,
    })
    const w = app({ provider: "generic", config: { oidcMail: row(B) } })
    const real = w.store.store.connection
    // The route reads the row as it was a moment ago: A.
    w.store.store.connection = async (tenantId, id) => {
      const stored = await real(tenantId, id)
      return stored ? { ...stored, config: { oidcMail: row(A) } } : stored
    }
    const res = await w.call("user_owner", "PUT", w.base, { preset: "keycloak" })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ reason: "stale" })
    // It asked about A, as it was told, and saved nothing for B.
    expect(w.asked).toEqual([`${A}/.well-known/openid-configuration`])
    expect(w.stored()).toEqual(row(B))
    expect(w.revoked).toEqual([])
  })
})

describe("OIDC mail settings: changes", () => {
  it("sets the settings and turns them on in one request, and revokes cached passwords", async () => {
    const w = app({ status: "active" })
    const res = await w.call("user_owner", "PUT", w.base, {
      issuer: `${ISSUER}/`,
      clientId: CLIENT,
      enabled: true,
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      preset: "okta",
      defaultPreset: "okta",
      issuer: ISSUER,
      clientId: CLIENT,
      tokenEndpoint: TOKEN,
      extra: {},
      enabled: true,
      available: true,
      ldapEnabled: false,
    })
    expect(w.stored()).toEqual({
      preset: "okta",
      issuer: ISSUER,
      clientId: CLIENT,
      tokenEndpoint: TOKEN,
      enabled: true,
    })
    expect(w.revoked).toEqual([CONNECTION])
    expect(events(w, "connection.oidc_mail_updated")).toHaveLength(1)
    expect(w.last()).toMatchObject({
      type: "connection.oidc_mail_updated",
      actorUserId: "user_owner",
      connectionId: CONNECTION,
      data: {
        changed: ["issuer", "clientId"],
        trust: true,
        status: "active",
        enabled: { from: false, to: true },
        to: { issuer: ISSUER, clientId: CLIENT, tokenEndpoint: TOKEN },
        cachedPasswordsRevoked: true,
      },
    })
  })

  it("lists the presets with words, for the console to draw", async () => {
    const w = app()
    const view = await body(await w.call("user_owner", "GET", w.base))
    const presets = view.presets as Array<{
      id: string
      label: string
      extras: Array<{ key: string }>
    }>
    expect(presets.map((p) => p.id)).toEqual([
      "okta",
      "keycloak",
      "auth0",
      "ping",
      "fusionauth",
      "generic",
    ])
    expect(presets.find((p) => p.id === "auth0")?.extras.map((e) => e.key)).toEqual([
      "audience",
      "realm",
      "scope",
    ])
    // Words, never a rule.
    expect(JSON.stringify(presets)).not.toMatch(/\^|\\\\/)
  })

  it("lets an owner pick another preset than the provider's default", async () => {
    const w = app({
      provider: "generic",
      discovery: () =>
        json(
          doc("https://acme.auth0.com", {
            token_endpoint: "https://acme.auth0.com/oauth/token",
          }),
        ),
    })
    const res = await w.call("user_owner", "PUT", w.base, {
      preset: "auth0",
      issuer: "https://acme.auth0.com/",
      clientId: "Zk3q9XvYw0aB5cD7",
      extra: { realm: "Employees", audience: "https://mail", scope: "" },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      preset: "auth0",
      defaultPreset: "generic",
      extra: { realm: "Employees", audience: "https://mail" },
    })
    expect(w.stored()).toMatchObject({
      preset: "auth0",
      issuer: "https://acme.auth0.com",
      tokenEndpoint: "https://acme.auth0.com/oauth/token",
      extra: { realm: "Employees", audience: "https://mail" },
    })
  })

  it("turns itself off when a setting changes, and again needs an explicit yes", async () => {
    const w = app()
    await w.call("user_owner", "PUT", w.base, { ...SETTINGS, enabled: true })
    expect(w.stored().enabled).toBe(true)

    await w.call("user_owner", "PUT", w.base, { clientId: OTHER_CLIENT })
    expect(w.stored()).toEqual({
      preset: "okta",
      issuer: ISSUER,
      clientId: OTHER_CLIENT,
      tokenEndpoint: TOKEN,
      enabled: false,
    })
    expect(w.revoked).toEqual([CONNECTION, CONNECTION])

    // A new issuer and the yes together are one move.
    await w.call("user_owner", "PUT", w.base, {
      issuer: "https://acme.oktapreview.com/oauth2/default",
      enabled: true,
    })
    expect(w.stored()).toMatchObject({
      issuer: "https://acme.oktapreview.com/oauth2/default",
      tokenEndpoint: "https://acme.oktapreview.com/oauth2/default/v1/token",
      enabled: true,
    })
  })

  it("clears the extra fields of a preset it leaves, unless told otherwise", async () => {
    const w = app({
      provider: "generic",
      config: {
        oidcMail: {
          preset: "auth0",
          issuer: KC_ISSUER,
          tokenEndpoint: KC_TOKEN,
          clientId: "mail",
          extra: { realm: "Employees" },
          enabled: false,
        },
      },
      discovery: () => json(doc(KC_ISSUER, { token_endpoint: KC_TOKEN })),
    })
    expect(
      (await w.call("user_owner", "PUT", w.base, { preset: "keycloak" })).status,
    ).toBe(200)
    expect(w.stored()).toMatchObject({ preset: "keycloak", extra: {} })
    expect(w.last()).toMatchObject({ data: { changed: ["preset", "extra"] } })
  })

  it("revokes on turning it off, since that is what an owner wants done now", async () => {
    const w = app()
    await w.call("user_owner", "PUT", w.base, { ...SETTINGS, enabled: true })
    w.revoked.length = 0
    await w.call("user_admin", "PUT", w.base, { enabled: false })
    expect(w.stored().enabled).toBe(false)
    expect(w.revoked).toEqual([CONNECTION])
    expect(w.last()).toMatchObject({
      data: { changed: [], trust: false, enabled: { from: true, to: false } },
    })
  })

  it("does nothing, and says nothing, when nothing changes", async () => {
    const w = app()
    await w.call("user_owner", "PUT", w.base, { ...SETTINGS, enabled: true })
    const before = w.store.events.length
    w.revoked.length = 0
    w.asked.length = 0
    expect(
      (await w.call("user_owner", "PUT", w.base, { ...SETTINGS, enabled: true }))
        .status,
    ).toBe(200)
    expect(w.store.events).toHaveLength(before)
    expect(w.revoked).toEqual([])
    expect(w.asked).toEqual([])
    expect(w.stored().enabled).toBe(true)
  })

  it("keeps what else is in the connection's config", async () => {
    const w = app({
      config: {
        oidc: { issuer: "https://acme.okta.com" },
        ldap: { host: "ldap.acme.test" },
        // Another feature's state under another key is not this route's to touch.
        oktaEventHook: { verifiedAt: "2026-11-07T00:00:00Z" },
        oidcMail: { note: "kept" },
      },
    })
    await w.call("user_owner", "PUT", w.base, { ...SETTINGS, enabled: true })
    expect(w.config()).toEqual({
      oidc: { issuer: "https://acme.okta.com" },
      ldap: { host: "ldap.acme.test" },
      oktaEventHook: { verifiedAt: "2026-11-07T00:00:00Z" },
      oidcMail: {
        note: "kept",
        preset: "okta",
        issuer: ISSUER,
        clientId: CLIENT,
        tokenEndpoint: TOKEN,
        enabled: true,
      },
    })
  })

  // The change is made; failing to revoke is on record, not an error to retry.
  it("keeps the change and records it when the epochs cannot be raised", async () => {
    const w = app({
      invalidate: async () => {
        throw new Error("db down: password=hunter2")
      },
    })
    const res = await w.call("user_owner", "PUT", w.base, {
      ...SETTINGS,
      enabled: true,
    })
    expect(res.status).toBe(200)
    expect(w.stored().enabled).toBe(true)
    expect(w.last()).toMatchObject({ data: { cachedPasswordsRevoked: false } })
    expect(w.errors).toHaveLength(1)
    // The error's name, never its message.
    expect(JSON.stringify(w.errors)).not.toContain("hunter2")
  })

  it("shows what is set, and that LDAP is on, without anything secret", async () => {
    const w = app({ config: { ldap: { enabled: true } } })
    expect(await body(await w.call("user_admin", "GET", w.base))).toMatchObject({
      preset: "okta",
      defaultPreset: "okta",
      issuer: null,
      clientId: null,
      tokenEndpoint: null,
      extra: {},
      enabled: false,
      available: true,
      ldapEnabled: true,
    })
  })
})

describe("OIDC mail settings: a row from before the lane was generic", () => {
  const legacy = { issuer: ISSUER, clientId: CLIENT, enabled: true }

  it("is shown as the okta preset, on", async () => {
    const w = app({ config: { oktaMail: legacy } })
    expect(await body(await w.call("user_admin", "GET", w.base))).toMatchObject({
      preset: "okta",
      issuer: ISSUER,
      clientId: CLIENT,
      tokenEndpoint: TOKEN,
      enabled: true,
    })
    // Reading changes nothing.
    expect(w.config()).toEqual({ oktaMail: legacy })
  })

  it("is replaced by the next write, and an admin may still turn it off", async () => {
    const w = app({ config: { oktaMail: legacy } })
    expect((await w.call("user_admin", "PUT", w.base, { enabled: false })).status).toBe(
      200,
    )
    expect(w.config()).toEqual({
      oidcMail: {
        preset: "okta",
        issuer: ISSUER,
        clientId: CLIENT,
        tokenEndpoint: TOKEN,
        enabled: false,
      },
    })
    expect(w.revoked).toEqual([CONNECTION])
    expect(w.asked).toEqual([])
  })

  it("is migrated by an owner's change, which turns it off, and the old key goes", async () => {
    const w = app({ config: { oktaMail: legacy, ldap: { enabled: false } } })
    expect(w.stored().enabled).toBe(true)
    expect(
      (await w.call("user_owner", "PUT", w.base, { clientId: OTHER_CLIENT })).status,
    ).toBe(200)
    expect(w.config()).not.toHaveProperty("oktaMail")
    expect(w.stored()).toMatchObject({ clientId: OTHER_CLIENT, enabled: false })
  })

  it("does not let an old key on another provider's connection count as a lane", async () => {
    const w = app({ provider: "generic", config: { oktaMail: legacy } })
    expect(w.stored()).toEqual({})
  })
})
