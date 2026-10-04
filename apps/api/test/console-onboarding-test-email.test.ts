import { describe, expect, it, mock } from "bun:test"
import { Hono } from "hono"
import { mountAccount } from "../src/routes/console/account.js"
import type { ConsoleDeps } from "../src/routes/console/deps.js"

/**
 * Set-up's "Send email" (2026-10-03): one real send from a verified domain to
 * the signed-in person, once per workspace.
 */

const log = { error: () => {}, warn: () => {} }

function appWith(over: Partial<ConsoleDeps>) {
  const app = new Hono()
  app.use("*", async (c, next) => {
    c.set("auth", { apiKeyId: "", tenantId: "ten-1", scopes: [], mode: "live" })
    c.set("user", { userId: "user_1" })
    await next()
  })
  // ⚠ CAST, as in console-rename.test.ts: the route touches five fields.
  mountAccount(app, { log, ...over } as unknown as ConsoleDeps)
  return app
}

const send = (app: Hono, body: unknown) =>
  app.request("/onboarding/test-email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

function deps(over: Partial<ConsoleDeps> = {}, hasKey = true, verified = true) {
  return {
    usage: { billing: mock(async () => ({ plan: { id: "free" } })) },
    onboarding: {
      get: mock(async () => ({
        facts: { has_domain: true, has_verified_domain: true, has_api_key: hasKey },
      })),
    },
    people: {
      get: mock(async () => ({
        name: "Ada Lovelace",
        primaryEmail: "me@acme.com",
        verifiedEmails: verified ? ["me@acme.com"] : [],
      })),
    },
    sendableFrom: mock(
      async (_t: string, names: string[]) =>
        new Set(names.filter((n) => n === "acme.com")),
    ),
    profile: { get: mock(async () => ({ name: "Acme" })) },
    sendTest: mock(async () => ({ status: "accepted", ids: ["msg_1"] })),
    ...over,
  } as unknown as Partial<ConsoleDeps>
}

describe("POST /console/onboarding/test-email", () => {
  it("sends from the domain to the signed-in person, with a fixed idempotency key", async () => {
    const d = deps()
    const res = await send(appWith(d), { domain: "Acme.com" })

    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({
      id: "msg_1",
      to: "me@acme.com",
      replayed: false,
    })
    const call = (d.sendTest as ReturnType<typeof mock>).mock.calls[0] as unknown[]
    expect(call[0]).toBe("ten-1")
    expect(call[1]).toMatchObject({ from: "i10 <hello@acme.com>", to: ["me@acme.com"] })
    expect(call[2]).toEqual({ idempotencyKey: "onboarding-test-email:ten-1" })
  })

  /*
   * ⚠ THE SHARED WELCOME TEMPLATE, the same one the step's snippet names,
   * filled with the person's first name and the workspace's name.
   */
  it("sends the welcome template, not a body of its own", async () => {
    const d = deps()
    await send(appWith(d), { domain: "acme.com" })
    const call = (d.sendTest as ReturnType<typeof mock>).mock.calls[0] as unknown[]
    expect(call[1]).toMatchObject({
      template: { id: "welcome", variables: { name: "Ada", company: "Acme" } },
    })
    expect(call[1]).not.toHaveProperty("html")
    expect(call[1]).not.toHaveProperty("subject")
  })

  /*
   * ⚠ A SECOND PRESS IS NOT AN ERROR. The key makes it a replay; the person
   * sees the same send, and nothing goes out twice.
   */
  it("answers a second press with the first send, not a new one", async () => {
    const d = deps({
      sendTest: mock(async () => ({ status: "replayed", ids: ["msg_1"] })),
    } as unknown as Partial<ConsoleDeps>)
    const res = await send(appWith(d), { domain: "acme.com" })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: "msg_1", replayed: true })
  })

  it("refuses a domain the workspace cannot send from", async () => {
    const d = deps()
    const res = await send(appWith(d), { domain: "other.com" })

    expect(res.status).toBe(422)
    expect(d.sendTest).not.toHaveBeenCalled()
  })

  it("refuses before a key exists", async () => {
    const d = deps({}, false)
    const res = await send(appWith(d), { domain: "acme.com" })

    expect(res.status).toBe(422)
    expect(d.sendTest).not.toHaveBeenCalled()
  })

  /*
   * ⚠ THE RECIPIENT IS NEVER THE CALLER'S TO CHOOSE. A `to` in the body is
   * ignored, so this cannot be used to mail a stranger from a verified domain.
   */
  it("ignores any recipient in the body", async () => {
    const d = deps()
    await send(appWith(d), { domain: "acme.com", to: "victim@else.com" })

    const call = (d.sendTest as ReturnType<typeof mock>).mock.calls[0] as unknown[]
    expect(call[1]).toMatchObject({ to: ["me@acme.com"] })
  })

  /*
   * ⚠ WITH NO VERIFIED ADDRESS, THE TYPED ONE IS USED - and only then.
   */
  it("uses a typed recipient when the person has no verified address", async () => {
    const d = deps({}, true, false)
    const res = await send(appWith(d), { domain: "acme.com", to: "inbox@else.com" })

    expect(res.status).toBe(201)
    const call = (d.sendTest as ReturnType<typeof mock>).mock.calls[0] as unknown[]
    expect(call[1]).toMatchObject({ to: ["inbox@else.com"] })
  })

  it("refuses a typed recipient that is not an address", async () => {
    const d = deps({}, true, false)
    const res = await send(appWith(d), { domain: "acme.com", to: "nope" })

    expect(res.status).toBe(422)
    expect(d.sendTest).not.toHaveBeenCalled()
  })
})
