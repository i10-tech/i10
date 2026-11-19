import { describe, expect, it, mock } from "bun:test"
import { Hono } from "hono"
import { MAILBOX_ALIAS_LIMIT } from "@repo/contracts"
import type {
  AliasAddOutcome,
  AliasListOutcome,
  AliasRemoveOutcome,
  AliasRow,
  MailboxAliases,
} from "../src/mailboxes/aliases.js"
import type { ConsoleDeps } from "../src/routes/console/deps.js"
import { mountMailboxAliases } from "../src/routes/console/mailbox-aliases.js"

/**
 * A mailbox's aliases over HTTP. The order of the refusals is the point - wired,
 * role, step-up, address, body, target - so each test that cares says what it must
 * not have reached.
 */

const TENANT = "3f1a0e00-0000-4000-8000-000000000001"
const people = { admin: "user_admin", member: "user_member" }
const ADDRESS = "ada@acme.test"
const rows: AliasRow[] = [
  { address: "sales@acme.test", source: "console" },
  { address: "ada.l@acme.test", source: "clerk" },
]

function world(
  over: {
    list?: AliasListOutcome
    add?: AliasAddOutcome
    remove?: AliasRemoveOutcome
    wired?: boolean
  } = {},
) {
  const list = mock<MailboxAliases["list"]>(
    async () => over.list ?? { status: "ok", aliases: rows },
  )
  const add = mock<MailboxAliases["add"]>(
    async () => over.add ?? { status: "added", aliases: rows },
  )
  const remove = mock<MailboxAliases["remove"]>(
    async () => over.remove ?? { status: "removed", aliases: rows.slice(1) },
  )
  const service: MailboxAliases = {
    isAdmin: async (_tenant, userId) => userId === people.admin,
    list,
    add,
    remove,
  }
  return { service, list, add, remove, wired: over.wired ?? true }
}

function appFor(w: ReturnType<typeof world>, who: keyof typeof people, fresh = true) {
  const stepUp = mock(async () => ({ status: fresh ? "fresh" : "stale" }))
  const app = new Hono()
  app.use("*", async (c, next) => {
    c.set("auth", { apiKeyId: "", tenantId: TENANT, scopes: [], mode: "live" })
    c.set("user", { userId: people[who], orgId: "org_acme" })
    c.set("freshAuth" as never, stepUp as never)
    await next()
  })
  mountMailboxAliases(
    app,
    (w.wired ? { mailboxAliases: w.service } : {}) as ConsoleDeps,
  )
  return { app, stepUp }
}

const base = (address = ADDRESS) => `/mailboxes/${encodeURIComponent(address)}/aliases`
const send = (app: Hono, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
const named = async (res: Response) => (await res.json()) as { name: string }

describe("GET /mailboxes/:address/aliases", () => {
  it("answers 501 where aliases are not wired", async () => {
    const res = await send(appFor(world({ wired: false }), "admin").app, "GET", base())
    expect(res.status).toBe(501)
  })

  it("lists the aliases with who can remove each, and the cap", async () => {
    const res = await send(appFor(world(), "admin").app, "GET", base())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      data: [
        {
          object: "mailbox_alias",
          address: "sales@acme.test",
          source: "console",
          removable: true,
        },
        {
          object: "mailbox_alias",
          address: "ada.l@acme.test",
          source: "clerk",
          removable: false,
        },
      ],
      limit: MAILBOX_ALIAS_LIMIT,
    })
  })

  it("lets a member ask, as a member, without a step-up", async () => {
    const w = world()
    const { app, stepUp } = appFor(w, "member", false)
    const res = await send(app, "GET", base())

    expect(res.status).toBe(200)
    expect(stepUp).not.toHaveBeenCalled()
    expect(w.list.mock.calls[0]![0]).toEqual({
      tenantId: TENANT,
      userId: people.member,
      isAdmin: false,
    })
  })

  it("answers 404 for a mailbox the viewer may not see, and for something that is not an address", async () => {
    const w = world({ list: { status: "not_found" } })
    expect((await send(appFor(w, "member").app, "GET", base())).status).toBe(404)

    const bad = world()
    const res = await send(appFor(bad, "admin").app, "GET", "/mailboxes/nope/aliases")
    expect(res.status).toBe(404)
    expect(bad.list).not.toHaveBeenCalled()
  })
})

describe.each([
  ["POST", base(), { address: "sales@other.test" }],
  ["DELETE", `${base()}/${encodeURIComponent("sales@acme.test")}`, undefined],
] as const)("%s (a change)", (method, path, body) => {
  const touched = (w: ReturnType<typeof world>) =>
    method === "POST" ? w.add : w.remove

  it("answers 501 where aliases are not wired", async () => {
    const res = await send(
      appFor(world({ wired: false }), "admin").app,
      method,
      path,
      body,
    )
    expect(res.status).toBe(501)
  })

  it("refuses a member with 403 and never asks them to step up", async () => {
    const w = world()
    const { app, stepUp } = appFor(w, "member", false)
    const res = await send(app, method, path, body)

    expect(res.status).toBe(403)
    expect((await named(res)).name).toBe("forbidden")
    expect(stepUp).not.toHaveBeenCalled()
    expect(touched(w)).not.toHaveBeenCalled()
  })

  it("asks an admin with a stale session to step up, before the body or the mailbox", async () => {
    const w = world()
    const res = await send(appFor(w, "admin", false).app, method, path, {
      nonsense: true,
    })

    expect(res.status).toBe(403)
    expect((await named(res)).name).toBe("invalid_access")
    expect(touched(w)).not.toHaveBeenCalled()
  })

  it("answers 404 for a mailbox that is not an address, without asking the service", async () => {
    const w = world()
    const bad = path.replace(encodeURIComponent(ADDRESS), "not-an-address")
    const res = await send(appFor(w, "admin").app, method, bad, body)
    expect(res.status).toBe(404)
    expect(touched(w)).not.toHaveBeenCalled()
  })
})

describe("POST /mailboxes/:address/aliases", () => {
  it("adds the alias as the admin, with the address in lowercase", async () => {
    const w = world()
    const res = await send(appFor(w, "admin").app, "POST", base(), {
      address: "  Sales@Other.TEST ",
    })

    expect(res.status).toBe(201)
    expect(w.add).toHaveBeenCalledWith({
      tenantId: TENANT,
      address: ADDRESS,
      alias: "sales@other.test",
      actorId: people.admin,
    })
    expect(((await res.json()) as { data: unknown[] }).data).toHaveLength(2)
  })

  it.each([
    [{}, "no address"],
    [{ address: "not an address" }, "not an address"],
    [{ address: "a+tag@acme.test" }, "a plus"],
    [{ address: ".dot@acme.test" }, "a leading dot"],
    [{ address: "a..b@acme.test" }, "a double dot"],
    [{ address: `${"x".repeat(65)}@acme.test` }, "a local part over 64"],
  ])("answers 422 for %j (%s), before the service", async (body) => {
    const w = world()
    const res = await send(appFor(w, "admin").app, "POST", base(), body)
    expect(res.status).toBe(422)
    expect(w.add).not.toHaveBeenCalled()
  })

  it("answers 422 for a body that is not JSON", async () => {
    const w = world()
    const res = await appFor(w, "admin").app.request(base(), {
      method: "POST",
      body: "nope",
    })
    expect(res.status).toBe(422)
    expect(w.add).not.toHaveBeenCalled()
  })

  it.each([
    ["not_found", 404, "not_found"],
    ["deleting", 409, "mailbox_deleting"],
    ["domain_not_hosted", 422, "validation_error"],
    ["taken", 409, "alias_taken"],
    ["limit", 409, "alias_limit_reached"],
  ] as const)("maps %s to %i %s", async (status, code, name) => {
    const w = world({ add: { status } })
    const res = await send(appFor(w, "admin").app, "POST", base(), {
      address: "sales@acme.test",
    })
    expect(res.status).toBe(code)
    expect((await named(res)).name).toBe(name)
  })
})

describe("DELETE /mailboxes/:address/aliases/:alias", () => {
  const path = `${base()}/${encodeURIComponent("Sales@Acme.test")}`

  it("removes it, naming the mailbox and the lowercased alias", async () => {
    const w = world()
    const res = await send(appFor(w, "admin").app, "DELETE", path)

    expect(res.status).toBe(200)
    expect(w.remove).toHaveBeenCalledWith({
      tenantId: TENANT,
      address: ADDRESS,
      alias: "sales@acme.test",
      actorId: people.admin,
    })
  })

  it("answers 404 when the alias is not this mailbox's and 409 when it is not the console's", async () => {
    const missing = world({ remove: { status: "not_found" } })
    expect((await send(appFor(missing, "admin").app, "DELETE", path)).status).toBe(404)

    const owned = world({ remove: { status: "not_removable" } })
    const res = await send(appFor(owned, "admin").app, "DELETE", path)
    expect(res.status).toBe(409)
    expect((await named(res)).name).toBe("alias_not_removable")
  })

  it("answers 404 for an alias that is not an address, without asking the service", async () => {
    const w = world()
    const res = await send(appFor(w, "admin").app, "DELETE", `${base()}/nope`)
    expect(res.status).toBe(404)
    expect(w.remove).not.toHaveBeenCalled()
  })
})
