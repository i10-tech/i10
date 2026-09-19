import { Hono } from "hono"
import type { SubscriptionOps } from "../billing/db.js"
import type { Logger } from "../billing/grants.js"
import type { PolarClient } from "../billing/polar.js"

/**
 * What the page Polar redirects to polls, and the only billing route a browser
 * may call without an API key.
 *
 * ⚠ IT GRANTS NOTHING, AND THAT IS THE POINT OF ITS EXISTENCE. Polar's success
 * redirect is a browser navigation: anyone can type that URL, so a page that
 * concluded "paid" from arriving there would make Pro free to anyone who reads
 * their own address bar once. This reports what `core.subscriptions` ALREADY
 * says — a row only the signature-verified webhook in routes/polar-events.ts
 * can move. See the note at the top of billing/grants.ts.
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
 * Whether Polar's copy of this customer carries the tenant id its events need.
 *
 * ⚠ THIS IS THE ONE FAILURE THE HALF-HOURLY RECONCILER CANNOT REPAIR, WHICH IS
 * WHY IT IS WORTH A ROUND TRIP TO NAME. Every subscription event is attributed
 * by `customer.external_id`; `toState` drops the ones without it, and the
 * reconciler drops them by the identical rule — so a customer record missing
 * ours means the payment has gone through, the subscription is active in
 * Polar, and nothing on this side will EVER notice, in either direction. The
 * page otherwise tells that customer we check for stragglers every half hour,
 * which is true of every other way this can be pending and false of this one.
 *
 * ⚠ AND IT IS ASKED ONLY ON THE PENDING PATH, so it costs one extra call
 * during the second between Polar taking the money and our webhook landing,
 * and nothing at all once the grant exists.
 *
 * ⚠ A FAILED LOOKUP IS NOT A VERDICT. Polar being unreachable for this one
 * question says nothing, and answering "unattributed" on it would tell
 * somebody their payment is stuck when it is arriving normally.
 */
async function attributionGap(
  deps: CheckoutStatusDeps,
  checkout: { id: string; tenantId: string; customerId: string | null },
): Promise<boolean> {
  if (!checkout.customerId) return false

  try {
    const customer = await deps.polar.getCustomer(checkout.customerId)
    if (!customer || customer.externalId === checkout.tenantId) return false

    deps.log.error(
      {
        checkoutId: checkout.id,
        tenantId: checkout.tenantId,
        polarCustomerId: checkout.customerId,
        externalId: customer.externalId,
      },
      "a paid checkout resolved to a Polar customer that does not carry our " +
        "tenant id — its subscription events cannot be attributed and neither " +
        "the webhook nor the reconciler will ever grant this plan",
    )
    return true
  } catch (err) {
    deps.log.warn(
      { checkoutId: checkout.id, err: String(err) },
      "could not check a checkout's customer attribution",
    )
    return false
  }
}

export function createCheckoutStatus(deps?: CheckoutStatusDeps) {
  const app = new Hono()

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

    const stranded = await attributionGap(deps, {
      id: checkoutId,
      tenantId: checkout.tenantId,
      customerId: checkout.customerId,
    })

    return c.json(
      {
        status: "paid" satisfies CheckoutStatus,
        plan: null,
        // The page reads this to choose between "a moment" and "write to us".
        ...(stranded ? { detail: "unattributed" } : {}),
      },
      200,
    )
  })

  return app
}
