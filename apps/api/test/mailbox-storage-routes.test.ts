import { describe, expect, it, mock } from "bun:test"
import { Hono } from "hono"
import { storageAllocations } from "../src/mailboxes/allocation.js"
import { mountMailboxStorage } from "../src/routes/console/mailbox-storage.js"
import type { ConsoleDeps } from "../src/routes/console/deps.js"
import {
  ACME,
  fakeRegistry,
  GIB,
  GLOBEX,
  memoryStore,
  PAYG,
  PRO,
  row,
} from "./mailbox-quota-fixtures.js"

/**
 * The console's storage routes: who may size an inbox, and what the statuses are.
 * An owner or admin holds `members:manage` in our roles table; a member does not.
 */

const ADMIN = "user_admin"
const MEMBER = "user_member"
const ORG = "org_acme"
const MANAGE = "members:manage"

function world(plan: typeof PRO | null = PRO) {
  const tenants = {
    [ACME]: [row("sam@acme.test", 4 * GIB), row("kim@acme.test"), row("lee@acme.test")],
    [GLOBEX]: [row("pat@globex.test", GIB)],
  }
  const registry = fakeRegistry([
    { id: "a", emailAddress: "sam@acme.test" },
    { id: "k", emailAddress: "kim@acme.test" },
    { id: "p", emailAddress: "pat@globex.test" },
  ])
  const can = mock(
    async (_tenantId: string, userId: string, permission: string) =>
      userId === ADMIN && permission === MANAGE,
  )
  const mailboxStorage = storageAllocations({
    store: memoryStore(tenants, { [ACME]: 3 * GIB }),
    assignments: { find: async () => plan },
    stalwart: registry.call,
  })
  return { tenants, registry, can, deps: { teamDomains: { can }, mailboxStorage } }
}

function appFor(
  w: ReturnType<typeof world>,
  who: string,
  opts: { orgId?: string | undefined; unwired?: boolean } = {},
) {
  const app = new Hono()
  app.use("*", async (c, next) => {
    c.set("auth", { apiKeyId: "", tenantId: ACME, scopes: [], mode: "live" })
    c.set("user", { userId: who, orgId: "orgId" in opts ? opts.orgId : ORG })
    await next()
  })
  mountMailboxStorage(
    app,
    (opts.unwired
      ? { teamDomains: w.deps.teamDomains }
      : w.deps) as unknown as ConsoleDeps,
  )
  return app
}

const put = (app: Hono, address: string, body: unknown) =>
  app.request(`/mailboxes/${encodeURIComponent(address)}/storage`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

describe("who may size an inbox", () => {
  it("lets an owner or admin allocate and tells them the quota reached Stalwart", async () => {
    const w = world()
    const res = await put(appFor(w, ADMIN), "kim@acme.test", {
      storage_allocation: 2 * GIB,
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      mailbox: {
        address: "kim@acme.test",
        display_name: null,
        storage_allocated: 2 * GIB,
      },
      quota: "synced",
    })
    expect(w.registry.accounts.find((a) => a.id === "k")!.quotas).toEqual({
      maxDiskQuota: 2 * GIB,
    })
    expect(w.can).toHaveBeenCalledWith(ACME, ADMIN, MANAGE)
  })

  it("answers 403 to a member and changes nothing, in the database or in Stalwart", async () => {
    const w = world()
    const res = await put(appFor(w, MEMBER), "kim@acme.test", {
      storage_allocation: GIB,
    })

    expect(res.status).toBe(403)
    expect(w.tenants[ACME]![1]!.allocation).toBeNull()
    expect(w.registry.methods).toHaveLength(0)
  })

  it("answers 403 to a member even for their own inbox", async () => {
    const w = world()
    const res = await put(appFor(w, MEMBER), "sam@acme.test", {
      storage_allocation: 9 * GIB,
    })

    expect(res.status).toBe(403)
    expect(w.tenants[ACME]![0]!.allocation).toBe(4 * GIB)
  })

  it("answers 403 to anyone with no organization, since there is no role to ask about", async () => {
    const w = world()
    const res = await put(appFor(w, ADMIN, { orgId: undefined }), "kim@acme.test", {
      storage_allocation: GIB,
    })

    expect(res.status).toBe(403)
    expect(w.can).not.toHaveBeenCalled()
  })

  it("shows the pool to an admin and refuses a member", async () => {
    const w = world()

    const admin = await appFor(w, ADMIN).request("/mailboxes/storage")
    expect(admin.status).toBe(200)

    const member = await appFor(w, MEMBER).request("/mailboxes/storage")
    expect(member.status).toBe(403)
  })

  it("answers 501 where storage is not configured", async () => {
    const w = world()
    const res = await put(appFor(w, ADMIN, { unwired: true }), "kim@acme.test", {
      storage_allocation: GIB,
    })
    expect(res.status).toBe(501)
  })
})

describe("the pool as the console sees it", () => {
  it("reports the plan's pool, what is allocated and used, and legacy inboxes as unallocated", async () => {
    const w = world()
    const res = await appFor(w, ADMIN).request("/mailboxes/storage")
    const body = (await res.json()) as {
      pool: Record<string, unknown>
      data: { address: string; storage_allocated: number | null }[]
    }

    expect(body.pool).toEqual({
      kind: "pool",
      total: 10 * GIB,
      allocated: 4 * GIB,
      used: 3 * GIB,
      remaining: 6 * GIB,
      unallocated: 2,
    })
    expect(body.data.map((m) => [m.address, m.storage_allocated])).toEqual([
      ["sam@acme.test", 4 * GIB],
      ["kim@acme.test", null],
      ["lee@acme.test", null],
    ])
  })

  it("reports pay as you go as uncapped with nothing unallocated", async () => {
    const w = world(PAYG)
    const body = (await (
      await appFor(w, ADMIN).request("/mailboxes/storage")
    ).json()) as {
      pool: Record<string, unknown>
    }
    expect(body.pool).toMatchObject({
      kind: "uncapped",
      total: null,
      remaining: null,
      unallocated: 0,
    })
  })
})

describe("the statuses", () => {
  it("accepts the last of the pool and refuses a byte more with 403 plan_limit_exceeded", async () => {
    const w = world()
    const app = appFor(w, ADMIN)

    expect(
      (await put(app, "kim@acme.test", { storage_allocation: 6 * GIB })).status,
    ).toBe(200)

    const over = await put(app, "lee@acme.test", { storage_allocation: 1 })
    expect(over.status).toBe(403)
    expect(await over.json()).toMatchObject({
      name: "plan_limit_exceeded",
      remaining: 0,
    })
    expect(w.tenants[ACME]![2]!.allocation).toBeNull()
  })

  it("answers 422 to null on a pool, and accepts it on pay as you go", async () => {
    const pool = world()
    expect(
      (await put(appFor(pool, ADMIN), "sam@acme.test", { storage_allocation: null }))
        .status,
    ).toBe(422)

    const payg = world(PAYG)
    const res = await put(appFor(payg, ADMIN), "sam@acme.test", {
      storage_allocation: null,
    })
    expect(res.status).toBe(200)
    expect(payg.tenants[ACME]![0]!.allocation).toBeNull()
  })

  it("answers 422 to a body that is not a positive whole number of bytes", async () => {
    const w = world()
    const app = appFor(w, ADMIN)

    for (const bad of [0, -1, 1.5, "10", undefined]) {
      const res = await put(app, "kim@acme.test", { storage_allocation: bad })
      expect(res.status).toBe(422)
    }
    expect(w.registry.methods).toHaveLength(0)
  })

  it("answers 404 for an address in another workspace, indistinct from one that does not exist", async () => {
    const w = world()
    const app = appFor(w, ADMIN)

    expect(
      (await put(app, "pat@globex.test", { storage_allocation: GIB })).status,
    ).toBe(404)
    expect(
      (await put(app, "nobody@acme.test", { storage_allocation: GIB })).status,
    ).toBe(404)
    expect(w.tenants[GLOBEX]![0]!.allocation).toBe(GIB)
    expect(w.registry.methods).toHaveLength(0)
  })

  it("answers 404 for a path that is not an address, or a broken escape, rather than 500", async () => {
    const w = world()
    const app = appFor(w, ADMIN)

    expect((await put(app, "not-an-address", { storage_allocation: GIB })).status).toBe(
      404,
    )
    const broken = await app.request("/mailboxes/%E0%A4%A/storage", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ storage_allocation: GIB }),
    })
    expect(broken.status).toBe(404)
  })

  it("saves the allocation and says `deferred` when Stalwart cannot be written", async () => {
    const w = world()
    w.registry.accounts.length = 0
    const res = await put(appFor(w, ADMIN), "kim@acme.test", {
      storage_allocation: GIB,
    })

    expect(res.status).toBe(200)
    expect(((await res.json()) as { quota: string }).quota).toBe("deferred")
    expect(w.tenants[ACME]![1]!.allocation).toBe(GIB)
  })
})
