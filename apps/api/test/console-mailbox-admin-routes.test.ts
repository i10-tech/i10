import { describe, expect, it, mock } from "bun:test"
import { Hono } from "hono"
import type { MailboxCreationMode } from "@repo/contracts"
import type { MailboxAdmin } from "../src/mailboxes/creation-mode.js"
import type { ProvisionOutcome } from "../src/mailboxes/provision.js"
import { mountMailboxAdmin } from "../src/routes/console/mailbox-admin.js"
import { mountMailboxes } from "../src/routes/console/mailboxes.js"
import type { ConsoleDeps } from "../src/routes/console/deps.js"

/**
 * The owner and admin side of mailboxes over HTTP: creating one for a member,
 * and the "who creates mailboxes" setting. The order of the refusals is the
 * point - role, then step-up, then body, then target - so each test that cares
 * says what it must not have reached.
 */

const TENANT = "3f1a0e00-0000-4000-8000-000000000001"
const people = { admin: "user_admin", member: "user_member", other: "user_other" }

const created: ProvisionOutcome = {
  status: "created",
  mailbox: {
    object: "mailbox",
    address: "bob@acme.test",
    display_name: null,
    active: true,
    created_at: new Date(0).toISOString(),
  },
}

function world(
  over: {
    outcome?: ProvisionOutcome
    mode?: MailboxCreationMode
    wired?: boolean
  } = {},
) {
  let mode: MailboxCreationMode = over.mode ?? "admins"
  const create = mock<MailboxAdmin["provisioning"]["create"]>(
    async () => over.outcome ?? created,
  )
  const set = mock(async (_t: string, _actor: string, next: MailboxCreationMode) => {
    const before = mode
    mode = next
    return { before, after: next }
  })
  const admin: MailboxAdmin = {
    provisioning: { create },
    settings: { get: async () => mode, set },
    isAdmin: async (_tenant, userId) => userId === people.admin,
    // `other` is a user of the product but not of this workspace.
    isMember: async (_tenant, userId) =>
      userId === people.admin || userId === people.member,
  }
  return { admin, create, set, mode: () => mode, wired: over.wired ?? true }
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
  const deps = (w.wired ? { mailboxAdmin: w.admin } : {}) as unknown as ConsoleDeps
  mountMailboxAdmin(app, deps)
  mountMailboxes(app, deps)
  return { app, stepUp }
}

const call = (app: Hono, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

const body = { user_id: people.member, address: "bob@acme.test" }

describe("POST /mailboxes (an admin creates one for a member)", () => {
  it("creates it for the member, acting as the admin in this workspace", async () => {
    const w = world()
    const res = await call(appFor(w, "admin").app, "POST", "/mailboxes", {
      ...body,
      display_name: "Bob",
      storage_allocation: 1024,
    })

    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ address: "bob@acme.test" })
    expect(w.create).toHaveBeenCalledWith(
      people.member,
      { address: "bob@acme.test", display_name: "Bob", storage_allocation: 1024 },
      { actorId: people.admin, tenantId: TENANT },
    )
  })

  it("takes the actor from the session, never from the body", async () => {
    const w = world()
    await call(appFor(w, "admin").app, "POST", "/mailboxes", {
      ...body,
      actorId: people.other,
      tenantId: "somebody-else",
    })

    expect(w.create.mock.calls[0]?.[2]).toEqual({
      actorId: people.admin,
      tenantId: TENANT,
    })
  })

  it("refuses a member with 403 and never asks them to step up", async () => {
    const w = world()
    const { app, stepUp } = appFor(w, "member", false)
    const res = await call(app, "POST", "/mailboxes", body)

    expect(res.status).toBe(403)
    expect(((await res.json()) as { name: string }).name).toBe("forbidden")
    expect(stepUp).not.toHaveBeenCalled()
    expect(w.create).not.toHaveBeenCalled()
  })

  it("asks an admin with a stale session to step up, before reading the body", async () => {
    const w = world()
    const res = await call(appFor(w, "admin", false).app, "POST", "/mailboxes", {
      nonsense: true,
    })

    expect(res.status).toBe(403)
    expect(((await res.json()) as { name: string }).name).toBe("invalid_access")
    expect(w.create).not.toHaveBeenCalled()
  })

  it("answers 422 for a body that is not valid, before the target is looked up", async () => {
    const w = world()
    const isMember = mock(w.admin.isMember)
    w.admin.isMember = isMember
    const { app } = appFor(w, "admin")

    for (const bad of [
      {},
      { address: "bob@acme.test" },
      { user_id: people.member },
      { ...body, address: "nope" },
      { ...body, storage_allocation: 0 },
    ]) {
      expect((await call(app, "POST", "/mailboxes", bad)).status).toBe(422)
    }
    expect(isMember).not.toHaveBeenCalled()
    expect(w.create).not.toHaveBeenCalled()
  })

  it("answers 404, not 403, for somebody who is not a member of this workspace", async () => {
    const w = world()
    const { app } = appFor(w, "admin")
    const stranger = await call(app, "POST", "/mailboxes", {
      ...body,
      user_id: people.other,
    })
    const unknown = await call(app, "POST", "/mailboxes", {
      ...body,
      user_id: "user_does_not_exist_anywhere",
    })

    // A real user of another workspace and an id that exists nowhere get the
    // same answer, so the route cannot be used to ask which is which.
    expect(stranger.status).toBe(404)
    expect(unknown.status).toBe(404)
    expect(await stranger.json()).toEqual(await unknown.json())
    expect(w.create).not.toHaveBeenCalled()
  })

  const cases: [string, ProvisionOutcome, number, string | null][] = [
    [
      "a taken address",
      { status: "conflict", reason: "taken" },
      409,
      "mailbox_already_exists",
    ],
    [
      "no password",
      { status: "password_required", reason: "no" },
      409,
      "password_required",
    ],
    [
      "mail sign-in off",
      { status: "mail_signin_off", reason: "off" },
      409,
      "mail_signin_off",
    ],
    ["a full plan", { status: "limit", reason: "full" }, 403, "plan_limit_exceeded"],
    ["a refused actor", { status: "forbidden", reason: "no" }, 403, "invalid_access"],
    [
      "a domain we do not host",
      { status: "rejected", reason: "no" },
      422,
      "validation_error",
    ],
  ]
  for (const [label, outcome, status, name] of cases) {
    it(`maps ${label} to ${status} ${name}`, async () => {
      const res = await call(
        appFor(world({ outcome }), "admin").app,
        "POST",
        "/mailboxes",
        body,
      )
      expect(res.status).toBe(status)
      expect(((await res.json()) as { name: string }).name).toBe(name!)
    })
  }

  it("answers 501 when it is not wired", async () => {
    const w = world({ wired: false })
    expect(
      (await call(appFor(w, "admin").app, "POST", "/mailboxes", body)).status,
    ).toBe(501)
  })
})

describe("the creation-mode setting", () => {
  it("shows an admin the mode, and the default is admins", async () => {
    const res = await call(
      appFor(world(), "admin").app,
      "GET",
      "/mailboxes/creation-mode",
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ mode: "admins" })
  })

  it("is not swallowed by the mailbox detail route", async () => {
    // mountMailboxes has `/mailboxes/:address` and no `d.mailboxes` here, which
    // would answer 501: getting the mode back proves the static path won.
    const res = await call(
      appFor(world({ mode: "on_join" }), "admin").app,
      "GET",
      "/mailboxes/creation-mode",
    )
    expect(await res.json()).toEqual({ mode: "on_join" })
  })

  it("refuses a member for both reading and changing it", async () => {
    const w = world()
    const { app, stepUp } = appFor(w, "member", false)

    expect((await call(app, "GET", "/mailboxes/creation-mode")).status).toBe(403)
    expect(
      (await call(app, "PUT", "/mailboxes/creation-mode", { mode: "members" })).status,
    ).toBe(403)
    expect(stepUp).not.toHaveBeenCalled()
    expect(w.set).not.toHaveBeenCalled()
  })

  it("changes it for an admin, recording who did", async () => {
    const w = world()
    const res = await call(appFor(w, "admin").app, "PUT", "/mailboxes/creation-mode", {
      mode: "on_join",
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ mode: "on_join" })
    expect(w.set).toHaveBeenCalledWith(TENANT, people.admin, "on_join")
  })

  it("asks for step-up on a change, and changes nothing without it", async () => {
    const w = world()
    const res = await call(
      appFor(w, "admin", false).app,
      "PUT",
      "/mailboxes/creation-mode",
      {
        mode: "members",
      },
    )

    expect(res.status).toBe(403)
    expect(w.set).not.toHaveBeenCalled()
    expect(w.mode()).toBe("admins")
  })

  it("answers 422 for a mode it does not know", async () => {
    const w = world()
    const { app } = appFor(w, "admin")
    for (const bad of [{ mode: "everyone" }, { mode: 1 }, {}]) {
      expect((await call(app, "PUT", "/mailboxes/creation-mode", bad)).status).toBe(422)
    }
    expect(w.set).not.toHaveBeenCalled()
  })

  it("answers 501 when it is not wired", async () => {
    const w = world({ wired: false })
    expect(
      (await call(appFor(w, "admin").app, "GET", "/mailboxes/creation-mode")).status,
    ).toBe(501)
  })
})
