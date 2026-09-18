import { PgDialect } from "drizzle-orm/pg-core"
import type { SQL } from "drizzle-orm"
import { describe, expect, it, mock } from "bun:test"
import { directionOf, planChange, prorationFor } from "../src/billing/plan-change.js"
import type { Database } from "../src/db/client.js"
import type { PolarClient } from "../src/billing/polar.js"
import type { SubscriptionOps } from "../src/billing/db.js"

const TENANT = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6071"
const log = { info: mock(), warn: mock(), error: mock() }

const RANKS: Record<string, number> = { free: 0, pro: 10, scale: 20 }

/** Enough drizzle to answer the rank lookup. */
const fakeDb = () =>
  ({
    transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        execute: async () => [],
        select: () => ({
          from: () => ({
            // The plan id is a bound parameter, so the fake renders the clause
            // and reads it back rather than guessing at drizzle's internals.
            where: (clause: SQL) => ({
              limit: async () => {
                const params = new PgDialect().sqlToQuery(clause).params
                const id = params.find(
                  (p): p is string => typeof p === "string" && p in RANKS,
                )
                return id === undefined ? [] : [{ rank: RANKS[id] }]
              },
            }),
          }),
        }),
      }),
  }) as unknown as Database

const ops = (over: Partial<SubscriptionOps> = {}): SubscriptionOps =>
  ({
    current: async () => ({
      plan: "free",
      status: "active",
      cancelAtPeriodEnd: false,
      currentPeriodEnd: null,
      polarSubscriptionId: "sub_1",
    }),
    ...over,
  }) as SubscriptionOps

const polar = (over: Partial<PolarClient> = {}): PolarClient =>
  ({
    updateSubscription: async () => {},
    cancelSubscription: async () => {},
    ...over,
  }) as PolarClient

const change = (deps: { polar?: PolarClient; subscriptions?: SubscriptionOps } = {}) =>
  planChange({
    db: fakeDb(),
    polar: deps.polar ?? polar(),
    subscriptions: deps.subscriptions ?? ops(),
    products: { pro: "prod_pro", scale: "prod_scale" },
    // ⚠ NO `free` IN `products`, WHICH MIRRORS PRODUCTION. The free plan is not
    // sold, so it has no Polar product; naming it here is what tells the change
    // apart from a plan that is simply missing from POLAR_PRODUCTS.
    freePlanId: "free",
    log,
  })

describe("which way the change goes", () => {
  it("reads a higher rank as an upgrade", () => {
    expect(directionOf(0, 10)).toBe("upgrade")
    expect(directionOf(10, 0)).toBe("downgrade")
  })

  /**
   * ⚠ A TIE IS A SIDEWAYS MOVE, NOT AN UPGRADE. Treating it as one would
   * invoice a customer for a change that cost them nothing.
   */
  it("reads an equal rank as neither", () => {
    expect(directionOf(10, 10)).toBe("same")
  })
})

describe("what Polar is asked to do", () => {
  /**
   * ⚠ THE ENTIRE DECISION. Polar's `update.py` has no upgrade/downgrade branch,
   * so this mapping is the only thing that makes proration behave the way
   * anyone expects — and the organisation default the customer portal uses
   * cannot be right for both directions at once.
   */
  it("charges an upgrade now and defers a downgrade", () => {
    expect(prorationFor("upgrade")).toBe("invoice")
    expect(prorationFor("downgrade")).toBe("next_period")
  })

  /**
   * ⚠ AND DEFERRING THE DOWNGRADE IS WHAT CLOSES THE OBVIOUS ABUSE. With
   * immediate downgrades a customer upgrades on day 28, takes the larger
   * allowance, downgrades on day 30 and is credited the difference.
   */
  it("never issues a credit on a downgrade", () => {
    expect(prorationFor("downgrade")).not.toBe("invoice")
    expect(prorationFor("downgrade")).not.toBe("prorate")
  })

  // ⚠ `reset` restarts Polar's billing anchor; ours is fixed at tenant creation
  // and never moves. Using it splits the invoice date from the refill date.
  it("never resets the billing cycle", () => {
    for (const direction of ["upgrade", "downgrade"] as const) {
      expect(prorationFor(direction)).not.toBe("reset")
    }
  })
})

describe("changing a plan", () => {
  it("patches the subscription with the upgrade behaviour", async () => {
    const updateSubscription = mock(async () => {})
    const outcome = await change({ polar: polar({ updateSubscription }) }).to(
      TENANT,
      "pro",
    )

    expect(outcome).toMatchObject({ status: "requested", direction: "upgrade" })
    expect(updateSubscription).toHaveBeenCalledWith({
      subscriptionId: "sub_1",
      productId: "prod_pro",
      prorationBehavior: "invoice",
    })
  })

  /**
   * ⚠ THE PRODUCT COMES FROM OUR MAP, NEVER FROM THE REQUEST. A caller who
   * could name a Polar product id could name a one-cent one and move themselves
   * to Pro — and the webhook would grant it perfectly correctly, because from
   * Polar's side the payment really did succeed.
   */
  it("refuses a plan that is not in the product map", async () => {
    const updateSubscription = mock()
    const outcome = await change({ polar: polar({ updateSubscription }) }).to(
      TENANT,
      "prod_01anything",
    )

    expect(outcome.status).toBe("rejected")
    expect(updateSubscription).not.toHaveBeenCalled()
  })

  // ⚠ Nothing to PATCH. A tenant with no subscription buys one through
  // checkout; PATCH on one that does not exist is a 404 nobody can act on.
  it("sends a tenant with no subscription to checkout", async () => {
    const outcome = await change({
      subscriptions: ops({
        current: async () => ({
          plan: null,
          status: null,
          cancelAtPeriodEnd: false,
          currentPeriodEnd: null,
          polarSubscriptionId: null,
        }),
      }),
    }).to(TENANT, "pro")

    expect(outcome).toMatchObject({ status: "rejected" })
    if (outcome.status !== "rejected") return
    expect(outcome.reason).toMatch(/checkout/i)
  })

  /**
   * ⚠ LEAVING A PAID PLAN IS THE ONE MOVE THAT IS NOT A PRODUCT SWAP, and
   * before this it was simply impossible. The free plan has no Polar product —
   * nothing is charged for it — so `products["free"]` is undefined and the
   * change was refused with `No such plan: free`. The console rendered a
   * "Downgrade" button next to the free plan that answered that every time, so
   * a paying customer had no way off a plan they no longer wanted.
   */
  it("cancels at the period end when moving to the free plan", async () => {
    const updateSubscription = mock()
    const cancelSubscription = mock(async () => {})

    const outcome = await change({
      polar: polar({ updateSubscription, cancelSubscription }),
      subscriptions: ops({
        current: async () => ({
          plan: "pro",
          status: "active",
          cancelAtPeriodEnd: false,
          currentPeriodEnd: null,
          polarSubscriptionId: "sub_1",
        }),
      }),
    }).to(TENANT, "free")

    expect(outcome).toMatchObject({ status: "requested", direction: "downgrade" })
    expect(cancelSubscription).toHaveBeenCalledWith("sub_1")

    // ⚠ AND IT IS NOT ALSO A PRODUCT SWAP. Moving the subscription to a product
    // that does not exist would 404 from Polar after the cancel had landed.
    expect(updateSubscription).not.toHaveBeenCalled()
  })

  /**
   * ⚠ THE FREE PLAN IS NAMED, NOT INFERRED FROM A MISSING PRODUCT. Treating any
   * plan absent from `POLAR_PRODUCTS` as a cancellation would end somebody's
   * subscription because of a typo in an environment variable — a silent,
   * revenue-losing failure with no error anywhere.
   */
  it("still refuses an unknown plan rather than cancelling", async () => {
    const cancelSubscription = mock()
    const outcome = await change({
      polar: polar({ cancelSubscription }),
    }).to(TENANT, "enterprise")

    expect(outcome.status).toBe("rejected")
    expect(cancelSubscription).not.toHaveBeenCalled()
  })

  it("does nothing when they are already on the plan", async () => {
    const updateSubscription = mock()
    const outcome = await change({
      polar: polar({ updateSubscription }),
      subscriptions: ops({
        current: async () => ({
          plan: "pro",
          status: "active",
          cancelAtPeriodEnd: false,
          currentPeriodEnd: null,
          polarSubscriptionId: "sub_1",
        }),
      }),
    }).to(TENANT, "pro")

    expect(outcome.status).toBe("unchanged")
    expect(updateSubscription).not.toHaveBeenCalled()
  })

  /**
   * ⚠ A DECLINED CARD IS NOT AN OUTAGE. For `invoice`, Polar applies the change
   * only if the payment succeeds — so the subscription is untouched and the
   * customer's next step is their bank, not our support queue.
   */
  it("reports a refusal from Polar as a payment problem", async () => {
    const outcome = await change({
      polar: polar({
        updateSubscription: async () => {
          throw new Error("402 card_declined")
        },
      }),
    }).to(TENANT, "pro")

    expect(outcome).toMatchObject({ status: "failed" })
    if (outcome.status !== "failed") return
    expect(outcome.reason).toMatch(/payment method/i)
  })
})
