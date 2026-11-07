import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { mountIdentity } from "../src/routes/console/identity.js"
import type { ConsoleDeps } from "../src/routes/console/deps.js"
import type { Role } from "../src/console/roles.js"
import type { Connection } from "../src/identity/model.js"
import { storedOktaMail } from "../src/identity/okta-mail.js"
import {
  CONNECTION,
  TENANT,
  connection,
  memoryClerk,
  memoryStore,
} from "./identity-fakes.js"

/**
 * The console's Okta mail routes (#383): an owner's move on every status,
 * step-up on every write, validation that agrees with authd, one place for a
 * connection's passwords, and the cached passwords revoked on every change.
 */

const ROLES: Record<string, Role> = {
  user_owner: "owner",
  user_admin: "admin",
  user_m: "member",
}

const ISSUER = "https://acme.okta.com/oauth2/default"
const CLIENT = "0oa1b2c3d4e5f6g7h8i9"
const OTHER_CLIENT = "0oa9z8y7x6w5v4u3t2s1"
const SETTINGS = { issuer: ISSUER, clientId: CLIENT }

function app(
  options: {
    status?: Connection["status"]
    provider?: string
    config?: Record<string, unknown>
    fresh?: boolean
    wired?: boolean
    invalidate?: (connectionId: string) => Promise<void>
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
  const log = { ...console, error: (o: object) => errors.push(o), warn: () => {} }
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
              oktaMail: {
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
  const base = `/identity/connections/${CONNECTION}/okta-mail`
  return {
    store,
    call,
    base,
    revoked,
    errors,
    setFresh: (v: boolean) => (fresh = v),
    stored: () => storedOktaMail(store.connections.get(CONNECTION)!),
    config: () => store.connections.get(CONNECTION)!.config,
    last: () => store.events.at(-1),
  }
}

const events = (w: ReturnType<typeof app>, type: string) =>
  w.store.events.filter((e) => e.type === type)

describe("Okta mail settings: refusals", () => {
  it("needs a fresh step-up for a write, and changes nothing without it", async () => {
    const w = app({ fresh: false })
    expect((await w.call("user_owner", "PUT", w.base, SETTINGS)).status).toBe(403)
    expect(w.stored()).toEqual({})
    expect(w.store.events).toEqual([])
    expect(w.revoked).toEqual([])
    expect((await w.call("user_owner", "GET", w.base)).status).toBe(200)
  })

  it("is for admins: a member sees and changes nothing", async () => {
    const w = app()
    expect((await w.call("user_m", "GET", w.base)).status).toBe(403)
    expect((await w.call("user_m", "PUT", w.base, SETTINGS)).status).toBe(403)
    expect(w.stored()).toEqual({})
  })

  it("answers 404 for a malformed id and for another workspace's connection", async () => {
    const w = app()
    expect(
      (await w.call("user_admin", "GET", "/identity/connections/nope/okta-mail"))
        .status,
    ).toBe(404)
    const other = "99999999-9999-4999-8999-999999999999"
    expect(
      (await w.call("user_admin", "GET", `/identity/connections/${other}/okta-mail`))
        .status,
    ).toBe(404)
  })

  it("answers 501 where the deployment does not wire it", async () => {
    const w = app({ wired: false })
    expect((await w.call("user_owner", "GET", w.base)).status).toBe(501)
    expect((await w.call("user_owner", "PUT", w.base, SETTINGS)).status).toBe(501)
  })

  // ⚠ THE ISSUER IS WHERE EVERY MEMBER'S MAIL PASSWORD GOES. An owner's, on every
  // status - a draft included, unlike LDAP's.
  it("keeps every change and turning it on an owner's, whatever the status", async () => {
    for (const status of ["draft", "testing", "active", "disabled"] as const) {
      const w = app({ status })
      for (const body of [
        SETTINGS,
        { issuer: ISSUER },
        { clientId: CLIENT },
        { enabled: true },
      ]) {
        const res = await w.call("user_admin", "PUT", w.base, body)
        expect(res.status).toBe(403)
        expect(((await res.json()) as { message: string }).message).toMatch(/owner/)
      }
      expect(w.stored()).toEqual({})
      expect(w.store.events).toEqual([])
      expect(w.revoked).toEqual([])
      expect((await w.call("user_owner", "PUT", w.base, SETTINGS)).status).toBe(200)
    }
  })

  // The owner check is made from the row as it was read AND again from the row as
  // it is, under the lock. An admin's "same value" must not become a change
  // because an owner's landed between the two.
  it("checks the owner against the row under the lock, not only the one it read", async () => {
    const w = app({
      config: { oktaMail: { issuer: ISSUER, clientId: OTHER_CLIENT, enabled: false } },
    })
    const real = w.store.store.connection
    // The route reads a row where the client id is already the one being sent.
    w.store.store.connection = async (tenantId, id) => {
      const row = await real(tenantId, id)
      return row
        ? { ...row, config: { oktaMail: { issuer: ISSUER, clientId: CLIENT } } }
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

  it("is only for an Okta connection, and says so on the record", async () => {
    for (const provider of ["entra", "google", "generic"]) {
      const w = app({ provider })
      const res = await w.call("user_owner", "PUT", w.base, SETTINGS)
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({
        name: "okta_mail_refused",
        reason: "not_okta",
      })
      expect(w.stored()).toEqual({})
      expect(w.last()).toMatchObject({
        type: "connection.okta_mail_refused",
        reason: "not_okta",
      })
      expect(w.revoked).toEqual([])
      expect(
        (
          (await (await w.call("user_owner", "GET", w.base)).json()) as {
            available: boolean
          }
        ).available,
      ).toBe(false)
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
      type: "connection.okta_mail_refused",
      reason: "incomplete",
    })
  })

  // ⚠ ONE PLACE FOR A CONNECTION'S PASSWORDS.
  it("refuses to turn on while LDAP pass-through is on", async () => {
    const w = app({
      config: { ldap: { host: "ldap.acme.test", enabled: true } },
    })
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

  it("validates what it is given, the way authd will", async () => {
    const w = app()
    for (const body of [
      { issuer: "http://acme.okta.com/oauth2/default" },
      { issuer: "https://acme.okta.com" },
      { issuer: "https://127.0.0.1/oauth2/default" },
      { issuer: "https://acme.okta.com:8443/oauth2/default" },
      { issuer: "https://user:pw@acme.okta.com/oauth2/default" },
      { clientId: "nope" },
      { clientId: "00u1b2c3d4e5f6g7h8i9" },
      { enabled: "yes" },
      // Nothing secret is taken.
      { clientSecret: "s" },
      {},
    ]) {
      const res = await w.call("user_owner", "PUT", w.base, body)
      expect(res.status).toBe(422)
    }
    expect(w.stored()).toEqual({})
    expect(w.store.events).toEqual([])
  })
})

describe("Okta mail settings: changes", () => {
  it("sets the settings and turns them on in one request, and revokes cached passwords", async () => {
    const w = app({ status: "active" })
    const res = await w.call("user_owner", "PUT", w.base, {
      issuer: `${ISSUER}/`,
      clientId: CLIENT,
      enabled: true,
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      issuer: ISSUER,
      clientId: CLIENT,
      enabled: true,
      available: true,
      ldapEnabled: false,
    })
    expect(w.stored()).toEqual({ issuer: ISSUER, clientId: CLIENT, enabled: true })
    expect(w.revoked).toEqual([CONNECTION])
    expect(events(w, "connection.okta_mail_updated")).toHaveLength(1)
    expect(w.last()).toMatchObject({
      type: "connection.okta_mail_updated",
      actorUserId: "user_owner",
      connectionId: CONNECTION,
      data: {
        changed: ["issuer", "clientId"],
        trust: true,
        status: "active",
        enabled: { from: false, to: true },
        to: { issuer: ISSUER, clientId: CLIENT },
        cachedPasswordsRevoked: true,
      },
    })
  })

  it("turns itself off when a setting changes, and again needs an explicit yes", async () => {
    const w = app()
    await w.call("user_owner", "PUT", w.base, { ...SETTINGS, enabled: true })
    expect(w.stored().enabled).toBe(true)

    await w.call("user_owner", "PUT", w.base, { clientId: OTHER_CLIENT })
    expect(w.stored()).toEqual({
      issuer: ISSUER,
      clientId: OTHER_CLIENT,
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
      enabled: true,
    })
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
    expect(
      (await w.call("user_owner", "PUT", w.base, { ...SETTINGS, enabled: true }))
        .status,
    ).toBe(200)
    expect(w.store.events).toHaveLength(before)
    expect(w.revoked).toEqual([])
    expect(w.stored().enabled).toBe(true)
  })

  it("keeps what else is in the connection's config, and in its own object", async () => {
    const w = app({
      config: {
        oidc: { issuer: "https://acme.okta.com" },
        ldap: { host: "ldap.acme.test" },
        // Another feature's state under the same key is not this route's to drop.
        oktaMail: { hook: { verifiedAt: "2026-11-07T00:00:00Z" } },
      },
    })
    await w.call("user_owner", "PUT", w.base, { ...SETTINGS, enabled: true })
    expect(w.config()).toEqual({
      oidc: { issuer: "https://acme.okta.com" },
      ldap: { host: "ldap.acme.test" },
      oktaMail: {
        hook: { verifiedAt: "2026-11-07T00:00:00Z" },
        issuer: ISSUER,
        clientId: CLIENT,
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
    expect(await (await w.call("user_admin", "GET", w.base)).json()).toEqual({
      issuer: null,
      clientId: null,
      enabled: false,
      available: true,
      ldapEnabled: true,
    })
  })
})
