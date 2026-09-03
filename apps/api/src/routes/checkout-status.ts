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

    // ⚠ `plan` IS `granted_plan_id` — what Autumn was actually told, not what
    // Polar said. Reading `plan_id` instead would show "Pro" the instant the
    // row was written and before the entitlement existed, which is exactly the
    // lie this page is built to avoid.
    return c.json(
      {
        status: (current.plan
          ? "granted"
          : "paid") satisfies CheckoutStatus as CheckoutStatus,
        plan: current.plan,
      },
      200,
    )
  })

  return app
}
