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
    scheduledPlan: null,
    scheduledAt: null,
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
  setCustomerExternalId: async () => true,
  ingestEvents: async () => ({ inserted: 0, duplicates: 0 }),
  updateSubscription: async () => {},
  cancelSubscription: async () => {},
  revokeSubscription: async () => "revoked" as const,
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
            scheduledPlan: null,
            scheduledAt: null,
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
      scheduledPlan: null,
      scheduledAt: null,
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
   * ⚠ THE ONE PENDING STATE THAT IS NOT PENDING, AND IT IS NOW REPAIRED RATHER
   * THAN REPORTED. Polar sets a customer's `external_id` only on a customer it
   * CREATES from the checkout, so a checkout that resolved to a customer Polar
   * already had carries no tenant id — and `toState` drops every subscription
   * event for it, in the webhook AND the reconciler, by the same rule. Telling
   * the customer to email support was the old answer; the id is ours to write.
   */
  it("writes our tenant id onto a paid checkout's customer that has none", async () => {
    const wrote = mock(async () => true)
    const app = createApp({
      checkoutStatus: {
        polar: {
          ...polar(succeeded, { id: "cus_1", externalId: null }),
          setCustomerExternalId: wrote,
        },
        subscriptions: ops(),
        log,
      },
    })

    const body = await (await ask(app)).json()

    expect(wrote).toHaveBeenCalledWith("cus_1", "ten-1")
    // Repaired, so it is an ordinary wait rather than a dead end.
    expect(body).toMatchObject({ status: "paid" })
    expect(body).not.toHaveProperty("detail")
  })

  /*
   * ⚠ A CUSTOMER CARRYING SOMEBODY ELSE'S TENANT ID IS A COLLISION, NOT A GAP.
   * Stamping ours over it would move another workspace's billing onto this one
   * — a far worse outcome than the stuck page it would fix.
   */
  it("refuses to overwrite a different tenant's id, and says so", async () => {
    const wrote = mock(async () => true)
    const app = createApp({
      checkoutStatus: {
        polar: {
          ...polar(succeeded, { id: "cus_1", externalId: "someone-else" }),
          setCustomerExternalId: wrote,
        },
        subscriptions: ops(),
        log,
      },
    })

    expect(await (await ask(app)).json()).toMatchObject({
      status: "paid",
      detail: "unattributed",
    })
    expect(wrote).not.toHaveBeenCalled()
  })

  // ⚠ A REPAIR THAT DID NOT LAND IS STILL A DEAD END, and must read as one.
  it("still reports unattributed when the write fails", async () => {
    const app = createApp({
      checkoutStatus: {
        polar: {
          ...polar(succeeded, { id: "cus_1", externalId: null }),
          setCustomerExternalId: async () => false,
        },
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
            scheduledPlan: null,
            scheduledAt: null,
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

/*
 * ⚠ THE REPORTED BUG, AND IT IS A PERMANENT ONE RATHER THAN A DELAY. Polar
 * deduplicates customers by email, so somebody who subscribed, deleted their
 * account and signed up again is handed back the SAME Polar customer — still
 * carrying their FIRST tenant's `external_id`. Every subscription event for it
 * is then attributed to a workspace that no longer exists, in the webhook and
 * the reconciler alike, and refusing to overwrite the id as a "collision" meant
 * no path could ever fix it: money taken, no plan, for ever.
 */
describe("a Polar customer left behind by a deleted workspace", () => {
  const grants = () => ({ apply: mock(async () => ({ status: "applied" })) })

  const paidSub = {
    id: "sub_new",
    status: "active",
    product_id: "prod_pro",
    customer_id: "cus_1",
    customer: { external_id: "ten-1" },
    modified_at: "2026-09-20T10:00:00Z",
  }

  const options = {
    planForProduct: (id: string) => (id === "prod_pro" ? "pro" : undefined),
    freePlanId: "free",
  }

  it("is reclaimed when the tenant holding it is gone", async () => {
    const wrote = mock(async () => true)
    const app = createApp({
      checkoutStatus: {
        polar: {
          ...polar(succeeded, { id: "cus_1", externalId: "ten-deleted" }),
          setCustomerExternalId: wrote,
          listSubscriptions: async () => [paidSub],
        },
        subscriptions: ops(),
        tenants: { isLive: async () => false },
        grants: grants(),
        options,
        log,
      },
    })

    const body = await (await ask(app)).json()

    expect(wrote).toHaveBeenCalledWith("cus_1", "ten-1")
    // Not `unattributed`: there is nothing for a human to do here.
    expect(body).not.toMatchObject({ detail: "unattributed" })
  })

  // ⚠ THE OTHER HALF, AND IT IS THE ONE THAT PROTECTS SOMEBODY ELSE'S MONEY. A
  // live tenant's id is not ours to take, however inconvenient the dead end is.
  it("is not reclaimed when that tenant is still live", async () => {
    const wrote = mock(async () => true)
    const app = createApp({
      checkoutStatus: {
        polar: {
          ...polar(succeeded, { id: "cus_1", externalId: "ten-other" }),
          setCustomerExternalId: wrote,
        },
        subscriptions: ops(),
        tenants: { isLive: async () => true },
        log,
      },
    })

    expect(await (await ask(app)).json()).toMatchObject({ detail: "unattributed" })
    expect(wrote).not.toHaveBeenCalled()
  })

  // ⚠ NOT BEING ABLE TO ASK IS NOT PERMISSION TO ASSUME. Without the dep the
  // route must behave exactly as it did before it existed.
  it("is not reclaimed when there is nothing to ask about liveness", async () => {
    const wrote = mock(async () => true)
    const app = createApp({
      checkoutStatus: {
        polar: {
          ...polar(succeeded, { id: "cus_1", externalId: "ten-other" }),
          setCustomerExternalId: wrote,
        },
        subscriptions: ops(),
        log,
      },
    })

    expect(await (await ask(app)).json()).toMatchObject({ detail: "unattributed" })
    expect(wrote).not.toHaveBeenCalled()
  })

  /*
   * ⚠ AND THE RECLAIM MUST NOT LET THE DEAD SUBSCRIPTION DECIDE. The customer
   * this path exists for has two subscriptions — the one from the account they
   * deleted and the one they just bought — and Polar returns both, for ever.
   * Applying them in list order lets the cancelled one write the live one's row.
   */
  it("grants from the live subscription, not the one that ended", async () => {
    // ⚠ THE STATE IS CAPTURED RATHER THAN READ OFF `mock.calls`, so the
    // assertion below names the subscription that decided, not an index.
    const decidedFrom: { polarSubscriptionId: string; entitledPlanId: string }[] = []
    const applied = mock(
      async (state: { polarSubscriptionId: string; entitledPlanId: string }) => {
        decidedFrom.push(state)
        return { status: "applied" }
      },
    )
    const app = createApp({
      checkoutStatus: {
        polar: {
          ...polar(succeeded, { id: "cus_1", externalId: null }),
          listSubscriptions: async () => [
            paidSub,
            {
              id: "sub_old",
              status: "canceled",
              product_id: "prod_pro",
              customer_id: "cus_1",
              customer: { external_id: "ten-1" },
              // ⚠ MODIFIED LATER THAN THE LIVE ONE, WHICH IS THE WHOLE TRAP.
              // Revoking the old subscription at deletion touches it, so
              // "newest wins" picks the dead one.
              modified_at: "2026-09-20T11:00:00Z",
            },
          ],
        },
        subscriptions: ops(),
        grants: { apply: applied },
        options,
        log,
      },
    })

    await ask(app)

    expect(applied).toHaveBeenCalledTimes(1)
    expect(decidedFrom[0]).toMatchObject({
      polarSubscriptionId: "sub_new",
      entitledPlanId: "pro",
    })
  })
})

/*
 * ⚠ THE HALF-HOUR WAIT, WHICH IS WHAT THE PAGE USED TO PROMISE. The immediate
 * grant used to run only after an attribution repair, so an ordinary lost
 * webhook meant ninety seconds of spinner and then "we check for stragglers
 * every half hour" — a job the customer cannot see, for a payment they have
 * already made.
 */
describe("granting without waiting for the webhook", () => {
  const options = {
    planForProduct: (id: string) => (id === "prod_pro" ? "pro" : undefined),
    freePlanId: "free",
  }

  const live = {
    id: "sub_1",
    status: "active",
    product_id: "prod_pro",
    customer_id: "cus_1",
    customer: { external_id: "ten-1" },
    modified_at: "2026-09-20T10:00:00Z",
  }

  it("grants a paid checkout whose attribution never needed repairing", async () => {
    const applied = mock(async () => ({ status: "applied" }))
    const app = createApp({
      checkoutStatus: {
        // `externalId` already ours: nothing to repair, and the old code did
        // nothing at all in this case.
        polar: {
          ...polar(succeeded, { id: "cus_1", externalId: "ten-1" }),
          listSubscriptions: async () => [live],
        },
        subscriptions: ops(),
        grants: { apply: applied },
        options,
        log,
      },
    })

    await ask(app)
    expect(applied).toHaveBeenCalledTimes(1)
  })

  // ⚠ THERE IS GENUINELY NOTHING TO GRANT FOR A STRANDED CHECKOUT — no
  // subscription of that customer's belongs to this tenant — and asking Polar
  // on every poll for an answer that cannot change is just load.
  it("does not try to grant a stranded checkout", async () => {
    const listed = mock(async () => [live])
    const app = createApp({
      checkoutStatus: {
        polar: {
          ...polar(succeeded, { id: "cus_1", externalId: "ten-other" }),
          listSubscriptions: listed,
        },
        subscriptions: ops(),
        tenants: { isLive: async () => true },
        grants: { apply: mock(async () => ({ status: "applied" })) },
        options,
        log,
      },
    })

    await ask(app)
    expect(listed).not.toHaveBeenCalled()
  })

  // ⚠ THE PAGE POLLS EVERY TWO SECONDS FOR UP TO NINETY. Without a floor that
  // is forty-five list calls against Polar for one customer's one answer.
  it("does not ask Polar again on every poll of the same checkout", async () => {
    const listed = mock(async () => [live])
    const app = createApp({
      checkoutStatus: {
        polar: {
          ...polar(succeeded, { id: "cus_1", externalId: "ten-1" }),
          listSubscriptions: listed,
        },
        subscriptions: ops(),
        grants: { apply: mock(async () => ({ status: "applied" })) },
        options,
        log,
      },
    })

    await ask(app)
    await ask(app)
    await ask(app)

    expect(listed).toHaveBeenCalledTimes(1)
  })

  // ⚠ IT REPORTS THE ROW, NOT THE CALL. `grantNow` is best effort, so answering
  // `granted` because it did not throw would claim an entitlement nobody
  // confirmed — the exact lie `granted_plan_id` exists to prevent.
  it("still says `paid` when the grant did not land", async () => {
    const app = createApp({
      checkoutStatus: {
        polar: {
          ...polar(succeeded, { id: "cus_1", externalId: "ten-1" }),
          listSubscriptions: async () => {
            throw new Error("polar list is down")
          },
        },
        subscriptions: ops(),
        grants: { apply: mock(async () => ({ status: "applied" })) },
        options,
        log,
      },
    })

    expect(await (await ask(app)).json()).toMatchObject({ status: "paid" })
  })
})
