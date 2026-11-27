import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { createApp } from "../src/app.js"
import { mailDeviceService, type DeviceStorePort } from "../src/mail-devices/service.js"
import type { DeviceScope, MailDeviceRow } from "../src/mail-devices/store.js"
import type {
  ActiveOrgReader,
  FreshAuthReader,
  SessionVerifier,
  SsoGateReader,
} from "../src/middleware/session.js"
import type { TenantResolver } from "../src/middleware/tenant.js"
import type {
  ConsoleDeps,
  MailDeviceEnrollmentsDeps,
} from "../src/routes/console/deps.js"
import { mountMailDevices } from "../src/routes/console/mail-devices.js"

/**
 * The HTTP surface of mail devices (#383 PR 5): what each caller gets back, on
 * the console's routes and the public API's. The SQL boundary itself is proven
 * against Postgres in mail-devices-service-db.test.ts; the store here is a
 * memory fake with the same scope rule.
 */

const ACME = "11111111-1111-4111-8111-111111111111"
const RIVAL = "22222222-2222-4222-8222-222222222222"
const ADMIN = "user_admin"
const ADA = "user_ada"
const BOB = "user_bob"
const SOLO = "user_solo"

const accounts: Record<string, { email: string; tenantId: string | null }> = {
  [ADMIN]: { email: "admin@acme.test", tenantId: ACME },
  [ADA]: { email: "ada@acme.test", tenantId: ACME },
  [BOB]: { email: "bob@acme.test", tenantId: ACME },
  [SOLO]: { email: "solo@i10.test", tenantId: null },
}

const device = (id: string, person: string, tenantId = accounts[person]!.tenantId) =>
  ({
    id,
    clerkUserId: person,
    email: accounts[person]!.email,
    tenantId,
    platform: "ios",
    deviceName: "Phone",
    model: null,
    serial: null,
    createdBy: person,
    createdAt: new Date("2026-11-26T10:00:00Z"),
    firstUsedAt: null,
    lastUsedAt: null,
    hasCertKey: false,
  }) satisfies MailDeviceRow

const ids = {
  ada: "a0000000-0000-4000-8000-000000000001",
  bob: "b0000000-0000-4000-8000-000000000002",
  solo: "c0000000-0000-4000-8000-000000000003",
  rival: "d0000000-0000-4000-8000-000000000004",
}

function world() {
  let rows: MailDeviceRow[] = [
    device(ids.ada, ADA),
    device(ids.bob, BOB),
    device(ids.solo, SOLO),
    { ...device(ids.rival, BOB), clerkUserId: "user_rival", tenantId: RIVAL },
  ]
  const inScope = (row: MailDeviceRow, scope: DeviceScope) =>
    scope.kind === "own"
      ? row.clerkUserId === scope.clerkUserId &&
        row.tenantId === (accounts[scope.clerkUserId]?.tenantId ?? null)
      : row.tenantId === scope.tenantId &&
        (scope.clerkUserId === undefined || row.clerkUserId === scope.clerkUserId)
  const store: DeviceStorePort = {
    list: async ({ scope, email }) => ({
      devices: rows.filter((r) => inScope(r, scope) && (!email || r.email === email)),
      nextCursor: null,
    }),
    revoke: async ({ deviceId, scope }) => {
      const hit = rows.find((r) => r.id === deviceId && inScope(r, scope))
      if (!hit) return null
      rows = rows.filter((r) => r !== hit)
      return {
        id: hit.id,
        email: hit.email,
        clerkUserId: hit.clerkUserId,
        tenantId: hit.tenantId,
      }
    },
    revokeAll: async (scope) => {
      const hit = rows.filter((r) => inScope(r, scope))
      rows = rows.filter((r) => !hit.includes(r))
      return hit.map((r) => ({
        id: r.id,
        email: r.email,
        clerkUserId: r.clerkUserId,
        tenantId: r.tenantId,
      }))
    },
    accountOf: async (address) => {
      const found = Object.entries(accounts).find(([, a]) => a.email === address)
      return found ? { clerkUserId: found[0], tenantId: found[1].tenantId } : null
    },
    mailboxTenant: async (clerkUserId) => {
      const acct = accounts[clerkUserId]
      return acct ? { tenantId: acct.tenantId } : null
    },
  }
  const audit: Record<string, unknown>[] = []
  const service = mailDeviceService({
    store,
    log: { info: (o) => audit.push(o as Record<string, unknown>) },
  })
  return { service, audit, left: () => rows.map((r) => r.id) }
}

/** The console router as `routes/console.ts` mounts it, signed in as `userId` in ACME. */
function consoleFor(w: ReturnType<typeof world> | null, userId: string) {
  const app = new Hono()
  app.use("*", async (c, next) => {
    c.set("auth", { apiKeyId: "", tenantId: ACME, scopes: [], mode: "live" })
    c.set("user", { userId, orgId: "org_acme" })
    await next()
  })
  const deps = {
    teamDomains: {
      can: async (tenantId: string, uId: string, perm: string) =>
        perm === "members:manage" && uId === ADMIN && tenantId === ACME,
    },
    ...(w ? { mailDevices: w.service } : {}),
  } as unknown as ConsoleDeps
  mountMailDevices(app, deps)
  return app
}

const json = async (res: Response) => ({ status: res.status, body: await res.json() })
const idsIn = (body: { data: { id: string }[] }) => body.data.map((d) => d.id)

describe("console /mail-devices", () => {
  it("answers 501 when the service is not wired", async () => {
    const res = await consoleFor(null, ADA).request("/mail-devices")
    expect(res.status).toBe(501)
  })

  it("a member gets their own devices, and 404 for the workspace or another address", async () => {
    const app = consoleFor(world(), ADA)
    const mine = await json(await app.request("/mail-devices"))
    expect(mine.status).toBe(200)
    expect(idsIn(mine.body)).toEqual([ids.ada])

    for (const path of [
      "/mail-devices?scope=workspace",
      "/mail-devices?address=bob%40acme.test",
      "/mail-devices?address=nobody%40acme.test",
      "/mail-devices?address=not-an-address",
    ]) {
      const res = await json(await app.request(path))
      expect(res).toEqual({
        status: 404,
        body: {
          statusCode: 404,
          name: "not_found",
          message: "No such mail device here.",
        },
      })
    }
  })

  it("an admin sees the workspace and one mailbox of it, never i10's own domain", async () => {
    const app = consoleFor(world(), ADMIN)
    const all = await json(await app.request("/mail-devices?scope=workspace"))
    expect(idsIn(all.body).sort()).toEqual([ids.ada, ids.bob].sort())
    const bob = await json(await app.request("/mail-devices?address=bob%40acme.test"))
    expect(idsIn(bob.body)).toEqual([ids.bob])
    const solo = await app.request("/mail-devices?address=solo%40i10.test")
    expect(solo.status).toBe(404)
  })

  it("refuses a bad scope or cursor with 422", async () => {
    const app = consoleFor(world(), ADA)
    // Well formed, but dates Postgres refuses: they must be a 422, not a 500.
    const cursorOf = (at: string) =>
      Buffer.from(`${at}|${ids.ada}`, "utf8").toString("base64url")
    for (const query of [
      "scope=everyone",
      "cursor=bad",
      `cursor=${cursorOf("2026-02-30T10:00:00.000000Z")}`,
      `cursor=${cursorOf("0000-01-01T00:00:00.000000Z")}`,
    ]) {
      expect((await app.request(`/mail-devices?${query}`)).status).toBe(422)
    }
  })

  it("DELETE: a member revokes their own device and gets 404 for anyone else's", async () => {
    const w = world()
    const app = consoleFor(w, ADA)
    expect(
      (await app.request(`/mail-devices/${ids.bob}`, { method: "DELETE" })).status,
    ).toBe(404)
    expect(
      (await app.request("/mail-devices/banana", { method: "DELETE" })).status,
    ).toBe(404)
    const own = await json(
      await app.request(`/mail-devices/${ids.ada}`, { method: "DELETE" }),
    )
    expect(own).toEqual({ status: 200, body: { deleted: true, id: ids.ada } })
    expect(w.left()).not.toContain(ids.ada)
    expect(w.left()).toContain(ids.bob)
  })

  it("DELETE: an admin revokes any device of the workspace, not another workspace's", async () => {
    const w = world()
    const app = consoleFor(w, ADMIN)
    expect(
      (await app.request(`/mail-devices/${ids.rival}`, { method: "DELETE" })).status,
    ).toBe(404)
    expect(
      (await app.request(`/mail-devices/${ids.solo}`, { method: "DELETE" })).status,
    ).toBe(404)
    expect(
      (await app.request(`/mail-devices/${ids.bob}`, { method: "DELETE" })).status,
    ).toBe(200)
    expect(w.audit).toEqual([
      {
        audit: "mail_device.revoked",
        tenantId: ACME,
        actorUserId: ADMIN,
        userId: BOB,
        deviceId: ids.bob,
        address: "bob@acme.test",
      },
    ])
  })

  it("revoke-all: the caller's own by default; another address only for an admin of its workspace", async () => {
    const w = world()
    const post = (app: Hono, body?: unknown) =>
      app.request("/mail-devices/revoke-all", {
        method: "POST",
        ...(body
          ? {
              body: JSON.stringify(body),
              headers: { "content-type": "application/json" },
            }
          : {}),
      })

    expect((await post(consoleFor(w, ADA), { address: "bob@acme.test" })).status).toBe(
      404,
    )
    expect(await json(await post(consoleFor(w, ADA)))).toEqual({
      status: 200,
      body: { object: "mail_devices_revoked", revoked: 1 },
    })
    expect(w.left().sort()).toEqual([ids.bob, ids.solo, ids.rival].sort())

    expect(
      (await post(consoleFor(w, ADMIN), { address: "solo@i10.test" })).status,
    ).toBe(404)
    expect(
      (await json(await post(consoleFor(w, ADMIN), { address: "bob@acme.test" }))).body,
    ).toEqual({ object: "mail_devices_revoked", revoked: 1 })
    expect(w.left().sort()).toEqual([ids.solo, ids.rival].sort())
  })

  it("asks for no step-up: revoking works without a fresh-auth reader", async () => {
    // `consoleFor` wires no `freshAuth`; a route behind `requireFreshAuth` would refuse.
    const res = await consoleFor(world(), SOLO).request(`/mail-devices/${ids.solo}`, {
      method: "DELETE",
    })
    expect(res.status).toBe(200)
  })
})

describe("console /console/mail-devices workspace-optional and mailbox gating", () => {
  const BEARER = { Authorization: "Bearer stub" }
  const ENROLLMENT_ID = "019ab100-0000-7000-8000-000000000010"
  const EXPIRES = new Date("2026-11-27T02:15:00.000Z")
  const fresh: FreshAuthReader = async () => ({ status: "fresh" })

  function fullConsole(options: {
    userId: string
    world: ReturnType<typeof world>
    activeOrg: ActiveOrgReader
    tenantId?: string | null
    ssoGate?: SsoGateReader
    isAdminIn?: string
    mailDeviceEnrollments?: MailDeviceEnrollmentsDeps
    freshAuth?: FreshAuthReader
  }) {
    const sessions: SessionVerifier = {
      verify: async () => ({ status: "signed-in", userId: options.userId }),
    }
    const tenants: TenantResolver = {
      resolve: async () => options.tenantId ?? null,
    }

    return createApp({
      ...(options.ssoGate ? { ssoGate: options.ssoGate } : {}),
      console: {
        sessions,
        tenants,
        activeOrg: options.activeOrg,
        ...(options.freshAuth ? { freshAuth: options.freshAuth } : {}),
        mailDevices: options.world.service,
        ...(options.mailDeviceEnrollments
          ? { mailDeviceEnrollments: options.mailDeviceEnrollments }
          : {}),
        teamDomains: {
          can: async (tenantId: string, uId: string, perm: string) =>
            perm === "members:manage" &&
            uId === options.userId &&
            options.isAdminIn !== undefined &&
            tenantId === options.isAdminIn,
        } as unknown as ConsoleDeps["teamDomains"],
        queries: {} as ConsoleDeps["queries"],
        usage: {} as ConsoleDeps["usage"],
        onboarding: {} as ConsoleDeps["onboarding"],
        profile: {} as ConsoleDeps["profile"],
        marketing: {} as ConsoleDeps["marketing"],
        log: { error: () => {}, warn: () => {} },
      },
    })
  }

  const noOrg: ActiveOrgReader = async () => ({ status: "personal" })
  const org =
    (orgId: string): ActiveOrgReader =>
    async () => ({ status: "org", orgId })

  it("works with no workspace open for own list, revoke and revoke-all; workspace scope 404s", async () => {
    const w = world()
    const app = fullConsole({
      userId: ADA,
      world: w,
      activeOrg: noOrg,
      isAdminIn: ACME,
    })

    // Own list works without a workspace.
    const mine = await json(
      await app.request("/console/mail-devices", { headers: BEARER }),
    )
    expect(mine.status).toBe(200)
    expect(idsIn(mine.body)).toEqual([ids.ada])

    const ownByAddress = await json(
      await app.request("/console/mail-devices?address=ada%40acme.test", {
        headers: BEARER,
      }),
    )
    expect(ownByAddress.status).toBe(200)
    expect(idsIn(ownByAddress.body)).toEqual([ids.ada])

    // Workspace scope and another person's address still answer the indistinguishable 404.
    for (const path of [
      "/console/mail-devices?scope=workspace",
      "/console/mail-devices?address=bob%40acme.test",
      "/console/mail-devices?address=nobody%40acme.test",
    ]) {
      const res = await json(await app.request(path, { headers: BEARER }))
      expect(res).toEqual({
        status: 404,
        body: {
          statusCode: 404,
          name: "not_found",
          message: "No such mail device here.",
        },
      })
    }

    // Revoking someone else's device or address is 404 even with no org open.
    expect(
      (
        await app.request(`/console/mail-devices/${ids.bob}`, {
          method: "DELETE",
          headers: BEARER,
        })
      ).status,
    ).toBe(404)
    expect(
      (
        await app.request("/console/mail-devices/revoke-all", {
          method: "POST",
          headers: { ...BEARER, "content-type": "application/json" },
          body: JSON.stringify({ address: "bob@acme.test" }),
        })
      ).status,
    ).toBe(404)

    // Own revoke works with no workspace open and no step-up.
    const del = await json(
      await app.request(`/console/mail-devices/${ids.ada}`, {
        method: "DELETE",
        headers: BEARER,
      }),
    )
    expect(del).toEqual({ status: 200, body: { deleted: true, id: ids.ada } })
    expect(w.left()).not.toContain(ids.ada)

    // Own revoke-all works with no workspace open and no step-up.
    const w2 = world()
    const app2 = fullConsole({ userId: SOLO, world: w2, activeOrg: noOrg })
    const all = await json(
      await app2.request("/console/mail-devices/revoke-all", {
        method: "POST",
        headers: BEARER,
      }),
    )
    expect(all).toEqual({
      status: 200,
      body: { object: "mail_devices_revoked", revoked: 1 },
    })
    expect(w2.left()).not.toContain(ids.solo)
  })

  it("does not make other console routes workspace-optional", async () => {
    const app = fullConsole({ userId: ADA, world: world(), activeOrg: noOrg })
    for (const [method, path] of [
      ["GET", "/console/me"],
      ["GET", "/console/mailboxes"],
      ["GET", "/console/domains"],
      ["GET", "/console/api-keys"],
      ["POST", "/console/mail-devices"],
      ["GET", "/console/mail-devices/revoke-all"],
      ["GET", `/console/mail-devices/${ids.ada}`],
      ["DELETE", `/console/mail-devices/${ids.ada}/extra`],
    ] as const) {
      const res = await json(await app.request(path, { method, headers: BEARER }))
      expect(res.status).toBe(409)
      expect(res.body).toMatchObject({ name: "no_workspace" })
    }
  })

  it("blocks own list, revoke and revoke-all when the mailbox workspace refuses and another or none is open", async () => {
    const gated: (string | undefined)[] = []
    const ssoGate: SsoGateReader = async (_req, _userId, tenantId) => {
      gated.push(tenantId)
      return tenantId === ACME ? { status: "mfa_required" } : { status: "pass" }
    }

    for (const openCase of [
      { activeOrg: noOrg, tenantId: null },
      { activeOrg: org("org_rival"), tenantId: RIVAL },
    ]) {
      const w = world()
      const app = fullConsole({
        userId: ADA,
        world: w,
        activeOrg: openCase.activeOrg,
        tenantId: openCase.tenantId,
        ssoGate,
      })

      for (const req of [
        app.request("/console/mail-devices", { headers: BEARER }),
        app.request("/console/mail-devices?address=ada%40acme.test", {
          headers: BEARER,
        }),
        app.request(`/console/mail-devices/${ids.ada}`, {
          method: "DELETE",
          headers: BEARER,
        }),
        app.request("/console/mail-devices/revoke-all", {
          method: "POST",
          headers: BEARER,
        }),
        app.request("/console/mail-devices/revoke-all", {
          method: "POST",
          headers: { ...BEARER, "content-type": "application/json" },
          body: JSON.stringify({ address: "ada@acme.test" }),
        }),
      ]) {
        const res = await json(await req)
        expect(res.status).toBe(403)
        expect(res.body).toMatchObject({ name: "mfa_required" })
      }
      // Nothing was revoked while the mailbox workspace refused.
      expect(w.left()).toContain(ids.ada)
    }
    expect(gated).toContain(ACME)
  })

  it("still lets an admin of a passing open workspace manage that workspace's devices when their own mailbox workspace refuses", async () => {
    const ssoGate: SsoGateReader = async (_req, _userId, tenantId) =>
      tenantId === ACME ? { status: "mfa_required" } : { status: "pass" }

    const w = world()
    // ADA's own mailbox lives in ACME (refusing), while ADA is admin of RIVAL (open, passing).
    const app = fullConsole({
      userId: ADA,
      world: w,
      activeOrg: org("org_rival"),
      tenantId: RIVAL,
      isAdminIn: RIVAL,
      ssoGate,
    })

    const wsList = await json(
      await app.request("/console/mail-devices?scope=workspace", { headers: BEARER }),
    )
    expect(wsList.status).toBe(200)
    expect(idsIn(wsList.body)).toEqual([ids.rival])

    // Deleting RIVAL's device succeeds without hitting ACME's refusal.
    const wsDel = await json(
      await app.request(`/console/mail-devices/${ids.rival}`, {
        method: "DELETE",
        headers: BEARER,
      }),
    )
    expect(wsDel).toEqual({ status: 200, body: { deleted: true, id: ids.rival } })
    expect(w.left()).not.toContain(ids.rival)

    // Own device in ACME is still blocked by ACME's policy.
    const ownDel = await json(
      await app.request(`/console/mail-devices/${ids.ada}`, {
        method: "DELETE",
        headers: BEARER,
      }),
    )
    expect(ownDel.status).toBe(403)
    expect(w.left()).toContain(ids.ada)
  })

  it("passes without re-running the gate when the mailbox workspace is already the open one, and allows i10.tech mailboxes", async () => {
    const gated: (string | undefined)[] = []
    const ssoGate: SsoGateReader = async (_req, _userId, tenantId) => {
      gated.push(tenantId)
      return { status: "pass" }
    }

    const w = world()
    const app = fullConsole({
      userId: ADA,
      world: w,
      activeOrg: org("org_acme"),
      tenantId: ACME,
      ssoGate,
    })

    const mine = await json(
      await app.request("/console/mail-devices", { headers: BEARER }),
    )
    expect(mine.status).toBe(200)
    expect(idsIn(mine.body)).toEqual([ids.ada])
    // requireTenant ran the global gate (undefined) and ACME once; the route did not call ACME a second time.
    expect(gated.filter((t) => t === ACME)).toHaveLength(1)

    const del = await json(
      await app.request(`/console/mail-devices/${ids.ada}`, {
        method: "DELETE",
        headers: BEARER,
      }),
    )
    expect(del.status).toBe(200)

    // An i10.tech mailbox (tenantId: null) has no workspace policies to refuse it.
    const soloApp = fullConsole({
      userId: SOLO,
      world: world(),
      activeOrg: noOrg,
      ssoGate: async (_req, _userId, tenantId) =>
        tenantId ? { status: "mfa_required" } : { status: "pass" },
    })
    const soloList = await json(
      await soloApp.request("/console/mail-devices", { headers: BEARER }),
    )
    expect(soloList.status).toBe(200)
    expect(idsIn(soloList.body)).toEqual([ids.solo])
  })

  it("keeps /console/mail-devices/enrollments paths unchanged", async () => {
    const enrollments: MailDeviceEnrollmentsDeps = {
      mailboxTenant: async () => ({ tenantId: ACME }),
      create: async () => ({
        ok: true,
        id: ENROLLMENT_ID,
        url: "https://ca.i10.tech/enroll/apple/tok",
        expiresAt: EXPIRES,
      }),
      get: async () => ({
        id: ENROLLMENT_ID,
        status: "open",
        expiresAt: EXPIRES,
        refusal: null,
        platform: null,
        model: null,
        deviceName: null,
        deviceId: null,
        needsMailSetup: false,
      }),
      cancel: async () => "cancelled",
    }

    const app = fullConsole({
      userId: ADA,
      world: world(),
      activeOrg: noOrg,
      freshAuth: fresh,
      mailDeviceEnrollments: enrollments,
    })

    const postRes = await app.request("/console/mail-devices/enrollments", {
      method: "POST",
      headers: { ...BEARER, "content-type": "application/json" },
      body: "{}",
    })
    expect(postRes.status).toBe(201)

    const getRes = await app.request(
      `/console/mail-devices/enrollments/${ENROLLMENT_ID}`,
      { headers: BEARER },
    )
    expect(getRes.status).toBe(200)

    const delRes = await app.request(
      `/console/mail-devices/enrollments/${ENROLLMENT_ID}`,
      { method: "DELETE", headers: BEARER },
    )
    expect(delRes.status).toBe(204)
  })
})

describe("public /mail-devices (session, about the caller only)", () => {
  const sessions: SessionVerifier = {
    verify: async (request) => {
      const user = request.headers.get("x-user")
      return user ? { status: "signed-in", userId: user } : { status: "signed-out" }
    },
  }
  const call = (
    app: ReturnType<typeof createApp>,
    method: string,
    path: string,
    user?: string,
  ) => app.request(path, { method, headers: user ? { "x-user": user } : {} })

  it("401 without a session, and an API key is not a session", async () => {
    const app = createApp({ sessionAuth: sessions, mailDevices: world().service })
    expect((await call(app, "GET", "/mail-devices")).status).toBe(401)
    const keyed = await app.request("/mail-devices", {
      headers: { authorization: "Bearer i10_live_whatever" },
    })
    expect(keyed.status).toBe(401)
  })

  it("lists and revokes only the caller's devices, even for a workspace admin", async () => {
    const w = world()
    const app = createApp({ sessionAuth: sessions, mailDevices: w.service })

    const mine = await json(await call(app, "GET", "/mail-devices", ADMIN))
    expect(mine).toEqual({ status: 200, body: { data: [], next_cursor: null } })
    expect((await call(app, "DELETE", `/mail-devices/${ids.ada}`, ADMIN)).status).toBe(
      404,
    )

    const solo = await json(await call(app, "GET", "/mail-devices", SOLO))
    expect(idsIn(solo.body)).toEqual([ids.solo])
    expect((await call(app, "DELETE", `/mail-devices/${ids.solo}`, SOLO)).status).toBe(
      200,
    )

    const all = await json(await call(app, "POST", "/mail-devices/revoke-all", ADA))
    expect(all.body).toEqual({ object: "mail_devices_revoked", revoked: 1 })
    expect(w.left().sort()).toEqual([ids.bob, ids.rival].sort())
  })

  it("answers 501 when the service is not wired", async () => {
    const app = createApp({ sessionAuth: sessions })
    expect((await call(app, "GET", "/mail-devices", ADA)).status).toBe(501)
  })

  it("blocks list, revoke and revoke-all when the mailbox workspace refuses", async () => {
    const gated: (string | undefined)[] = []
    const ssoGate: SsoGateReader = async (_req, _userId, tenantId) => {
      gated.push(tenantId)
      return tenantId === ACME ? { status: "mfa_required" } : { status: "pass" }
    }
    const w = world()
    const app = createApp({
      sessionAuth: sessions,
      mailDevices: w.service,
      ssoGate,
    })

    for (const req of [
      call(app, "GET", "/mail-devices", ADA),
      call(app, "DELETE", `/mail-devices/${ids.ada}`, ADA),
      call(app, "POST", "/mail-devices/revoke-all", ADA),
    ]) {
      const res = await json(await req)
      expect(res.status).toBe(403)
      expect(res.body).toMatchObject({ name: "mfa_required" })
    }
    expect(w.left()).toContain(ids.ada)
    expect(gated.filter((t) => t === ACME)).toHaveLength(3)
  })

  it("allows list, revoke and revoke-all when the mailbox workspace passes", async () => {
    const gated: (string | undefined)[] = []
    const ssoGate: SsoGateReader = async (_req, _userId, tenantId) => {
      gated.push(tenantId)
      return { status: "pass" }
    }
    const w = world()
    const app = createApp({
      sessionAuth: sessions,
      mailDevices: w.service,
      ssoGate,
    })

    const mine = await json(await call(app, "GET", "/mail-devices", ADA))
    expect(mine.status).toBe(200)
    expect(idsIn(mine.body)).toEqual([ids.ada])

    const del = await json(await call(app, "DELETE", `/mail-devices/${ids.ada}`, ADA))
    expect(del).toEqual({ status: 200, body: { deleted: true, id: ids.ada } })
    expect(w.left()).not.toContain(ids.ada)

    const all = await json(await call(app, "POST", "/mail-devices/revoke-all", BOB))
    expect(all).toEqual({
      status: 200,
      body: { object: "mail_devices_revoked", revoked: 1 },
    })
    expect(w.left()).not.toContain(ids.bob)
    expect(gated.filter((t) => t === ACME)).toHaveLength(3)
  })

  it("runs no workspace gate for a null-tenant (i10.tech) mailbox", async () => {
    const gated: (string | undefined)[] = []
    const ssoGate: SsoGateReader = async (_req, _userId, tenantId) => {
      gated.push(tenantId)
      return tenantId ? { status: "mfa_required" } : { status: "pass" }
    }
    const w = world()
    const app = createApp({
      sessionAuth: sessions,
      mailDevices: w.service,
      ssoGate,
    })

    const mine = await json(await call(app, "GET", "/mail-devices", SOLO))
    expect(mine.status).toBe(200)
    expect(idsIn(mine.body)).toEqual([ids.solo])

    const del = await json(await call(app, "DELETE", `/mail-devices/${ids.solo}`, SOLO))
    expect(del).toEqual({ status: 200, body: { deleted: true, id: ids.solo } })
    expect(w.left()).not.toContain(ids.solo)

    const all = await json(await call(app, "POST", "/mail-devices/revoke-all", SOLO))
    expect(all).toEqual({
      status: 200,
      body: { object: "mail_devices_revoked", revoked: 0 },
    })
    expect(gated.filter((t) => t !== undefined)).toEqual([])
  })
})
