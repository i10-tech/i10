import { describe, expect, it, mock } from "bun:test"
import { Hono } from "hono"
import { mountDomains } from "../src/routes/console/domains.js"
import type { ConsoleDeps } from "../src/routes/console/deps.js"
import type { MailboxHosting, MailboxesView } from "../src/domains/mailbox-hosting.js"

/**
 * The routes that switch mailbox hosting on and off and choose a catch-all
 * (#406): who may call them, that they ask for a step-up, and how each outcome
 * of the hosting service becomes a status. What the service decides is covered
 * against a real database in mailbox-hosting-db.test.ts.
 */

const VIEW: MailboxesView = {
  enabled: true,
  owned: true,
  sending: false,
  catch_all: null,
  count: 2,
}

function appWith(opts: {
  hosting?: Partial<MailboxHosting>
  role?: "owner" | "admin" | "member"
  fresh?: boolean
}) {
  const app = new Hono()
  app.use("*", async (c, next) => {
    c.set("auth", { apiKeyId: "", tenantId: "ten-a", scopes: [], mode: "live" })
    c.set("user", { userId: "user_1" })
    c.set(
      "freshAuth" as never,
      (async () => ({ status: opts.fresh === false ? "stale" : "fresh" })) as never,
    )
    await next()
  })
  mountDomains(app, {
    log: { error() {}, warn() {} },
    roles: { store: { roleOf: async () => opts.role ?? "owner" } },
    mailboxHosting: opts.hosting as MailboxHosting,
  } as unknown as ConsoleDeps)
  return app
}

const put = (app: Hono, path: string, body: unknown) =>
  app.request(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

describe("PUT /domains/:id/mailboxes", () => {
  it("switches it on and says whether Stalwart caught up", async () => {
    const setEnabled = mock<MailboxHosting["setEnabled"]>(async () => ({
      status: "ok" as const,
      mailboxes: VIEW,
      stalwart: "pending" as const,
    }))
    const res = await put(
      appWith({ hosting: { setEnabled } }),
      "/domains/dom_1/mailboxes",
      {
        enabled: true,
      },
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ mailboxes: VIEW, stalwart: "pending" })
    expect(setEnabled.mock.calls[0]).toEqual(["ten-a", "dom_1", true])
  })

  it("is for owners and admins: a member is refused before anything runs", async () => {
    const setEnabled = mock<MailboxHosting["setEnabled"]>(async () => ({
      status: "missing" as const,
    }))
    const res = await put(
      appWith({ hosting: { setEnabled }, role: "member" }),
      "/domains/dom_1/mailboxes",
      { enabled: true },
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ name: "forbidden" })
    expect(setEnabled).not.toHaveBeenCalled()
  })

  it("lets an admin through", async () => {
    const setEnabled = mock<MailboxHosting["setEnabled"]>(async () => ({
      status: "ok" as const,
      mailboxes: VIEW,
      stalwart: "synced" as const,
    }))
    const res = await put(
      appWith({ hosting: { setEnabled }, role: "admin" }),
      "/domains/dom_1/mailboxes",
      { enabled: false },
    )
    expect(res.status).toBe(200)
  })

  it("asks for a step-up, and does nothing without one", async () => {
    const setEnabled = mock<MailboxHosting["setEnabled"]>(async () => ({
      status: "missing" as const,
    }))
    const res = await put(
      appWith({ hosting: { setEnabled }, fresh: false }),
      "/domains/dom_1/mailboxes",
      { enabled: true },
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({
      clerk_error: { reason: "reverification-error" },
    })
    expect(setEnabled).not.toHaveBeenCalled()
  })

  it("refuses a domain the workspace does not hold, with the reason", async () => {
    for (const reason of ["displaced", "unowned"] as const) {
      const res = await put(
        appWith({
          hosting: { setEnabled: async () => ({ status: "not_held", reason }) },
        }),
        "/domains/dom_1/mailboxes",
        { enabled: true },
      )
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ name: "domain_not_held", reason })
    }
  })

  it("answers 403 plan_limit_exceeded over the allowance", async () => {
    const res = await put(
      appWith({ hosting: { setEnabled: async () => ({ status: "limit" }) } }),
      "/domains/dom_1/mailboxes",
      { enabled: true },
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ name: "plan_limit_exceeded" })
  })

  it("is 404 for no such domain and 422 for a body that is not a boolean", async () => {
    const app = appWith({
      hosting: { setEnabled: async () => ({ status: "missing" }) },
    })
    expect((await put(app, "/domains/x/mailboxes", { enabled: true })).status).toBe(404)
    expect((await put(app, "/domains/x/mailboxes", { enabled: "yes" })).status).toBe(
      422,
    )
  })
})

describe("PUT /domains/:id/catch-all", () => {
  it("sets and clears it", async () => {
    const setCatchAll = mock<MailboxHosting["setCatchAll"]>(async () => ({
      status: "ok" as const,
      mailboxes: { ...VIEW, catch_all: "ada@acme.com" },
      stalwart: "synced" as const,
    }))
    const app = appWith({ hosting: { setCatchAll } })

    expect(
      (await put(app, "/domains/dom_1/catch-all", { address: "ada@acme.com" })).status,
    ).toBe(200)
    expect((await put(app, "/domains/dom_1/catch-all", { address: null })).status).toBe(
      200,
    )
    expect(setCatchAll.mock.calls.map((c) => c[2])).toEqual(["ada@acme.com", null])
  })

  it("answers a refused target as a validation error with the reason", async () => {
    const res = await put(
      appWith({
        hosting: {
          setCatchAll: async () => ({
            status: "rejected",
            reason: "bob@other.com is not a mailbox or team inbox of this workspace.",
          }),
        },
      }),
      "/domains/dom_1/catch-all",
      { address: "bob@other.com" },
    )
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({
      message: expect.stringContaining("not a mailbox"),
    })
  })

  it("needs an address field, a string or null, and an admin", async () => {
    const setCatchAll = mock<MailboxHosting["setCatchAll"]>(async () => ({
      status: "missing" as const,
    }))
    const app = appWith({ hosting: { setCatchAll } })
    expect((await put(app, "/domains/dom_1/catch-all", {})).status).toBe(422)
    expect((await put(app, "/domains/dom_1/catch-all", { address: 3 })).status).toBe(
      422,
    )

    const member = appWith({ hosting: { setCatchAll }, role: "member" })
    expect(
      (await put(member, "/domains/dom_1/catch-all", { address: null })).status,
    ).toBe(403)
    expect(setCatchAll).not.toHaveBeenCalled()
  })
})

describe("the domain read", () => {
  it("carries the mailboxes object, for the one domain and the list", async () => {
    const domain = {
      object: "domain",
      id: "dom_1",
      name: "acme.com",
      status: "pending",
      records: [],
    }
    const app = new Hono()
    app.use("*", async (c, next) => {
      c.set("auth", { apiKeyId: "", tenantId: "ten-a", scopes: [], mode: "live" })
      c.set("user", { userId: "user_1" })
      await next()
    })
    mountDomains(app, {
      log: { error() {}, warn() {} },
      domains: {
        get: async () => domain,
        list: async () => [domain],
        displaced: async () => ({}),
        checks: async () => null,
        onboardingEmails: async () => ({}),
      },
      mailboxHosting: {
        forDomain: async () => VIEW,
        forTenant: async () => ({ dom_1: VIEW }),
      },
    } as unknown as ConsoleDeps)

    expect(await (await app.request("/domains/dom_1")).json()).toMatchObject({
      mailboxes: VIEW,
    })
    expect(await (await app.request("/domains")).json()).toMatchObject({
      data: [{ id: "dom_1", mailboxes: VIEW }],
    })
  })
})
