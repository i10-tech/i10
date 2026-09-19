import { describe, expect, it, mock } from "bun:test"
import { createApp } from "../src/app.js"
import type { SubscriptionOps } from "../src/billing/db.js"
import type { CheckoutState, CustomerState, PolarClient } from "../src/billing/polar.js"

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
    polarSubscriptionId: "sub_1",
  }),
  ...over,
})

const polar = (
  checkout: CheckoutState | null,
  customer: CustomerState | null = { id: "cus_1", externalId: "ten-1" },
): PolarClient => ({
  createCheckout: async () => ({ id: "c1", url: "https://x", expiresAt: "" }),
  getCheckout: async () => checkout,
  getCustomer: async () => customer,
  ingestEvents: async () => ({ inserted: 0, duplicates: 0 }),
  updateSubscription: async () => {},
  cancelSubscription: async () => {},
  createCustomerSession: async () => ({ token: "polar_cst_test" }),
  listSubscriptions: async () => [],
})

const succeeded: CheckoutState = {
  id: "c1",
  status: "succeeded",
  tenantId: "ten-1",
  customerId: "cus_1",
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
            polarSubscriptionId: "sub_1",
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
    const current = mock(async () => ({
      plan: "pro",
      status: "active",
      cancelAtPeriodEnd: false,
      currentPeriodEnd: null,
      polarSubscriptionId: "sub_1",
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

  /*
   * ⚠ THE ONE PENDING STATE THAT IS NOT PENDING. Polar sets a customer's
   * `external_id` only on a customer it CREATES from the checkout, so a
   * checkout that resolved to a customer Polar already had carries no tenant id
   * on that record — and `toState` drops every subscription event for it, in
   * the webhook AND in the reconciler, by the same rule. Reporting this as the
   * ordinary "any second now" is what left somebody watching an amber page for
   * a payment nothing was ever going to grant.
   */
  it("names a paid checkout whose Polar customer does not carry our tenant id", async () => {
    const app = createApp({
      checkoutStatus: {
        polar: polar(succeeded, { id: "cus_1", externalId: null }),
        subscriptions: ops(),
        log,
      },
    })

    expect(await (await ask(app)).json()).toMatchObject({
      status: "paid",
      detail: "unattributed",
    })
  })

  it("says nothing about attribution while the grant is merely in flight", async () => {
    const app = createApp({
      checkoutStatus: { polar: polar(succeeded), subscriptions: ops(), log },
    })

    expect(await (await ask(app)).json()).not.toHaveProperty("detail")
  })

  // ⚠ A FAILED LOOKUP IS NOT A VERDICT. Polar being briefly unreachable for
  // this one extra question must not tell somebody their payment is stranded.
  it("keeps saying `paid` when the customer cannot be read", async () => {
    const app = createApp({
      checkoutStatus: {
        polar: {
          ...polar(succeeded),
          getCustomer: async () => {
            throw new Error("polar is down")
          },
        },
        subscriptions: ops(),
        log,
      },
    })

    const body = await (await ask(app)).json()
    expect(body).toMatchObject({ status: "paid" })
    expect(body).not.toHaveProperty("detail")
  })

  // ⚠ NOT ASKED AT ALL ONCE THE PLAN IS ON. The extra call belongs to the
  // window before the webhook lands, not to every reload of a settled page.
  it("does not read the customer once the grant exists", async () => {
    const getCustomer = mock(async () => ({ id: "cus_1", externalId: null }))

    const app = createApp({
      checkoutStatus: {
        polar: { ...polar(succeeded), getCustomer },
        subscriptions: ops({
          current: async () => ({
            plan: "pro",
            status: "active",
            cancelAtPeriodEnd: false,
            currentPeriodEnd: null,
            polarSubscriptionId: "sub_1",
          }),
        }),
        log,
      },
    })

    await ask(app)
    expect(getCustomer).not.toHaveBeenCalled()
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
