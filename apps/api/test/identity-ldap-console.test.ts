import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { mountIdentity } from "../src/routes/console/identity.js"
import type { ConsoleDeps } from "../src/routes/console/deps.js"
import type { Role } from "../src/console/roles.js"
import type { Connection } from "../src/identity/model.js"
import type { LdapProbe, ProbeInput, ProbeOutcome } from "../src/identity/ldap-probe.js"
import { fixedWindow } from "../src/identity/rate-limit.js"
import { sealedLdap, storedLdap } from "../src/identity/ldap.js"
import {
  CONNECTION,
  TENANT,
  connection,
  log,
  memoryClerk,
  memoryStore,
} from "./identity-fakes.js"

/**
 * The console's LDAP pass-through routes (#344): the trust rule, step-up on
 * every write, the 24-hour test before enabling, secrets that are write-only,
 * and validation that refuses plaintext, odd ports and private hosts.
 */

const CA = `-----BEGIN CERTIFICATE-----
MIIBiDCCAS2gAwIBAgIUB/9/PRgguQTaVcSCxP9YQrvQs1MwCgYIKoZIzj0EAwIw
GTEXMBUGA1UEAwwObGRhcC5hY21lLnRlc3QwHhcNMjYxMDI0MDA1MTM1WhcNMzYx
MDIxMDA1MTM1WjAZMRcwFQYDVQQDDA5sZGFwLmFjbWUudGVzdDBZMBMGByqGSM49
AgEGCCqGSM49AwEHA0IABFLKke0C1X2+e1LlyrVTGGj5orhcuF5zTGhtEyGScIrV
v0L27olf8GVJKOPkUvDiUKCTaIcpKYt/+xJ8+tkiYlKjUzBRMB0GA1UdDgQWBBTy
WgvPO19u8YTNWH4DxV1hwmlYFTAfBgNVHSMEGDAWgBTyWgvPO19u8YTNWH4DxV1h
wmlYFTAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0kAMEYCIQDJWNOXFwK9
rSrAO7Z47uYrErNhe65DB2UAzktErv66mAIhALZF4D4QJG2wf9YRiBkToUSzUedp
xOCcQzq7MyszPrrS
-----END CERTIFICATE-----`

const ROLES: Record<string, Role> = {
  user_owner: "owner",
  user_admin: "admin",
  user_m: "member",
}

const SETTINGS = {
  host: "ldap.acme.test",
  port: 636,
  tlsMode: "ldaps",
  searchBase: "ou=people,dc=acme,dc=test",
  userFilter: "(mail={email})",
}
const SERVICE = {
  bindDn: "cn=i10,ou=services,dc=acme,dc=test",
  bindSecret: "s3cret-svc",
}

function app(
  options: {
    status?: Connection["status"]
    fresh?: boolean
    outcome?: ProbeOutcome
    now?: () => Date
    onRun?: (input: ProbeInput) => void | Promise<void>
  } = {},
) {
  const store = memoryStore({
    connections: [connection({ status: options.status ?? "draft" })],
  })
  const runs: ProbeInput[] = []
  const state = { outcome: options.outcome ?? ({ result: "ok" } as ProbeOutcome) }
  const probe: LdapProbe = {
    async run(input) {
      runs.push(input)
      await options.onRun?.(input)
      return state.outcome
    },
  }
  let fresh = options.fresh ?? true
  const clock = { now: new Date("2026-10-24T12:00:00Z") }
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
        ldap: {
          probe,
          take: fixedWindow(null),
          now: options.now ?? (() => clock.now),
        },
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
  const base = `/identity/connections/${CONNECTION}/ldap`
  return {
    store,
    runs,
    state,
    call,
    base,
    clock,
    setFresh: (v: boolean) => (fresh = v),
    stored: () => storedLdap(store.connections.get(CONNECTION)!),
    sealed: () => sealedLdap(store.secrets.get(CONNECTION) ?? {}),
    last: () => store.events.at(-1),
    /** Settings, service account and a passing test: ready to enable. */
    ready: async (as_ = "user_admin") => {
      await call(as_, "PUT", base, SETTINGS)
      await call(as_, "PUT", `${base}/service`, SERVICE)
      await call(as_, "POST", `${base}/test`, { address: "ada@acme.test" })
    },
  }
}

const events = (w: ReturnType<typeof app>, type: string) =>
  w.store.events.filter((e) => e.type === type)

describe("LDAP pass-through settings: refusals", () => {
  it("needs a fresh step-up for every write, and changes nothing without it", async () => {
    const w = app({ fresh: false })
    for (const [method, path, body] of [
      ["PUT", w.base, SETTINGS],
      ["PUT", `${w.base}/service`, SERVICE],
      ["POST", `${w.base}/test`, { address: "ada@acme.test" }],
    ] as const)
      expect((await w.call("user_owner", method, path, body)).status).toBe(403)
    expect(w.stored()).toEqual({})
    expect(w.sealed()).toEqual({})
    expect(w.runs).toEqual([])
    expect(w.store.events).toEqual([])
    expect((await w.call("user_owner", "GET", w.base)).status).toBe(200)
  })

  it("is for admins: a member sees and changes nothing", async () => {
    const w = app()
    expect((await w.call("user_m", "GET", w.base)).status).toBe(403)
    expect((await w.call("user_m", "PUT", w.base, SETTINGS)).status).toBe(403)
    expect((await w.call("user_m", "PUT", `${w.base}/service`, SERVICE)).status).toBe(
      403,
    )
    expect(
      (await w.call("user_m", "POST", `${w.base}/test`, { address: "a@acme.test" }))
        .status,
    ).toBe(403)
    expect(w.stored()).toEqual({})
    expect(w.runs).toEqual([])
  })

  it("answers 404 for a malformed id and for another workspace's connection", async () => {
    const w = app()
    expect(
      (await w.call("user_admin", "GET", "/identity/connections/nope/ldap")).status,
    ).toBe(404)
    const other = "99999999-9999-4999-8999-999999999999"
    expect(
      (await w.call("user_admin", "GET", `/identity/connections/${other}/ldap`)).status,
    ).toBe(404)
  })

  it("keeps an active connection's directory an owner's: an admin changes, sets and enables nothing", async () => {
    const w = app({ status: "active" })
    for (const [method, path, body] of [
      ["PUT", w.base, SETTINGS],
      ["PUT", w.base, { enabled: true }],
      ["PUT", `${w.base}/service`, SERVICE],
    ] as const) {
      const res = await w.call("user_admin", method, path, body)
      expect(res.status).toBe(403)
      expect(((await res.json()) as { message: string }).message).toMatch(/owner/)
    }
    expect(w.stored()).toEqual({})
    expect(w.sealed()).toEqual({})
    expect(w.store.events).toEqual([])
    // The same moves are an owner's.
    expect((await w.call("user_owner", "PUT", w.base, SETTINGS)).status).toBe(200)
    expect(
      (await w.call("user_owner", "PUT", `${w.base}/service`, SERVICE)).status,
    ).toBe(200)
  })

  it("is the same on a disabled connection (an active one, paused)", async () => {
    const w = app({ status: "disabled" })
    expect((await w.call("user_admin", "PUT", w.base, SETTINGS)).status).toBe(403)
    expect((await w.call("user_owner", "PUT", w.base, SETTINGS)).status).toBe(200)
  })

  it("lets an admin on a draft connection set it up, since nobody signs in through it", async () => {
    const w = app({ status: "draft" })
    expect((await w.call("user_admin", "PUT", w.base, SETTINGS)).status).toBe(200)
    expect(
      (await w.call("user_admin", "PUT", `${w.base}/service`, SERVICE)).status,
    ).toBe(200)
  })

  it("lets an admin turn pass-through OFF on a live connection, and nothing else", async () => {
    const w = app({ status: "active" })
    await w.ready("user_owner")
    expect((await w.call("user_owner", "PUT", w.base, { enabled: true })).status).toBe(
      200,
    )
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
          searchBase: "dc=x",
        })
      ).status,
    ).toBe(403)
  })

  it("refuses to enable without a test, and says so in the audit log", async () => {
    const w = app()
    await w.call("user_admin", "PUT", w.base, SETTINGS)
    await w.call("user_admin", "PUT", `${w.base}/service`, SERVICE)
    const res = await w.call("user_admin", "PUT", w.base, { enabled: true })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({
      name: "ldap_refused",
      reason: "not_tested",
    })
    expect(w.stored().enabled).toBeFalsy()
    expect(w.last()).toMatchObject({
      type: "connection.ldap_refused",
      reason: "not_tested",
    })
  })

  it("refuses to enable while a setting is missing", async () => {
    const w = app()
    await w.call("user_admin", "PUT", w.base, { host: "ldap.acme.test" })
    const res = await w.call("user_admin", "PUT", w.base, { enabled: true })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ reason: "incomplete" })
  })

  it("refuses to enable on a test older than 24 hours", async () => {
    const w = app()
    await w.ready()
    expect(w.stored().testedAt).toBeTruthy()
    w.clock.now = new Date(w.clock.now.getTime() + 24 * 3600 * 1000 + 1000)
    const res = await w.call("user_admin", "PUT", w.base, { enabled: true })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ reason: "not_tested" })
    expect(
      (
        (await (await w.call("user_admin", "GET", w.base)).json()) as {
          tested: boolean
        }
      ).tested,
    ).toBe(false)
  })

  it("turns pass-through off and clears the test when any setting changes", async () => {
    const w = app()
    await w.ready()
    expect((await w.call("user_admin", "PUT", w.base, { enabled: true })).status).toBe(
      200,
    )
    expect(w.stored().enabled).toBe(true)

    expect(
      (
        await w.call("user_admin", "PUT", w.base, {
          searchBase: "ou=staff,dc=acme,dc=test",
        })
      ).status,
    ).toBe(200)
    expect(w.stored()).toMatchObject({ enabled: false, testedAt: null })
    // Untested settings cannot simply be switched back on.
    expect((await w.call("user_admin", "PUT", w.base, { enabled: true })).status).toBe(
      409,
    )
  })

  it("turns pass-through off and clears the test when the service account changes", async () => {
    const w = app()
    await w.ready()
    expect((await w.call("user_admin", "PUT", w.base, { enabled: true })).status).toBe(
      200,
    )
    await w.call("user_admin", "PUT", `${w.base}/service`, {
      ...SERVICE,
      bindSecret: "rotated",
    })
    expect(w.stored()).toMatchObject({ enabled: false, testedAt: null })
    expect((await w.call("user_admin", "PUT", w.base, { enabled: true })).status).toBe(
      409,
    )
    expect(events(w, "connection.secret_set").at(-1)).toMatchObject({
      data: { kind: "ldap_service", rotated: true, passthroughTurnedOff: true },
    })
  })

  it("does not record a pass for settings that changed while the test ran", async () => {
    const w = app({
      onRun: async () => {
        await w.call("user_admin", "PUT", w.base, {
          searchBase: "ou=staff,dc=acme,dc=test",
        })
      },
    })
    await w.call("user_admin", "PUT", w.base, SETTINGS)
    await w.call("user_admin", "PUT", `${w.base}/service`, SERVICE)
    const res = await w.call("user_admin", "POST", `${w.base}/test`, {
      address: "ada@acme.test",
    })
    expect(await res.json()).toEqual({ result: "ok", recorded: false })
    expect(w.stored().testedAt).toBeNull()
    expect((await w.call("user_admin", "PUT", w.base, { enabled: true })).status).toBe(
      409,
    )
  })

  // ⚠ ONE PLACE FOR A CONNECTION'S PASSWORDS (#383): identity-okta-mail.ts refuses
  // the other direction.
  it("refuses to enable while Okta mail sign-in is on, and says so on the record", async () => {
    const w = app()
    await w.ready()
    const row = w.store.connections.get(CONNECTION)!
    w.store.connections.set(CONNECTION, {
      ...row,
      config: { ...row.config, oktaMail: { enabled: true } },
    })
    const res = await w.call("user_admin", "PUT", w.base, { enabled: true })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({
      name: "ldap_refused",
      reason: "okta_enabled",
    })
    expect(w.stored().enabled).toBeFalsy()
    expect(w.last()).toMatchObject({
      type: "connection.ldap_refused",
      reason: "okta_enabled",
    })
    // Turned off, it is the same request that now works.
    w.store.connections.set(CONNECTION, {
      ...row,
      config: {
        ...w.store.connections.get(CONNECTION)!.config,
        oktaMail: { enabled: false },
      },
    })
    expect((await w.call("user_admin", "PUT", w.base, { enabled: true })).status).toBe(
      200,
    )
  })

  it("refuses to test before the settings are whole, without reaching out", async () => {
    const w = app()
    await w.call("user_admin", "PUT", w.base, SETTINGS)
    const res = await w.call("user_admin", "POST", `${w.base}/test`, {
      address: "ada@acme.test",
    })
    expect(res.status).toBe(409)
    expect(w.runs).toEqual([])
  })

  it("rate limits the test", async () => {
    const w = app()
    await w.call("user_admin", "PUT", w.base, SETTINGS)
    await w.call("user_admin", "PUT", `${w.base}/service`, SERVICE)
    let last = 0
    for (let i = 0; i < 11; i++)
      last = (
        await w.call("user_admin", "POST", `${w.base}/test`, {
          address: "ada@acme.test",
        })
      ).status
    expect(last).toBe(429)
    expect(w.runs.length).toBe(10)
  })

  it("validates every field: plaintext, odd ports, private hosts, stray keys, bad filters", async () => {
    const w = app()
    const bad: Record<string, unknown>[] = [
      { port: 22 },
      { port: 3268 },
      { port: "636" },
      { tlsMode: "none" },
      { tlsMode: "plain" },
      { host: "localhost" },
      { host: "127.0.0.1" },
      { host: "10.0.0.5" },
      { host: "169.254.169.254" },
      { host: "[::1]" },
      { host: "ldap" },
      { host: "ldap://ldap.acme.test" },
      { host: "ldap.acme.test:636" },
      { host: "a b.acme.test" },
      { caPem: "not a certificate" },
      { caPem: `${CA}\n-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----` },
      { caPem: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----" },
      { searchBase: "" },
      { searchBase: "dc=x\ndc=y" },
      { userFilter: "(mail=ada@acme.test)" },
      { userFilter: "mail={email}" },
      { userFilter: "(mail={email})(uid=*)" },
      { userFilter: "(|(mail={email})" },
      { userFilter: "(mail={email}))" },
      { enabled: "yes" },
      { bindDn: "cn=x" },
      {},
    ]
    for (const body of bad) {
      const res = await w.call("user_admin", "PUT", w.base, body)
      expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 422])
    }
    expect(w.stored()).toEqual({})
    expect(
      (
        await w.call("user_admin", "PUT", `${w.base}/service`, {
          bindDn: "",
          bindSecret: "x",
        })
      ).status,
    ).toBe(422)
    expect(
      (
        await w.call("user_admin", "PUT", `${w.base}/service`, {
          bindDn: "cn=x",
          bindSecret: "",
        })
      ).status,
    ).toBe(422)
    expect(
      (await w.call("user_admin", "PUT", `${w.base}/service`, { ...SERVICE, extra: 1 }))
        .status,
    ).toBe(422)
    expect(w.sealed()).toEqual({})
    // The test body: an address, and a password only if there is one.
    expect(
      (
        await w.call("user_admin", "POST", `${w.base}/test`, {
          address: "not-an-address",
        })
      ).status,
    ).toBe(422)
    expect(
      (
        await w.call("user_admin", "POST", `${w.base}/test`, {
          address: "a@acme.test",
          password: "",
        })
      ).status,
    ).toBe(422)
  })
})

describe("LDAP pass-through settings: the happy paths", () => {
  it("stores the settings and shows them back, but never the service account", async () => {
    const w = app()
    const put = await w.call("user_admin", "PUT", w.base, { ...SETTINGS, caPem: CA })
    expect(put.status).toBe(200)
    expect(await put.json()).toMatchObject({
      host: "ldap.acme.test",
      port: 636,
      tlsMode: "ldaps",
      caPem: CA,
      userFilter: "(mail={email})",
      enabled: false,
      serviceSet: false,
    })
    const service = await w.call("user_admin", "PUT", `${w.base}/service`, SERVICE)
    expect(service.status).toBe(200)
    const body = JSON.stringify(await service.json())
    expect(body).not.toContain(SERVICE.bindSecret)
    expect(body).not.toContain(SERVICE.bindDn)
    expect(
      JSON.stringify(await (await w.call("user_admin", "GET", w.base)).json()),
    ).not.toContain(SERVICE.bindSecret)
    // The connection list carries `config`; it must not carry the account.
    expect(JSON.stringify(w.store.connections.get(CONNECTION)!.config)).not.toContain(
      SERVICE.bindSecret,
    )
    expect(w.sealed()).toEqual(SERVICE)
  })

  it("lowercases the host and accepts a bracketless public IP literal", async () => {
    const w = app()
    const res = await w.call("user_admin", "PUT", w.base, { host: " LDAP.Acme.TEST " })
    expect((await res.json()) as { host: string }).toMatchObject({
      host: "ldap.acme.test",
    })
    expect(
      (
        await w.call("user_admin", "PUT", w.base, {
          host: "93.184.216.34",
          port: 389,
          tlsMode: "starttls",
        })
      ).status,
    ).toBe(200)
  })

  it("tests with the stored settings, reports a fixed code, and enables on a pass", async () => {
    const w = app()
    await w.call("user_admin", "PUT", w.base, SETTINGS)
    await w.call("user_admin", "PUT", `${w.base}/service`, SERVICE)
    const res = await w.call("user_admin", "POST", `${w.base}/test`, {
      address: "Ada@Acme.test",
      password: "ada-password",
    })
    expect(await res.json()).toEqual({ result: "ok", recorded: true })
    expect(w.runs[0]).toMatchObject({
      ...SETTINGS,
      ...SERVICE,
      caPem: null,
      address: "ada@acme.test",
      password: "ada-password",
    })
    expect((await w.call("user_admin", "PUT", w.base, { enabled: true })).status).toBe(
      200,
    )
    expect(w.stored()).toMatchObject({ enabled: true })
    expect(events(w, "connection.ldap_updated").at(-1)).toMatchObject({
      actorUserId: "user_admin",
      data: { enabled: { from: false, to: true } },
    })
  })

  it("answers each failure as its own code and records no pass", async () => {
    for (const result of [
      "unreachable",
      "tls_failed",
      "service_bind_failed",
      "user_not_found",
      "user_bind_failed",
    ] as const) {
      const w = app({ outcome: { result } })
      await w.call("user_admin", "PUT", w.base, SETTINGS)
      await w.call("user_admin", "PUT", `${w.base}/service`, SERVICE)
      const res = await w.call("user_admin", "POST", `${w.base}/test`, {
        address: "a@acme.test",
      })
      expect(await res.json()).toEqual({ result, recorded: false })
      expect(w.stored().testedAt).toBeFalsy()
      expect(
        (await w.call("user_admin", "PUT", w.base, { enabled: true })).status,
      ).toBe(409)
    }
  })

  it("audits without a secret, a password or an address", async () => {
    const w = app()
    await w.call("user_owner", "PUT", w.base, { ...SETTINGS, caPem: CA })
    await w.call("user_owner", "PUT", `${w.base}/service`, SERVICE)
    await w.call("user_owner", "POST", `${w.base}/test`, {
      address: "ada@acme.test",
      password: "ada-password",
    })
    await w.call("user_owner", "PUT", w.base, { enabled: true })
    const audit = JSON.stringify(w.store.events)
    for (const secret of [
      SERVICE.bindSecret,
      SERVICE.bindDn,
      "ada-password",
      "ada@acme.test",
      "BEGIN CERTIFICATE",
    ])
      expect(audit).not.toContain(secret)
    expect(events(w, "connection.ldap_tested").at(-1)).toMatchObject({
      reason: "ok",
      data: { userBind: true, recorded: true },
    })
    expect(events(w, "connection.ldap_updated")[0]).toMatchObject({
      actorUserId: "user_owner",
      data: { changed: expect.arrayContaining(["host", "caPem"]), trust: true },
    })
  })
})
