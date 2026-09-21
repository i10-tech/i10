import { describe, expect, it, mock } from "bun:test"
import { createApp } from "../src/app.js"
import type { SubscriptionOps } from "../src/billing/db.js"
import type { SubscriptionState } from "../src/billing/events.js"
import { subscriptionGrants } from "../src/billing/grants.js"
import { reconcileSubscriptions } from "../src/billing/reconcile.js"

const log = { info: () => {}, warn: () => {}, error: () => {} }

const state = (over: Partial<SubscriptionState> = {}): SubscriptionState => ({
  tenantId: "ten-1",
  polarSubscriptionId: "sub_1",
  polarCustomerId: "cus_1",
  polarProductId: "prod_pro",
  planId: "pro",
  status: "active",
  cancelAtPeriodEnd: false,
  currentPeriodEnd: new Date("2026-10-03T00:00:00Z"),
  eventAt: new Date("2026-09-03T12:00:00Z"),
  entitledPlanId: "pro",
  scheduledPlanId: null,
  scheduledAt: null,
  ...over,
})

const ops = (over: Partial<SubscriptionOps> = {}): SubscriptionOps => ({
  record: async () => "applied",
  markGranted: async () => {},
  snapshot: async () => [],
  // ⚠ A NO-OP HERE, BUT NOT OPTIONAL ON THE PORT. `plan-change` calls it inside
  // the try that reports a refusal, so a fake missing it turns every
  // cancellation test into "Polar could not apply the change" — which is
  // exactly the message the missing WRITE produced in production.
  noteCancelling: async () => {},
  current: async () => ({
    plan: null,
    status: null,
    cancelAtPeriodEnd: false,
    currentPeriodEnd: null,
    scheduledPlan: null,
    scheduledAt: null,
    polarSubscriptionId: null,
  }),
  ...over,
})

describe("granting a plan", () => {
  // ⚠ ROW FIRST, AUTUMN SECOND. A crash between them must leave the payment
  // recorded and the entitlement repairable, not an entitlement nothing knows
  // about.
  it("writes our row before it tells Autumn anything", async () => {
    const order: string[] = []
    const grants = subscriptionGrants({
      subscriptions: ops({
        record: async () => {
          order.push("record")
          return "applied"
        },
        markGranted: async () => {
          order.push("mark")
        },
      }),
      entitlements: {
        ensureCustomer: async () => {
          order.push("ensure")
        },
        grantPlan: async () => {
          order.push("grant")
        },
      },
      log,
    })

    await grants.apply(state())
    expect(order).toEqual(["record", "ensure", "grant", "mark"])
  })

  it("passes Polar's subscription id when granting the plan it bought", async () => {
    const grantPlan = mock(async () => {})
    const grants = subscriptionGrants({
      subscriptions: ops(),
      entitlements: { ensureCustomer: async () => {}, grantPlan },
      log,
    })

    await grants.apply(state())
    expect(grantPlan).toHaveBeenCalledWith({
      tenantId: "ten-1",
      planId: "pro",
      subscriptionId: "sub_1",
    })
  })

  // ⚠ THE DOWNGRADE MUST NOT CARRY IT, AND THIS IS THE TEST THAT WOULD HAVE
  // CAUGHT A REVOCATION LEAVING PRO SWITCHED ON. `subscription_id` asserts
  // "this attachment IS that Polar subscription"; the free plan is not the
  // subscription that just ended, and Autumn rejects the claim with 409
  // `duplicate_subscription_id` — so every downgrade failed.
  it("withholds it when dropping the tenant back to free", async () => {
    const grantPlan = mock(async () => {})
    const grants = subscriptionGrants({
      subscriptions: ops(),
      entitlements: { ensureCustomer: async () => {}, grantPlan },
      log,
    })

    await grants.apply(state({ status: "revoked", entitledPlanId: "free" }))
    expect(grantPlan).toHaveBeenCalledWith({ tenantId: "ten-1", planId: "free" })
  })

  // ⚠ THE OUT-OF-ORDER GUARD. A delayed `active` arriving after `revoked` must
  // not re-grant Pro to a customer who churned.
  it("does nothing at all when a newer event has already been applied", async () => {
    const grantPlan = mock(async () => {})
    const grants = subscriptionGrants({
      subscriptions: ops({ record: async () => "stale" }),
      entitlements: { ensureCustomer: async () => {}, grantPlan },
      log,
    })

    expect(await grants.apply(state())).toEqual({ status: "stale" })
    expect(grantPlan).not.toHaveBeenCalled()
  })

  it("marks the grant against the exact event it was made for", async () => {
    const markGranted = mock(async () => {})
    const grants = subscriptionGrants({
      subscriptions: ops({ markGranted }),
      entitlements: { ensureCustomer: async () => {}, grantPlan: async () => {} },
      log,
    })

    await grants.apply(state({ entitledPlanId: "free" }))
    expect(markGranted).toHaveBeenCalledWith(
      "ten-1",
      "free",
      new Date("2026-09-03T12:00:00Z"),
    )
  })

  // The row is durable by then, so the caller answering 500 gets a retry that
  // resumes rather than one that starts over.
  it("lets an Autumn failure reach the caller, after the row is written", async () => {
    const record = mock(async () => "applied" as const)
    const grants = subscriptionGrants({
      subscriptions: ops({ record }),
      entitlements: {
        ensureCustomer: async () => {},
        grantPlan: async () => {
          throw new Error("autumn is down")
        },
      },
      log,
    })

    await expect(grants.apply(state())).rejects.toThrow("autumn is down")
    expect(record).toHaveBeenCalled()
  })
})

const polarSub = (over: Record<string, unknown> = {}) => ({
  id: "sub_1",
  status: "active",
  product_id: "prod_pro",
  customer_id: "cus_1",
  customer: { external_id: "ten-1" },
  modified_at: "2026-09-03T12:00:00Z",
  ...over,
})

const options = {
  planForProduct: (id: string) => (id === "prod_pro" ? "pro" : undefined),
  freePlanId: "free",
}

const row = (over: Record<string, unknown> = {}) => ({
  tenantId: "ten-1",
  polarSubscriptionId: "sub_1",
  planId: "pro",
  status: "active",
  grantedPlanId: "pro",
  eventAt: new Date("2026-09-03T12:00:00Z"),
  ...over,
})

describe("reconciling against Polar", () => {
  /*
   * ⚠ THE ONE THING THE BACKSTOP CANNOT BACK UP, AND IT USED TO SKIP IT
   * SILENTLY. The reconciler attributes subscriptions by
   * `customer.external_id`, exactly as the webhook does — so a subscription
   * without one is invisible to both, and a bare `continue` meant a run could
   * report perfect agreement while somebody who had paid sat on the free plan
   * for ever.
   */
  it("reports a subscription it cannot attribute rather than skipping it", async () => {
    const apply = mock()
    const report = await reconcileSubscriptions({
      polar: {
        getCheckout: mock(),
        getCustomer: async () => null,
        setCustomerExternalId: async () => true,
        ingestEvents: async () => ({ inserted: 0, duplicates: 0 }),
        updateSubscription: async () => {},
        cancelSubscription: async () => {},
        revokeSubscription: async () => "revoked" as const,
        createCustomerSession: async () => ({ token: "polar_cst_test" }),
        listSubscriptions: async () => [polarSub({ customer: { external_id: null } })],
        createCheckout: mock(),
      },
      subscriptions: ops({ snapshot: async () => [] }),
      grants: { apply },
      options,
      log,
    })

    expect(report.stranded).toEqual([
      {
        subscriptionId: "sub_1",
        reason: "subscription sub_1 has no external customer id (customer cus_1)",
      },
    ])
    expect(report.checked).toBe(0)
    expect(apply).not.toHaveBeenCalled()
  })

  // ⚠ AND SOMEBODY ELSE'S PRODUCT IS NOT STRANDED. A Polar organisation can
  // sell things that are not i10 plans; reporting those would make the alert
  // fire on healthy state, which is how an alert stops being read.
  it("does not report a subscription for a product that is not ours", async () => {
    const report = await reconcileSubscriptions({
      polar: {
        getCheckout: mock(),
        getCustomer: async () => null,
        setCustomerExternalId: async () => true,
        ingestEvents: async () => ({ inserted: 0, duplicates: 0 }),
        updateSubscription: async () => {},
        cancelSubscription: async () => {},
        revokeSubscription: async () => "revoked" as const,
        createCustomerSession: async () => ({ token: "polar_cst_test" }),
        listSubscriptions: async () => [polarSub({ product_id: "prod_someone_else" })],
        createCheckout: mock(),
      },
      subscriptions: ops({ snapshot: async () => [] }),
      grants: { apply: mock() },
      options,
      log,
    })

    expect(report.stranded).toEqual([])
  })

  it("leaves a tenant alone when our record already agrees", async () => {
    const apply = mock()
    const report = await reconcileSubscriptions({
      polar: {
        getCheckout: mock(),
        ingestEvents: async () => ({ inserted: 0, duplicates: 0 }),
        updateSubscription: async () => {},
        cancelSubscription: async () => {},
        revokeSubscription: async () => "revoked" as const,
        createCustomerSession: async () => ({ token: "polar_cst_test" }),
        getCustomer: async () => null,
        setCustomerExternalId: async () => true,
        listSubscriptions: async () => [polarSub()],
        createCheckout: mock(),
      },
      subscriptions: ops({ snapshot: async () => [row()] }),
      grants: { apply },
      options,
      log,
    })

    expect(report).toMatchObject({ checked: 1, agreed: 1, repaired: 0 })
    expect(apply).not.toHaveBeenCalled()
  })

  // ⚠ POLAR NEVER DELETES A SUBSCRIPTION, AND WE HOLD ONE ROW PER TENANT. A
  // customer who has bought twice is two entries in the list and one row here,
  // so without collapsing them the dead subscription gets its own turn at
  // writing the live one's row.
  it("decides once per tenant when Polar lists several of their subscriptions", async () => {
    const apply = mock()
    const report = await reconcileSubscriptions({
      polar: {
        getCheckout: mock(),
        ingestEvents: async () => ({ inserted: 0, duplicates: 0 }),
        updateSubscription: async () => {},
        cancelSubscription: async () => {},
        revokeSubscription: async () => "revoked" as const,
        createCustomerSession: async () => ({ token: "polar_cst_test" }),
        getCustomer: async () => null,
        setCustomerExternalId: async () => true,
        listSubscriptions: async () => [
          polarSub({
            id: "sub_old",
            status: "canceled",
            modified_at: "2026-09-02T12:00:00Z",
          }),
          polarSub({ id: "sub_new", modified_at: "2026-09-03T12:00:00Z" }),
        ],
        createCheckout: mock(),
      },
      subscriptions: ops({
        snapshot: async () => [row({ polarSubscriptionId: "sub_new" })],
      }),
      grants: { apply },
      options,
      log,
    })

    expect(report).toMatchObject({ checked: 1, agreed: 1, repaired: 0, orphaned: [] })
    expect(apply).not.toHaveBeenCalled()
  })

  // ⚠ AND RECENCY ALONE IS NOT THE RULE. It answers the ordinary case only
  // because the new subscription happens to have been modified last; one touch
  // on the ended one after that, for any reason at all, and picking the most
  // recent downgrades somebody who is paying.
  it("lets a live subscription outrank a dead one modified more recently", async () => {
    const apply = mock()
    const report = await reconcileSubscriptions({
      polar: {
        getCheckout: mock(),
        ingestEvents: async () => ({ inserted: 0, duplicates: 0 }),
        updateSubscription: async () => {},
        cancelSubscription: async () => {},
        revokeSubscription: async () => "revoked" as const,
        createCustomerSession: async () => ({ token: "polar_cst_test" }),
        getCustomer: async () => null,
        setCustomerExternalId: async () => true,
        listSubscriptions: async () => [
          polarSub({ id: "sub_live", modified_at: "2026-09-03T12:00:00Z" }),
          polarSub({
            id: "sub_dead",
            status: "canceled",
            modified_at: "2026-09-04T12:00:00Z",
          }),
        ],
        createCheckout: mock(),
      },
      subscriptions: ops({
        snapshot: async () => [row({ polarSubscriptionId: "sub_live" })],
      }),
      grants: { apply },
      options,
      log,
    })

    expect(report).toMatchObject({ checked: 1, agreed: 1, repaired: 0 })
    expect(apply).not.toHaveBeenCalled()
  })

  it("grants a subscription we never received a webhook for", async () => {
    const apply = mock(async () => ({ status: "applied" as const, planId: "pro" }))
    const report = await reconcileSubscriptions({
      polar: {
        getCheckout: mock(),
        ingestEvents: async () => ({ inserted: 0, duplicates: 0 }),
        updateSubscription: async () => {},
        cancelSubscription: async () => {},
        revokeSubscription: async () => "revoked" as const,
        createCustomerSession: async () => ({ token: "polar_cst_test" }),
        getCustomer: async () => null,
        setCustomerExternalId: async () => true,
        listSubscriptions: async () => [polarSub()],
        createCheckout: mock(),
      },
      subscriptions: ops({ snapshot: async () => [] }),
      grants: { apply },
      options,
      log,
    })

    expect(report.repaired).toBe(1)
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "ten-1" }))
  })

  // ⚠ THE STATE THIS WHOLE DESIGN EXISTS TO SURVIVE: the row was written and
  // the Autumn call failed. Nothing else would ever surface it.
  it("repairs a row whose entitlement never reached Autumn", async () => {
    const apply = mock(async () => ({ status: "applied" as const, planId: "pro" }))
    await reconcileSubscriptions({
      polar: {
        getCheckout: mock(),
        ingestEvents: async () => ({ inserted: 0, duplicates: 0 }),
        updateSubscription: async () => {},
        cancelSubscription: async () => {},
        revokeSubscription: async () => "revoked" as const,
        createCustomerSession: async () => ({ token: "polar_cst_test" }),
        getCustomer: async () => null,
        setCustomerExternalId: async () => true,
        listSubscriptions: async () => [polarSub()],
        createCheckout: mock(),
      },
      subscriptions: ops({ snapshot: async () => [row({ grantedPlanId: null })] }),
      grants: { apply },
      options,
      log,
    })

    expect(apply).toHaveBeenCalled()
  })

  it("revokes a plan when Polar says the subscription ended", async () => {
    const apply = mock(async () => ({ status: "applied" as const, planId: "free" }))
    await reconcileSubscriptions({
      polar: {
        getCheckout: mock(),
        ingestEvents: async () => ({ inserted: 0, duplicates: 0 }),
        updateSubscription: async () => {},
        cancelSubscription: async () => {},
        revokeSubscription: async () => "revoked" as const,
        createCustomerSession: async () => ({ token: "polar_cst_test" }),
        getCustomer: async () => null,
        setCustomerExternalId: async () => true,
        listSubscriptions: async () => [
          polarSub({ status: "canceled", modified_at: "2026-09-04T12:00:00Z" }),
        ],
        createCheckout: mock(),
      },
      subscriptions: ops({ snapshot: async () => [row()] }),
      grants: { apply },
      options,
      log,
    })

    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ entitledPlanId: "free" }),
    )
  })

  // ⚠ THE SAFETY VALVE. Polar never deletes subscriptions, so absence means our
  // data is wrong or the token points at the wrong organisation — and acting on
  // it would downgrade every paying customer at once.
  it("reports a row Polar has no subscription for, and never downgrades it", async () => {
    const apply = mock()
    const report = await reconcileSubscriptions({
      polar: {
        getCheckout: mock(),
        ingestEvents: async () => ({ inserted: 0, duplicates: 0 }),
        updateSubscription: async () => {},
        cancelSubscription: async () => {},
        revokeSubscription: async () => "revoked" as const,
        createCustomerSession: async () => ({ token: "polar_cst_test" }),
        getCustomer: async () => null,
        setCustomerExternalId: async () => true,
        listSubscriptions: async () => [polarSub({ id: "sub_other" })],
        createCheckout: mock(),
      },
      subscriptions: ops({ snapshot: async () => [row({ tenantId: "ten-2" })] }),
      grants: { apply },
      options,
      log,
    })

    expect(report.orphaned).toEqual(["ten-2"])
    expect(apply).not.toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "ten-2" }),
    )
  })

  it("keeps going after one tenant fails, and reports it", async () => {
    const report = await reconcileSubscriptions({
      polar: {
        getCheckout: mock(),
        ingestEvents: async () => ({ inserted: 0, duplicates: 0 }),
        updateSubscription: async () => {},
        cancelSubscription: async () => {},
        revokeSubscription: async () => "revoked" as const,
        createCustomerSession: async () => ({ token: "polar_cst_test" }),
        getCustomer: async () => null,
        setCustomerExternalId: async () => true,
        listSubscriptions: async () => [
          polarSub({ id: "sub_1", customer: { external_id: "ten-1" } }),
          polarSub({ id: "sub_2", customer: { external_id: "ten-2" } }),
        ],
        createCheckout: mock(),
      },
      subscriptions: ops({ snapshot: async () => [] }),
      grants: {
        apply: mock(async (s) => {
          if (s.tenantId === "ten-1") throw new Error("autumn is down")
          return { status: "applied" as const, planId: "pro" }
        }),
      },
      options,
      log,
    })

    expect(report.failed).toEqual([{ tenantId: "ten-1", error: "autumn is down" }])
    expect(report.repaired).toBe(1)
  })
})

const KEY = "i10_live_abcdefghijklmnopqrstuvwxyz012345"
const apiKeyAuth = {
  lookup: {
    byHash: async () => ({
      id: "key-1",
      tenantId: "ten-1",
      scopes: ["emails:send"],
      mode: "live",
      revokedAt: null,
      expiresAt: null,
    }),
  },
  cache: { get: async () => null, set: async () => {}, del: async () => {} },
  ttlSeconds: 60,
}

const checkout = {
  id: "chk_1",
  url: "https://polar.sh/checkout/chk_1",
  expiresAt: "2026-09-03T13:00:00Z",
}

describe("POST /billing/checkout", () => {
  it("starts a checkout for the caller's own tenant", async () => {
    const createCheckout = mock(async () => checkout)
    const app = createApp({
      apiKeyAuth,
      billing: {
        polar: {
          getCheckout: mock(),
          createCheckout,
          listSubscriptions: mock(),
          ingestEvents: mock(),
          updateSubscription: mock(),
          cancelSubscription: mock(),
          revokeSubscription: mock(),
          createCustomerSession: mock(),
          getCustomer: mock(),
          setCustomerExternalId: async () => true,
        },
        subscriptions: ops(),
        products: { pro: "prod_pro" },
        successUrl: "https://console.i10.tech/billing",
        log,
      },
    })

    const res = await app.request("/billing/checkout", {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ plan: "pro" }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ url: checkout.url })
    expect(createCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ productId: "prod_pro", tenantId: "ten-1" }),
    )
  })

  // ⚠ A CALLER WHO COULD NAME A PRODUCT COULD NAME A ONE-CENT ONE and buy Pro
  // with it — and the webhook would grant it perfectly correctly, because from
  // Polar's side the payment really did succeed.
  it("refuses a plan that is not in our own product map", async () => {
    const createCheckout = mock(async () => checkout)
    const app = createApp({
      apiKeyAuth,
      billing: {
        polar: {
          getCheckout: mock(),
          createCheckout,
          listSubscriptions: mock(),
          ingestEvents: mock(),
          updateSubscription: mock(),
          cancelSubscription: mock(),
          revokeSubscription: mock(),
          createCustomerSession: mock(),
          getCustomer: mock(),
          setCustomerExternalId: async () => true,
        },
        subscriptions: ops(),
        products: { pro: "prod_pro" },
        log,
      },
    })

    const res = await app.request("/billing/checkout", {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ plan: "prod_free_forever" }),
    })

    expect(res.status).toBe(422)
    expect(createCheckout).not.toHaveBeenCalled()
  })

  it("needs an API key", async () => {
    const app = createApp({
      apiKeyAuth,
      billing: {
        polar: {
          getCheckout: mock(),
          createCheckout: mock(),
          ingestEvents: async () => ({ inserted: 0, duplicates: 0 }),
          updateSubscription: async () => {},
          cancelSubscription: async () => {},
          revokeSubscription: async () => "revoked" as const,
          createCustomerSession: async () => ({ token: "polar_cst_test" }),
          getCustomer: async () => null,
          setCustomerExternalId: async () => true,
          listSubscriptions: mock(),
        },
        subscriptions: ops(),
        products: { pro: "prod_pro" },
        log,
      },
    })

    const res = await app.request("/billing/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan: "pro" }),
    })

    expect(res.status).toBe(401)
  })
})

describe("GET /billing/plan", () => {
  // ⚠ WHAT AUTUMN WAS TOLD, NOT WHAT WAS BOUGHT. Showing the purchased plan
  // before the entitlement lands says "Pro" to somebody still being refused at
  // the send path.
  it("reports the entitlement in force", async () => {
    const app = createApp({
      apiKeyAuth,
      billing: {
        polar: {
          getCheckout: mock(),
          createCheckout: mock(),
          ingestEvents: async () => ({ inserted: 0, duplicates: 0 }),
          updateSubscription: async () => {},
          cancelSubscription: async () => {},
          revokeSubscription: async () => "revoked" as const,
          createCustomerSession: async () => ({ token: "polar_cst_test" }),
          getCustomer: async () => null,
          setCustomerExternalId: async () => true,
          listSubscriptions: mock(),
        },
        subscriptions: ops({
          current: async () => ({
            plan: "pro",
            status: "active",
            cancelAtPeriodEnd: true,
            currentPeriodEnd: new Date("2026-10-03T00:00:00Z"),
            scheduledPlan: null,
            scheduledAt: null,
            polarSubscriptionId: "sub_1",
          }),
        }),
        products: { pro: "prod_pro" },
        log,
      },
    })

    const res = await app.request("/billing/plan", {
      headers: { Authorization: `Bearer ${KEY}` },
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      plan: "pro",
      status: "active",
      cancelAtPeriodEnd: true,
      currentPeriodEnd: "2026-10-03T00:00:00.000Z",
      // ⚠ PRESENT AND NULL, NOT ABSENT. A deferred downgrade leaves every other
      // field describing the plan they are LEAVING — see billing/events.ts — so
      // this is the only thing that can say one was accepted, and a consumer
      // that had to distinguish "no change" from "an older API build" would
      // have to guess.
      scheduledPlan: null,
      scheduledAt: null,
    })
  })

  /**
   * ⚠ POLAR'S SUBSCRIPTION ID IS NOT FOR RENDERING. `current()` carries it so a
   * plan change has something to PATCH; putting it in this response would make
   * an internal identifier part of what the console is entitled to know, and
   * then part of what it eventually sends back.
   */
  it("does not expose polar's subscription id", async () => {
    const app = createApp({
      apiKeyAuth,
      billing: {
        polar: {
          getCheckout: mock(),
          createCheckout: mock(),
          ingestEvents: async () => ({ inserted: 0, duplicates: 0 }),
          updateSubscription: async () => {},
          cancelSubscription: async () => {},
          revokeSubscription: async () => "revoked" as const,
          createCustomerSession: async () => ({ token: "polar_cst_test" }),
          getCustomer: async () => null,
          setCustomerExternalId: async () => true,
          listSubscriptions: mock(),
        },
        subscriptions: ops({
          current: async () => ({
            plan: "pro",
            status: "active",
            cancelAtPeriodEnd: false,
            currentPeriodEnd: null,
            scheduledPlan: null,
            scheduledAt: null,
            polarSubscriptionId: "sub_secret",
          }),
        }),
        products: { pro: "prod_pro" },
        log,
      },
    })

    const res = await app.request("/billing/plan", {
      headers: { Authorization: `Bearer ${KEY}` },
    })
    expect(JSON.stringify(await res.json())).not.toContain("sub_secret")
  })
})
