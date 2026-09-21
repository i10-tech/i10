import { describe, expect, it, mock } from "bun:test"
import { createApp } from "../src/app.js"
import type { SubscriptionOps } from "../src/billing/db.js"
import type { CheckoutState, CustomerState, PolarClient } from "../src/billing/polar.js"

const log = { info: () => {}, warn: () => {}, error: () => {} }

const ops = (over: Partial<SubscriptionOps> = {}): SubscriptionOps => ({
  record: async () => "applied",
  markGranted: async () => {},
  // Nobody holds the id by default — see the note on the same field in
  // billing.test.ts. The checkout path passes `reassign`, which skips the
  // lookup entirely, so these tests never reach it.
  ownerOf: async () => null,
  /*
   * ⚠ NO CHECKOUT ROW BY DEFAULT EITHER, so attribution falls through to
   * `external_id` and every test written before `core.polar_checkouts`
   * keeps the path it was written for.
   */
  recordCheckout: async () => {},
  checkoutTenant: async () => null,
  snapshot: async () => [],
  /*
   * ⚠ EVERY TENANT IS KNOWN BY DEFAULT, so each existing test keeps the case it
   * was written for. The reconciler now asks whether a tenant still exists
   * before trying to repair it — a fake that answered "no" would send every one
   * of these through the new unknown-tenant branch instead of the repair path
   * they are actually about.
   */
  knownTenants: async (ids: readonly string[]) => new Set(ids),
  // Not reached here — this suite is about the checkout poll, not cancelling.
  noteCancelling: async () => {},
  noteResuming: async () => {},
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
  resumeSubscription: async () => {},
  revokeSubscription: async () => "revoked" as const,
  createCustomerSession: async () => ({ token: "polar_cst_test" }),
  listSubscriptions: async () => [],
})

const succeeded: CheckoutState = {
  id: "c1",
  status: "succeeded",
  tenantId: "ten-1",
  customerId: "cus_1",
  productId: "prod_pro",
  // ⚠ THE FLOOR EVERY FIXTURE SUBSCRIPTION MUST SIT AFTER. A subscription older
  // than the checkout belongs to a different purchase — see `pickForCheckout`.
  createdAt: "2026-09-20T09:00:00Z",
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

  /*
   * ⚠ THIS USED TO ASSERT A RECLAIM POLAR DOES NOT PERMIT. `external_id` is
   * immutable once set — "Once set, it can't be updated" in Polar's own schema,
   * `422` from the API — so the PATCH this expected always failed, `attribute`
   * returned `stranded`, and a returning customer who had just paid was told on
   * the confirmation page that their payment was unattributed. Their plan was
   * granted correctly the whole time, by `reassign`.
   */
  it("is left alone when the tenant holding it is gone, and does not alarm", async () => {
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

    // No doomed PATCH: the id cannot be moved, so asking is only a way to fail.
    expect(wrote).not.toHaveBeenCalled()
    // And emphatically not `unattributed` — the subscription is bound to the
    // live tenant by the checkout, so there is nothing for a human to do.
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
  /*
   * ⚠ THIS ASSERTED THE OPPOSITE UNTIL 2026-09-20, AND THE ASSERTION WAS THE
   * BUG. It pinned "a stranded checkout is never granted", on the reasoning
   * that no subscription of that customer belongs to this tenant. That
   * reasoning reads `customer.external_id` as the truth about who is paying —
   * and it is not: Polar stamps it once, at customer creation, and never
   * maintains it, so for anybody buying a second time it names whoever bought
   * first. The customer it was protecting is the customer it was starving.
   *
   * The grant is safe here because it does not use that field at all. The
   * checkout succeeded, it names this tenant in metadata we wrote, and the
   * subscription taken is one on that customer, for that product, created no
   * earlier than the checkout — which nothing but this purchase can be.
   */
  it("grants a stranded checkout anyway, from the checkout's own evidence", async () => {
    const applied = mock(async () => ({ status: "applied" }))
    const app = createApp({
      checkoutStatus: {
        polar: {
          ...polar(succeeded, { id: "cus_1", externalId: "ten-other" }),
          listSubscriptions: async () => [live],
        },
        subscriptions: ops(),
        // A LIVE other tenant: the external_id must not be overwritten, and the
        // plan must still be granted. Those are two different decisions.
        tenants: { isLive: async () => true },
        grants: { apply: applied },
        options,
        log,
      },
    })

    await ask(app)
    expect(applied).toHaveBeenCalledTimes(1)
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

/*
 * ⚠ THE PRODUCTION FAILURE OF 2026-09-20, AND IT IS THE ORDINARY CASE FOR ANY
 * SECOND PURCHASE. Polar deduplicates customers by EMAIL and stamps
 * `external_id` only on a customer it CREATES. So the customer of somebody who
 * has bought before carries whoever bought FIRST — observed live as seven
 * subscriptions on one customer, every one of them naming a tenant that no
 * longer existed, including the one created thirty-six seconds after the
 * checkout being answered.
 *
 * Filtering those by `customer.external_id` discards the subscription the
 * customer has just paid for, so nothing is granted and nothing is reported:
 * `{"status":"paid","plan":null}` for ever. The checkout is the stronger
 * attribution — WE wrote its `metadata.tenant_id` from an authenticated session
 * and Polar echoes it back — so that is what the grant uses.
 */
describe("a customer whose external_id names somebody else entirely", () => {
  const options = {
    planForProduct: (id: string) => (id === "prod_pro" ? "pro" : undefined),
    freePlanId: "free",
  }

  /** Every subscription on the customer carries the OLD tenant, as in production. */
  const stale = (over: Record<string, unknown> = {}) => ({
    id: "sub_new",
    status: "active",
    product_id: "prod_pro",
    customer_id: "cus_1",
    customer: { external_id: "ten-OLD-and-gone" },
    created_at: "2026-09-20T10:00:00Z",
    ...over,
  })

  const app = (subs: unknown[], applied: unknown) =>
    createApp({
      checkoutStatus: {
        polar: {
          ...polar(succeeded, { id: "cus_1", externalId: "ten-OLD-and-gone" }),
          listSubscriptions: async () => subs as never,
        },
        subscriptions: ops(),
        grants: applied as never,
        options,
        log,
      },
    })

  it("grants the tenant that the CHECKOUT names, not the customer", async () => {
    const seen: { tenantId: string; polarSubscriptionId: string }[] = []
    const applied = mock(
      async (state: { tenantId: string; polarSubscriptionId: string }) => {
        seen.push(state)
        return { status: "applied" }
      },
    )

    await ask(app([stale()], { apply: applied }))

    expect(applied).toHaveBeenCalledTimes(1)
    expect(seen[0]).toMatchObject({
      tenantId: "ten-1",
      polarSubscriptionId: "sub_new",
    })
  })

  /*
   * ⚠ THE WEBHOOK GETS THERE FIRST AND BINDS THE ID TO THE WRONG TENANT. It
   * attributes by the same stale field, so without `reassign` this insert dies
   * on `polar_subscription_id`'s unique index and the plan never lands.
   */
  it("takes the subscription id back from whoever the webhook gave it to", async () => {
    const opts: { reassign?: boolean }[] = []
    const applied = mock(async (_s: unknown, o?: { reassign?: boolean }) => {
      opts.push(o ?? {})
      return { status: "applied" }
    })

    await ask(app([stale()], { apply: applied }))
    expect(opts[0]).toMatchObject({ reassign: true })
  })

  /*
   * ⚠ THE GUARD THAT KEEPS THE OVERRIDE HONEST. Two live workspaces can share a
   * Polar customer, and without a floor this would hand whoever completed a
   * checkout the OTHER workspace's older subscription — a plan granted off the
   * back of somebody else's payment.
   */
  it("refuses a subscription that predates the checkout", async () => {
    const applied = mock(async () => ({ status: "applied" }))
    await ask(
      app([stale({ id: "sub_someone_else", created_at: "2026-09-19T00:00:00Z" })], {
        apply: applied,
      }),
    )
    expect(applied).not.toHaveBeenCalled()
  })

  // ⚠ AND THE PRODUCT MUST BE THE ONE BOUGHT. A customer on several products
  // must not be handed the largest thing on the account.
  it("refuses a subscription to a different product", async () => {
    const applied = mock(async () => ({ status: "applied" }))
    await ask(app([stale({ product_id: "prod_other" })], { apply: applied }))
    expect(applied).not.toHaveBeenCalled()
  })

  /*
   * ⚠ SIX DEAD SUBSCRIPTIONS AND ONE LIVE ONE IS THE SHAPE OF A REAL ACCOUNT,
   * and newest-created is what picks the right one. `supersedes` ranks by
   * entitlement first, which cannot separate six equally-unentitling rows.
   */
  it("picks the one this checkout made out of a pile of dead ones", async () => {
    const seen: { polarSubscriptionId: string }[] = []
    const applied = mock(async (state: { polarSubscriptionId: string }) => {
      seen.push(state)
      return { status: "applied" }
    })

    await ask(
      app(
        [
          stale({
            id: "sub_old_a",
            status: "canceled",
            created_at: "2026-09-20T09:30:00Z",
          }),
          stale({ id: "sub_new", created_at: "2026-09-20T10:00:00Z" }),
          stale({
            id: "sub_old_b",
            status: "canceled",
            created_at: "2026-09-20T09:45:00Z",
          }),
        ],
        { apply: applied },
      ),
    )

    expect(seen[0]).toMatchObject({ polarSubscriptionId: "sub_new" })
  })

  /*
   * ⚠ AND A 403 FROM `getCustomer` MUST NOT STOP THE GRANT. That is precisely
   * the deployment this was found on: the token lacks `customers:read`, so the
   * attribution repair cannot run at all — and the grant must not depend on it,
   * because the checkout already says everything needed.
   */
  it("still grants when the token cannot read customers at all", async () => {
    const applied = mock(async () => ({ status: "applied" }))
    const scopeless = createApp({
      checkoutStatus: {
        polar: {
          ...polar(succeeded),
          getCustomer: async () => {
            throw new Error("polar customers.get refused: missing `customers:read`")
          },
          listSubscriptions: async () => [stale()] as never,
        },
        subscriptions: ops(),
        grants: { apply: applied },
        options,
        log,
      },
    })

    await ask(scopeless)
    expect(applied).toHaveBeenCalledTimes(1)
  })
})
