import { describe, expect, it, vi } from "vitest"
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
  ...over,
})

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
    const grantPlan = vi.fn(async () => {})
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
    const grantPlan = vi.fn(async () => {})
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
    const grantPlan = vi.fn(async () => {})
    const grants = subscriptionGrants({
      subscriptions: ops({ record: async () => "stale" }),
      entitlements: { ensureCustomer: async () => {}, grantPlan },
      log,
    })

    expect(await grants.apply(state())).toEqual({ status: "stale" })
    expect(grantPlan).not.toHaveBeenCalled()
  })

  it("marks the grant against the exact event it was made for", async () => {
    const markGranted = vi.fn(async () => {})
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
    const record = vi.fn(async () => "applied" as const)
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
  it("leaves a tenant alone when our record already agrees", async () => {
    const apply = vi.fn()
    const report = await reconcileSubscriptions({
      polar: {
        getCheckout: vi.fn(),
        ingestEvents: async () => ({ inserted: 0, duplicates: 0 }),
        listSubscriptions: async () => [polarSub()],
        createCheckout: vi.fn(),
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
    const apply = vi.fn()
    const report = await reconcileSubscriptions({
      polar: {
        getCheckout: vi.fn(),
        ingestEvents: async () => ({ inserted: 0, duplicates: 0 }),
        listSubscriptions: async () => [
          polarSub({
            id: "sub_old",
            status: "canceled",
            modified_at: "2026-09-02T12:00:00Z",
          }),
          polarSub({ id: "sub_new", modified_at: "2026-09-03T12:00:00Z" }),
        ],
        createCheckout: vi.fn(),
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
    const apply = vi.fn()
    const report = await reconcileSubscriptions({
      polar: {
        getCheckout: vi.fn(),
        ingestEvents: async () => ({ inserted: 0, duplicates: 0 }),
        listSubscriptions: async () => [
          polarSub({ id: "sub_live", modified_at: "2026-09-03T12:00:00Z" }),
          polarSub({
            id: "sub_dead",
            status: "canceled",
            modified_at: "2026-09-04T12:00:00Z",
          }),
        ],
        createCheckout: vi.fn(),
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
    const apply = vi.fn(async () => ({ status: "applied" as const, planId: "pro" }))
    const report = await reconcileSubscriptions({
      polar: {
        getCheckout: vi.fn(),
        ingestEvents: async () => ({ inserted: 0, duplicates: 0 }),
        listSubscriptions: async () => [polarSub()],
        createCheckout: vi.fn(),
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
    const apply = vi.fn(async () => ({ status: "applied" as const, planId: "pro" }))
    await reconcileSubscriptions({
      polar: {
        getCheckout: vi.fn(),
        ingestEvents: async () => ({ inserted: 0, duplicates: 0 }),
        listSubscriptions: async () => [polarSub()],
        createCheckout: vi.fn(),
      },
      subscriptions: ops({ snapshot: async () => [row({ grantedPlanId: null })] }),
      grants: { apply },
      options,
      log,
    })

    expect(apply).toHaveBeenCalled()
  })

  it("revokes a plan when Polar says the subscription ended", async () => {
    const apply = vi.fn(async () => ({ status: "applied" as const, planId: "free" }))
    await reconcileSubscriptions({
      polar: {
        getCheckout: vi.fn(),
        ingestEvents: async () => ({ inserted: 0, duplicates: 0 }),
        listSubscriptions: async () => [
          polarSub({ status: "canceled", modified_at: "2026-09-04T12:00:00Z" }),
        ],
        createCheckout: vi.fn(),
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
    const apply = vi.fn()
    const report = await reconcileSubscriptions({
      polar: {
        getCheckout: vi.fn(),
        ingestEvents: async () => ({ inserted: 0, duplicates: 0 }),
        listSubscriptions: async () => [polarSub({ id: "sub_other" })],
        createCheckout: vi.fn(),
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
        getCheckout: vi.fn(),
        ingestEvents: async () => ({ inserted: 0, duplicates: 0 }),
        listSubscriptions: async () => [
          polarSub({ id: "sub_1", customer: { external_id: "ten-1" } }),
          polarSub({ id: "sub_2", customer: { external_id: "ten-2" } }),
        ],
        createCheckout: vi.fn(),
      },
      subscriptions: ops({ snapshot: async () => [] }),
      grants: {
        apply: vi.fn(async (s) => {
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
  verify: async () =>
    ({
      id: "ak_1",
      scopes: ["emails:send"],
      claims: { tenantId: "ten-1", mode: "live" },
      revoked: false,
      expired: false,
    }) as never,
  cache: { get: async () => null, set: async () => {} },
  ttlSeconds: 60,
}

const checkout = {
  id: "chk_1",
  url: "https://polar.sh/checkout/chk_1",
  expiresAt: "2026-09-03T13:00:00Z",
}

describe("POST /billing/checkout", () => {
  it("starts a checkout for the caller's own tenant", async () => {
    const createCheckout = vi.fn(async () => checkout)
    const app = createApp({
      apiKeyAuth,
      billing: {
        polar: {
          getCheckout: vi.fn(),
          createCheckout,
          listSubscriptions: vi.fn(),
          ingestEvents: vi.fn(),
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
    const createCheckout = vi.fn(async () => checkout)
    const app = createApp({
      apiKeyAuth,
      billing: {
        polar: {
          getCheckout: vi.fn(),
          createCheckout,
          listSubscriptions: vi.fn(),
          ingestEvents: vi.fn(),
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
          getCheckout: vi.fn(),
          createCheckout: vi.fn(),
          ingestEvents: async () => ({ inserted: 0, duplicates: 0 }),
          listSubscriptions: vi.fn(),
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
          getCheckout: vi.fn(),
          createCheckout: vi.fn(),
          ingestEvents: async () => ({ inserted: 0, duplicates: 0 }),
          listSubscriptions: vi.fn(),
        },
        subscriptions: ops({
          current: async () => ({
            plan: "pro",
            status: "active",
            cancelAtPeriodEnd: true,
            currentPeriodEnd: new Date("2026-10-03T00:00:00Z"),
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
    })
  })
})
