import { Hono } from "hono"
import type { SubscriptionOps } from "../billing/db.js"
import { pickForCheckout, type DecideOptions } from "../billing/events.js"
import type { SubscriptionState } from "../billing/events.js"
import type { Logger } from "../billing/grants.js"
import type { PolarClient } from "../billing/polar.js"

/**
 * What the page Polar redirects to polls, and the only billing route a browser
 * may call without an API key.
 *
 * ⚠ ARRIVING HERE GRANTS NOTHING, AND THAT IS THE POINT OF ITS EXISTENCE.
 * Polar's success redirect is a browser navigation: anyone can type that URL,
 * so a page that concluded "paid" from arriving there would make Pro free to
 * anyone who reads their own address bar once. Nothing in the request is
 * believed — not the tenant, not the plan, not the fact that a payment
 * happened.
 *
 * ⚠ IT CAN NEVERTHELESS APPLY A GRANT, AND THE DISTINCTION IS WHERE THE
 * EVIDENCE COMES FROM. When Polar's own API says this checkout `succeeded` and
 * our row shows no grant, this reads that customer's subscriptions back over
 * our access token and applies the one `toState` says entitles them — the same
 * judgement, on the same evidence, as the webhook and the reconciler. What it
 * removes is the WAIT: a webhook lost during a deploy used to mean a spinner,
 * a ninety-second give-up, and a customer told to expect their plan within half
 * an hour. See `grantNow`, and the note at the top of billing/grants.ts.
 *
 * ⚠ WHY IT IS NOT UNDER `/billing`. That router applies `requireApiKey` to `*`,
 * which is fail-closed and should stay that way; carving an exception into a
 * wildcard guard is how a route meant to be public makes its neighbours public
 * too. A separate mount keeps "authenticated" and "not" visibly separate.
 *
 * ⚠ THE CHECKOUT ID IS THE CAPABILITY. It is a 122-bit Polar UUID handed only
 * to the person who bought, and the tenant is read from Polar's copy of the
 * checkout rather than from the request — so possessing an id reveals the state
 * of that checkout and nothing else. It carries no personal data, no email and
 * no tenant id. Enumeration is not feasible; guessing is the threat model, and
 * a random UUID is the answer to it.
 *
 * ⚠ AND IT IS OUTSIDE THE OPENAPI DOCUMENT, like the rest of billing. Buying a
 * plan is a console action rather than part of the product's API.
 */

export interface CheckoutStatusDeps {
  polar: PolarClient
  subscriptions: SubscriptionOps
  log: Logger
  /**
   * What applies an entitlement, for the paid-but-not-granted path.
   *
   * ⚠ OPTIONAL SO THE ROUTE STILL MOUNTS WITHOUT IT. Without these two the
   * endpoint only reports, and the half-hourly reconciler does the granting —
   * which is thirty minutes in front of a page that gives up after ninety
   * seconds. With them, a checkout Polar says succeeded is granted inside the
   * poll that noticed it, whatever happened to the webhook.
   */
  grants?: {
    apply(
      state: SubscriptionState,
      options?: { reassign?: boolean },
    ): Promise<{ status: string }>
  }
  options?: DecideOptions
  /**
   * Whether a tenant id still names a live workspace.
   *
   * ⚠ IT IS WHAT TELLS A COLLISION FROM A RECLAIM, AND WITHOUT IT THE ROUTE
   * CANNOT TELL AND HAS TO ASSUME THE WORST. See `attribute`.
   */
  tenants?: { isLive(tenantId: string): Promise<boolean> }
}

/**
 * The four states the page can be in, and they are deliberately not Polar's.
 *
 * `paid` covers the window — usually a second or two — where Polar has taken
 * the money and our webhook has not landed yet. It is the honest answer for
 * that second, and the reason the page polls rather than deciding once.
 */
export type CheckoutStatus = "granted" | "paid" | "unpaid" | "unknown"

/**
 * Makes Polar's copy of this customer carry the tenant id its events need, and
 * says whether anything is still in the way.
 *
 * ⚠ THIS USED TO ONLY DETECT, AND DETECTING WAS NOT ENOUGH. Polar sets
 * `external_id` on a customer it CREATES from a checkout's
 * `external_customer_id` and leaves it alone on one that already existed — so a
 * tenant whose Polar customer predates the checkout pays, subscribes, and is
 * dropped by `toState` on every event, in the webhook and the reconciler alike,
 * for ever. The old code found exactly that, logged it, and told the customer
 * to email support. The id is ours to write, and writing it is the fix.
 *
 * ⚠ OVER A NULL ALWAYS, AND OVER A DEAD TENANT'S ID — NEVER OVER A LIVE ONE. A
 * customer carrying a DIFFERENT tenant's id has two readings and they need
 * opposite answers:
 *
 *   - That tenant is live. This is a collision — two workspaces pointing at one
 *     Polar customer — and stamping ours over it would move somebody else's
 *     billing onto this one. `stranded`, loudly, for a human.
 *
 *   - That tenant is gone. This is a RECLAIM, and refusing it is the bug that
 *     made a second sign-up impossible to pay for. Polar deduplicates customers
 *     by email: somebody who subscribed, deleted their account and signed up
 *     again is handed back the same Polar customer, still carrying their FIRST
 *     tenant's id. Treating that as a collision meant every checkout they ever
 *     completed was attributed to a workspace that no longer existed — money
 *     taken, `stranded` logged, no plan granted, and no half-hourly reconciler
 *     or webhook redelivery could ever fix it, because both attribute by the
 *     same field. Reported as "no plan is granted if the user ever had one
 *     before"; this is why.
 *
 * ⚠ AND "LIVE" IS ASKED OF OUR DATABASE, NOT INFERRED FROM POLAR. `core.tenants`
 * is the only thing that knows whether a workspace still exists, and it is the
 * only input here that a customer cannot influence.
 *
 * ⚠ WITHOUT THE `tenants` DEP IT STAYS STRANDED, WHICH IS THE OLD BEHAVIOUR AND
 * THE SAFE DIRECTION. Not being able to ask is not permission to assume.
 *
 * ⚠ AND THE TENANT COMES FROM THE CHECKOUT'S OWN METADATA, WHICH WE SET AT
 * CREATION AND POLAR ECHOES BACK. Not from the request, not from an email —
 * the same rule the rest of billing already follows about never letting a
 * caller name the thing being bought or who is buying it.
 */
type Attribution = "ok" | "repaired" | "stranded"

async function attribute(
  deps: CheckoutStatusDeps,
  checkout: { id: string; tenantId: string; customerId: string | null },
): Promise<Attribution> {
  if (!checkout.customerId) return "ok"

  try {
    const customer = await deps.polar.getCustomer(checkout.customerId)
    if (!customer || customer.externalId === checkout.tenantId) return "ok"

    if (customer.externalId !== null) {
      const held = customer.externalId
      const occupied = deps.tenants ? await deps.tenants.isLive(held) : true

      if (occupied) {
        deps.log.error(
          {
            checkoutId: checkout.id,
            tenantId: checkout.tenantId,
            polarCustomerId: checkout.customerId,
            externalId: held,
          },
          "a paid checkout resolved to a Polar customer carrying a DIFFERENT " +
            "LIVE tenant id — refusing to overwrite it; this needs a human",
        )
        return "stranded"
      }

      /*
       * ⚠ THE ID CANNOT BE RECLAIMED, AND TRYING WAS WORSE THAN NOT TRYING.
       * Polar's `external_id` is immutable ONCE SET — "Once set, it can't be
       * updated" in their schema, `422` from the API — so this branch used to
       * fall through to a PATCH that could never succeed, log "its subscription
       * events remain unattributable", and return `stranded`. That put
       * `detail: "unattributed"` on the confirmation page of somebody who had
       * just paid and whose plan was, in fact, granted perfectly well.
       *
       * ⚠ BECAUSE THE BINDING THAT MATTERS IS OURS, NOT POLAR'S. The caller
       * applies this checkout's subscription with `reassign`, which takes the
       * id onto the live tenant from the checkout's own metadata; and every
       * later event is attributed by the tenant HOLDING the subscription rather
       * than by `external_id`. So the stale id is now a cosmetic wrong value in
       * Polar rather than a broken entitlement.
       *
       * ⚠ AND IT STOPS HAPPENING AT ALL ONCE THE DELETION PATH HAS RUN ONCE.
       * `tenants/lifecycle.ts` now deletes the Polar customer when a workspace
       * is terminated, so the next signup gets a fresh customer whose id is
       * stamped correctly at creation. This branch is the backlog, not the
       * steady state.
       */
      deps.log.warn(
        {
          checkoutId: checkout.id,
          tenantId: checkout.tenantId,
          polarCustomerId: checkout.customerId,
          staleExternalId: held,
        },
        "a returning customer's Polar record still names a deleted workspace — " +
          "it cannot be rewritten, and nothing depends on it: the subscription " +
          "is bound to the live tenant by the checkout",
      )
      return "ok"
    }

    const written = await deps.polar.setCustomerExternalId(
      checkout.customerId,
      checkout.tenantId,
    )

    if (!written) {
      deps.log.error(
        {
          checkoutId: checkout.id,
          tenantId: checkout.tenantId,
          polarCustomerId: checkout.customerId,
        },
        "could not write our tenant id onto a paid checkout's Polar customer — " +
          "its subscription events remain unattributable",
      )
      return "stranded"
    }

    deps.log.warn(
      {
        checkoutId: checkout.id,
        tenantId: checkout.tenantId,
        polarCustomerId: checkout.customerId,
      },
      "stamped our tenant id onto a Polar customer that had none — a checkout " +
        "reused a customer Polar did not create",
    )
    return "repaired"
  } catch (err) {
    // ⚠ A FAILED LOOKUP IS NOT A VERDICT. Polar being unreachable for this one
    // question says nothing, and answering "unattributed" on it would tell
    // somebody their payment is stuck when it is arriving normally.
    deps.log.warn(
      { checkoutId: checkout.id, err: String(err) },
      "could not check a checkout's customer attribution",
    )
    return "ok"
  }
}

/**
 * ⚠ HOW OFTEN ONE CHECKOUT MAY ASK POLAR FOR ITS SUBSCRIPTIONS. The page polls
 * every two seconds for up to ninety; without a floor, one customer waiting out
 * a lost webhook is forty-five list calls against Polar's API for an answer
 * that does not change that fast. Five seconds keeps "granted within a few
 * seconds of paying" true and turns forty-five calls into about eighteen.
 */
const GRANT_ATTEMPT_EVERY_MS = 5_000
/** Long enough that nothing in flight is forgotten; short enough to stay small. */
const ATTEMPT_MEMORY_MS = 15 * 60_000

/**
 * Grants what this customer has already paid for, without waiting for anyone.
 *
 * ⚠ IT NO LONGER RUNS ONLY AFTER A REPAIR, AND THAT IS THE FIX FOR "IT SHOULD
 * NOT TAKE HALF AN HOUR". The webhook is the normal path and lands in a second
 * or two — but when it does not, every other route to a grant is slow: Polar
 * re-sends nothing, the reconciler runs every thirty minutes, and this page
 * gives up after ninety seconds and tells the customer to wait for a job they
 * cannot see. A checkout Polar reports as `succeeded`, for a tenant whose row
 * shows no grant, is all the evidence the webhook itself would have carried.
 *
 * ⚠ AND IT IS STILL NOT THE BROWSER DECIDING ANYTHING. Everything here is read
 * back from Polar with our own access token and judged by the same `toState`
 * the webhook and the reconciler use. Arriving at this URL proves nothing and
 * grants nothing; it only asks the question sooner. See billing/grants.ts.
 *
 * ⚠ ONE SUBSCRIPTION DECIDES, CHOSEN BY `pick`. A customer who has bought
 * before has several — Polar never deletes one — and applying them in list
 * order lets a dead subscription write the live one's row. That is not
 * hypothetical here: the customer this path exists for is precisely the one who
 * subscribed, deleted their account, and subscribed again.
 *
 * ⚠ IT IS BEST EFFORT AND SAYS SO BY RETURNING NOTHING. If it fails, the
 * reconciler still repairs this within the half hour — the customer is no worse
 * off than before.
 */
async function grantNow(
  deps: CheckoutStatusDeps,
  attempted: Map<string, number>,
  checkout: {
    id: string
    tenantId: string
    customerId: string | null
    productId: string | null
    createdAt: string | null
  },
): Promise<void> {
  if (!deps.grants || !deps.options || !checkout.customerId) return

  const now = Date.now()
  const last = attempted.get(checkout.id)
  if (last !== undefined && now - last < GRANT_ATTEMPT_EVERY_MS) return

  // Swept here rather than on a timer: the map only grows when somebody is
  // polling, so the moment worth tidying it is the moment it is being used.
  if (attempted.size > 64) {
    for (const [id, at] of attempted) {
      if (now - at > ATTEMPT_MEMORY_MS) attempted.delete(id)
    }
  }
  attempted.set(checkout.id, now)

  try {
    const subs = await deps.polar.listSubscriptions({ customerId: checkout.customerId })

    /*
     * ⚠ ATTRIBUTED TO THE CHECKOUT'S TENANT, NOT THE CUSTOMER'S. This used to
     * call `pick`, which filters on `customer.external_id` exactly as the
     * webhook does — and that field names whoever created the Polar customer,
     * not whoever is paying now. For anybody on their second workspace it
     * therefore discarded every subscription they owned, including the one just
     * bought, and granted nothing while reporting nothing. See
     * `pickForCheckout`.
     */
    const state = pickForCheckout(subs, deps.options, {
      tenantId: checkout.tenantId,
      productId: checkout.productId,
      createdAt: checkout.createdAt,
    })

    if (!state) {
      deps.log.warn(
        { checkoutId: checkout.id, tenantId: checkout.tenantId, subs: subs.length },
        "a succeeded checkout has no matching subscription on its customer yet",
      )
      return
    }

    // ⚠ `reassign`, BECAUSE THE WEBHOOK HAS PROBABLY ALREADY CLAIMED IT FOR THE
    // WRONG TENANT. It attributes by the same stale `external_id`, lands first,
    // and binds the new subscription to a dead workspace — after which this
    // insert dies on the unique index unless the id is taken back. See db.ts.
    await deps.grants.apply(state, { reassign: true })
  } catch (err) {
    deps.log.error(
      { checkoutId: checkout.id, tenantId: checkout.tenantId, err: String(err) },
      "could not grant from the checkout status poll — the reconciler will " +
        "pick it up",
    )
  }
}

export function createCheckoutStatus(deps?: CheckoutStatusDeps) {
  const app = new Hono()

  /**
   * When each checkout last had a grant attempted for it.
   *
   * ⚠ PER PROCESS, AND IT DOES NOT NEED TO BE ANYTHING MORE. It exists to stop
   * one browser's two-second poll becoming a two-second call to Polar, and the
   * cost of a miss — another pod answering the next poll, a restart forgetting
   * everything — is one extra list call. Making it shared state would put a
   * Redis round trip in front of a page a customer is watching, to save an
   * API call we can afford.
   */
  const attempted = new Map<string, number>()

  app.get("/:checkoutId", async (c) => {
    if (!deps) {
      return c.json(
        {
          statusCode: 501,
          name: "internal_server_error",
          message: "Billing is not configured.",
        },
        501,
      )
    }

    const checkoutId = c.req.param("checkoutId")

    let checkout
    try {
      checkout = await deps.polar.getCheckout(checkoutId)
    } catch (err) {
      // ⚠ 503, NOT 200 WITH A GUESS. Polar being unreachable says nothing about
      // whether the customer paid, and a page that showed "failed" here would
      // tell somebody who just paid that they had not. The client keeps polling.
      deps.log.error({ checkoutId, err: String(err) }, "could not read a checkout")
      return c.json(
        {
          statusCode: 503,
          name: "service_unavailable",
          message: "Could not reach the payment provider.",
        },
        503,
      )
    }

    // No such checkout, or one that is not ours to talk about. Answered
    // identically on purpose: a caller probing ids learns nothing from the
    // difference between "does not exist" and "exists but has no tenant".
    if (!checkout?.tenantId) {
      return c.json({ status: "unknown" satisfies CheckoutStatus, plan: null }, 200)
    }

    if (checkout.status !== "succeeded") {
      return c.json(
        {
          status: "unpaid" satisfies CheckoutStatus,
          plan: null,
          // Polar's own word, so the page can say "expired" rather than a
          // generic failure when that is what happened.
          detail: checkout.status,
        },
        200,
      )
    }

    const current = await deps.subscriptions.current(checkout.tenantId)

    // ⚠ `plan` IS `granted_plan_id` — what was actually granted, not what
    // Polar said. Reading `plan_id` instead would show "Pro" the instant the
    // row was written and before the entitlement existed, which is exactly the
    // lie this page is built to avoid.
    if (current.plan) {
      return c.json(
        { status: "granted" satisfies CheckoutStatus, plan: current.plan },
        200,
      )
    }

    const attribution = await attribute(deps, {
      id: checkoutId,
      tenantId: checkout.tenantId,
      customerId: checkout.customerId,
    })

    /*
     * ⚠ THE GRANT IS ATTEMPTED IN THIS REQUEST, and then the row is read AGAIN
     * rather than assumed. `grantNow` is best effort, so claiming "granted"
     * because it did not throw would be reporting an entitlement we had not
     * confirmed — the exact lie the `granted_plan_id` rule above exists to
     * prevent.
     *
     * ⚠ AND IT RUNS FOR EVERY PAID-BUT-UNGRANTED CHECKOUT, WITHOUT CONSULTING
     * THE ATTRIBUTION VERDICT AT ALL. It was gated first on `repaired` and then
     * on "not `stranded`", and both gates made the grant depend on a repair
     * that needs `customers:read` and `customers:write` — scopes a Polar
     * organisation access token does not carry by default. Measured in
     * production 2026-09-20: `getCustomer` answered `403 insufficient_scope` on
     * every call, so the verdict was never better than a guess, and a customer
     * who had paid sat on `{"status":"paid","plan":null}` indefinitely.
     *
     * ⚠ THE GRANT DOES NOT NEED THAT VERDICT, BECAUSE THE CHECKOUT ALREADY
     * ANSWERS IT. Polar says this checkout `succeeded` — its word that the
     * money moved for THIS checkout — and its `metadata.tenant_id` is a value
     * OUR API wrote from an authenticated session. `pickForCheckout` then takes
     * only a subscription on that customer, for that product, created no
     * earlier than the checkout itself, which can be nothing other than the one
     * just bought. `attribution` is now about the durable REPAIR and about what
     * to tell somebody when the grant did not land — not about permission.
     */
    await grantNow(deps, attempted, {
      id: checkoutId,
      tenantId: checkout.tenantId,
      customerId: checkout.customerId,
      productId: checkout.productId,
      createdAt: checkout.createdAt,
    })

    const after = await deps.subscriptions.current(checkout.tenantId)
    if (after.plan) {
      return c.json(
        { status: "granted" satisfies CheckoutStatus, plan: after.plan },
        200,
      )
    }

    return c.json(
      {
        status: "paid" satisfies CheckoutStatus,
        plan: null,
        // The page reads this to choose between "a moment" and "write to us".
        ...(attribution === "stranded" ? { detail: "unattributed" } : {}),
      },
      200,
    )
  })

  return app
}
