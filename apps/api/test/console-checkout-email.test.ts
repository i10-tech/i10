import { describe, expect, it, mock } from "bun:test"
import { Hono } from "hono"
import { mountAccount } from "../src/routes/console/account.js"
import type { ConsoleDeps } from "../src/routes/console/deps.js"

/**
 * The console's checkout opens with the person's own verified address filled
 * in (2026-10-13) - read from the identity provider, never from the request,
 * and never a reason for the checkout to fail.
 */

function appWith(over: Record<string, unknown>) {
  const app = new Hono()
  app.use("*", async (c, next) => {
    c.set("auth", { apiKeyId: "", tenantId: "ten-1", scopes: [], mode: "live" })
    c.set("user", { userId: "user_1" })
    await next()
  })
  // Cast: the route touches a handful of fields - see console-rename.test.ts.
  mountAccount(app, {
    log: { error() {}, warn() {} },
    ...over,
  } as unknown as ConsoleDeps)
  return app
}

function deps(people: unknown) {
  const createCheckout = mock(async () => ({
    id: "co_1",
    url: "https://sandbox.polar.sh/checkout/co_1",
    expiresAt: "2026-10-14T00:00:00.000Z",
  }))
  return {
    createCheckout,
    over: {
      people,
      billing: {
        products: { pro: "prod_pro" },
        successUrl: "https://dash.i10.tech/settings/billing",
        polar: { createCheckout },
        subscriptions: { recordCheckout: mock(async () => {}) },
      },
    },
  }
}

const checkout = (app: Hono, body: unknown) =>
  app.request("/billing/checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

describe("POST /console/billing/checkout", () => {
  it("prefills the person's verified primary address, not one from the body", async () => {
    const { createCheckout, over } = deps({
      get: mock(async () => ({
        name: "Ada",
        primaryEmail: "ada@acme.com",
        verifiedEmails: ["ada@acme.com"],
      })),
    })
    const res = await checkout(appWith(over), { plan: "pro", email: "evil@x.com" })
    expect(res.status).toBe(200)
    const call = createCheckout.mock.calls[0] as unknown as [Record<string, unknown>]
    expect(call[0]).toMatchObject({ productId: "prod_pro", email: "ada@acme.com" })
  })

  it("leaves it empty when the address is not verified", async () => {
    const { createCheckout, over } = deps({
      get: mock(async () => ({
        name: "Ada",
        primaryEmail: "ada@acme.com",
        verifiedEmails: [],
      })),
    })
    await checkout(appWith(over), { plan: "pro" })
    const call = createCheckout.mock.calls[0] as unknown as [Record<string, unknown>]
    expect(call[0]).not.toHaveProperty("email")
  })

  it("still opens the checkout when the lookup fails", async () => {
    const { createCheckout, over } = deps({
      get: mock(async () => {
        throw new Error("clerk down")
      }),
    })
    const res = await checkout(appWith(over), { plan: "pro" })
    expect(res.status).toBe(200)
    expect(createCheckout).toHaveBeenCalled()
  })
})
