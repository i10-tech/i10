import { Hono } from "hono"
import type { SubscriptionOps } from "../billing/db.js"
import { toState, type DecideOptions } from "../billing/events.js"
import type { SubscriptionState } from "../billing/events.js"
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
  /**
   * What applies an entitlement, for the repair path only.
   *
   * ⚠ OPTIONAL SO THE ROUTE STILL MOUNTS WITHOUT IT. Without these two the
   * endpoint reports exactly as it always did and the reconciler does the
   * granting; with them, a customer whose attribution we just repaired gets
   * their plan in the same poll rather than in half an hour.
   */
  grants?: { apply(state: SubscriptionState): Promise<{ status: string }> }
  options?: DecideOptions
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
 * ⚠ ONLY OVER A NULL, NEVER OVER SOMEBODY ELSE'S. A customer already carrying a
 * DIFFERENT tenant's id is not a gap, it is a collision — two workspaces
 * pointing at one Polar customer — and stamping ours over it would move another
 * workspace's billing onto this one. That case stays `stranded` and stays loud.
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
      deps.log.error(
        {
          checkoutId: checkout.id,
          tenantId: checkout.tenantId,
          polarCustomerId: checkout.customerId,
          externalId: customer.externalId,
        },
        "a paid checkout resolved to a Polar customer carrying a DIFFERENT " +
          "tenant id — refusing to overwrite it; this needs a human",
      )
      return "stranded"
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
 * Grants what the repaired customer already bought, without waiting for anyone.
 *
 * ⚠ THE REPAIR ALONE WOULD LEAVE THEM WATCHING A SPINNER FOR HALF AN HOUR.
 * Writing `external_id` makes the subscription attributable, but Polar does not
 * re-send an event because we patched a customer — so the grant would wait for
 * the next subscription change or the half-hourly reconciler, whichever came
 * first, on a page that gives up after ninety seconds. Reading the
 * subscriptions back and applying them is the same work the reconciler would
 * do, done now, for the one customer we know needs it.
 *
 * ⚠ IT IS BEST EFFORT AND SAYS SO BY RETURNING NOTHING. If it fails, the
 * reconciler still repairs this within the half hour — the customer is no worse
 * off than before, and the page's existing "this is taking longer than usual"
 * copy is then true rather than a guess.
 */
async function grantNow(
  deps: CheckoutStatusDeps,
  checkout: { tenantId: string; customerId: string | null },
): Promise<void> {
  if (!deps.grants || !deps.options || !checkout.customerId) return

  try {
    const subs = await deps.polar.listSubscriptions({ customerId: checkout.customerId })

    for (const sub of subs) {
      const decided = toState(sub, deps.options)
      // ⚠ AND ONLY FOR THE TENANT THIS CHECKOUT NAMES. One Polar customer can
      // hold several subscriptions; granting a state whose tenant is not the
      // one we just repaired would be writing an entitlement off the back of
      // somebody else's purchase.
      if (decided.kind === "ignore" || decided.state.tenantId !== checkout.tenantId) {
        continue
      }
      await deps.grants.apply(decided.state)
    }
  } catch (err) {
    deps.log.warn(
      { tenantId: checkout.tenantId, err: String(err) },
      "could not grant immediately after repairing attribution — the " +
        "reconciler will pick it up",
    )
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

    const attribution = await attribute(deps, {
      id: checkoutId,
      tenantId: checkout.tenantId,
      customerId: checkout.customerId,
    })

    /*
     * ⚠ THE GRANT IS ATTEMPTED IN THE SAME REQUEST THAT REPAIRED IT, and then
     * the row is read AGAIN rather than assumed. `grantNow` is best effort, so
     * claiming "granted" because it did not throw would be reporting an
     * entitlement we had not confirmed — the exact lie the `granted_plan_id`
     * rule above exists to prevent.
     */
    if (attribution === "repaired") {
      await grantNow(deps, {
        tenantId: checkout.tenantId,
        customerId: checkout.customerId,
      })

      const after = await deps.subscriptions.current(checkout.tenantId)
      if (after.plan) {
        return c.json(
          { status: "granted" satisfies CheckoutStatus, plan: after.plan },
          200,
        )
      }
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
