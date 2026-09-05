import { describe, expect, it, vi } from "vitest"
import { createApp } from "../src/app.js"
import type { SubscriptionOps } from "../src/billing/db.js"
import type { CheckoutState, PolarClient } from "../src/billing/polar.js"

const log = { info: () => {}, warn: () => {}, error: () => {} }

const ops = (over: Partial<SubscriptionOps> = {}): SubscriptionOps => ({
  record: async () => "applied",
  markGranted: async () => {},
  snapshot: async () => [],
  current: async () => ({
    plan: null,
    status: null,
    cancelAtPeriodEnd: false,
    currentPeriodEnd: null,
  }),
  ...over,
})

const polar = (checkout: CheckoutState | null): PolarClient => ({
  createCheckout: async () => ({ id: "c1", url: "https://x", expiresAt: "" }),
  getCheckout: async () => checkout,
  ingestEvents: async () => ({ inserted: 0, duplicates: 0 }),
  listSubscriptions: async () => [],
})

const succeeded: CheckoutState = {
  id: "c1",
  status: "succeeded",
  tenantId: "ten-1",
}

const ask = (app: ReturnType<typeof createApp>, id = "c1") =>
  app.request(`/checkout-status/${id}`)

describe("the post-checkout status page", () => {
  // ⚠ THE WHOLE REASON THIS ENDPOINT EXISTS. Polar's redirect is a browser
  // navigation anyone can perform, so paying is necessary but not sufficient:
  // until `granted_plan_id` is set, the entitlement does not exist and the page
  // must not claim it does.
  it("says `paid`, not `granted`, until our row records the grant", async () => {
    const app = createApp({
      checkoutStatus: { polar: polar(succeeded), subscriptions: ops(), log },
    })

    const res = await ask(app)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: "paid", plan: null })
  })

  it("says `granted` once the webhook has moved the row", async () => {
    const app = createApp({
      checkoutStatus: {
        polar: polar(succeeded),
        subscriptions: ops({
          current: async () => ({
            plan: "pro",
            status: "active",
            cancelAtPeriodEnd: false,
            currentPeriodEnd: null,
          }),
        }),
        log,
      },
    })

    expect(await (await ask(app)).json()).toMatchObject({
      status: "granted",
      plan: "pro",
    })
  })

  // ⚠ THE TENANT COMES FROM POLAR, NEVER FROM THE REQUEST. Were it a query
  // parameter, anyone could read anyone's plan by editing the URL.
  it("reads the tenant off Polar's copy of the checkout", async () => {
    const current = vi.fn(async () => ({
      plan: "pro",
      status: "active",
      cancelAtPeriodEnd: false,
      currentPeriodEnd: null,
    }))

    const app = createApp({
      checkoutStatus: {
        polar: polar({ ...succeeded, tenantId: "ten-from-polar" }),
        subscriptions: ops({ current }),
        log,
      },
    })

    await ask(app)
    expect(current).toHaveBeenCalledWith("ten-from-polar")
  })

  it("reports an unfinished checkout as unpaid, with Polar's own word", async () => {
    const app = createApp({
      checkoutStatus: {
        polar: polar({ ...succeeded, status: "expired" }),
        subscriptions: ops(),
        log,
      },
    })

    expect(await (await ask(app)).json()).toMatchObject({
      status: "unpaid",
      detail: "expired",
    })
  })

  // A checkout Polar has never heard of and one carrying no tenant answer the
  // same, so probing ids cannot distinguish them.
  it("answers `unknown` for an id Polar does not know", async () => {
    const app = createApp({
      checkoutStatus: { polar: polar(null), subscriptions: ops(), log },
    })

    expect(await (await ask(app)).json()).toMatchObject({ status: "unknown" })
  })

  it("answers `unknown` for a checkout that is not ours", async () => {
    const app = createApp({
      checkoutStatus: {
        polar: polar({ ...succeeded, tenantId: null }),
        subscriptions: ops(),
        log,
      },
    })

    expect(await (await ask(app)).json()).toMatchObject({ status: "unknown" })
  })

  // ⚠ NEVER A VERDICT ON AN OUTAGE. Answering "unpaid" because Polar timed out
  // tells somebody who has just paid that they have not — the same reasoning
  // that makes authd answer `unavailable` rather than `invalidCredentials`.
  it("answers 503 when Polar cannot be reached", async () => {
    const app = createApp({
      checkoutStatus: {
        polar: {
          ...polar(null),
          getCheckout: async () => {
            throw new Error("polar is down")
          },
        },
        subscriptions: ops(),
        log,
      },
    })

    const res = await ask(app)
    expect(res.status).toBe(503)
  })

  it("answers 501 rather than 200 when billing is not configured", async () => {
    const res = await ask(createApp({}))
    expect(res.status).toBe(501)
  })

  // ⚠ THE ENDPOINT IS PUBLIC BY DESIGN, AND THIS PINS THAT IT IS THE ONLY
  // BILLING ROUTE THAT IS. `/billing/*` stays behind requireApiKey.
  it("needs no API key, while /billing/plan still does", async () => {
    const app = createApp({
      checkoutStatus: { polar: polar(succeeded), subscriptions: ops(), log },
    })

    expect((await ask(app)).status).toBe(200)
    expect((await app.request("/billing/plan")).status).not.toBe(200)
  })
})
