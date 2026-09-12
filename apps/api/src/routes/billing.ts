import { Hono } from "hono"
import type { CurrentPlan, SubscriptionOps } from "../billing/db.js"
import type { Logger } from "../billing/grants.js"
import type { PolarClient } from "../billing/polar.js"
import type { PlanChange } from "../billing/plan-change.js"
import { requireApiKey } from "../middleware/auth.js"

/**
 * Starting a checkout, and asking what plan we are on.
 *
 * ⚠ NEITHER OF THESE GRANTS ANYTHING. `POST /checkout` hands back a URL and
 * writes nothing; the plan moves only when Polar tells us the money arrived,
 * through the signature-verified webhook in routes/polar-events.ts. `GET /plan`
 * is what the page Polar redirects to should poll — it shows a spinner until
 * this reports the new plan, which is a second or two, and it is honest for the
 * whole of that second in a way that granting on the redirect would not be.
 *
 * ⚠ AND IT IS DELIBERATELY OUTSIDE THE OPENAPI DOCUMENT. `/emails` is the
 * product's API and belongs in every generated SDK; buying a plan is a console
 * action. Publishing it would put "create a checkout session" in the surface
 * customers write code against, and then it would have to be supported there.
 */

export interface BillingDeps {
  polar: PolarClient
  subscriptions: SubscriptionOps
  /** Our plan id → Polar product id. The only plans that can be bought. */
  products: Record<string, string>
  /** Where Polar returns the browser. A page that polls; not a grant. */
  successUrl?: string
  /**
   * Moving a live subscription between plans.
   *
   * ⚠ SEPARATE FROM `polar` ON PURPOSE, EVEN THOUGH IT HOLDS ONE. This route
   * can start a checkout and read a plan; only this object can move a paying
   * customer between products, and keeping it named makes that visible in the
   * wiring rather than implied by what `polar` happens to expose.
   */
  planChange?: PlanChange
  log: Logger
}

export function createBilling(deps?: BillingDeps) {
  const app = new Hono()

  app.use("*", requireApiKey)

  app.post("/checkout", async (c) => {
    if (!deps) return c.json(notWired, 501)

    const auth = c.get("auth")
    const body = await readJson(c.req.raw.clone())
    const plan = typeof body?.plan === "string" ? body.plan : undefined

    if (!plan) {
      return c.json(
        {
          statusCode: 422,
          name: "validation_error" as const,
          message: 'Send `{ "plan": "pro" }`.',
        },
        422,
      )
    }

    // ⚠ THE PRODUCT COMES FROM OUR MAP, NEVER FROM THE REQUEST. A caller who
    // could name a Polar product id could name a free one, or a one-cent one,
    // and buy Pro with it — the webhook would then grant the plan perfectly
    // correctly, because from Polar's side the payment really did succeed.
    const productId = deps.products[plan]
    if (!productId) {
      return c.json(
        {
          statusCode: 422,
          name: "validation_error" as const,
          message: `No such plan: ${plan}.`,
        },
        422,
      )
    }

    try {
      const checkout = await deps.polar.createCheckout({
        productId,
        tenantId: auth.tenantId,
        successUrl: deps.successUrl,
      })
      return c.json({ url: checkout.url, expiresAt: checkout.expiresAt }, 200)
    } catch (error) {
      deps.log.error({ err: error, tenantId: auth.tenantId, plan }, "checkout failed")
      return c.json(
        {
          statusCode: 502,
          name: "internal_server_error" as const,
          message: "Could not start a checkout.",
        },
        502,
      )
    }
  })

  /**
   * ⚠ THIS IS WHY THE CUSTOMER NEVER SEES POLAR'S PORTAL. Their portal always
   * uses the organisation's default proration behaviour, and one default cannot
   * be right for both directions — see billing/plan-change.ts.
   */
  app.post("/plan", async (c) => {
    if (!deps?.planChange) return c.json(notWired, 501)

    const auth = c.get("auth")
    const body = await readJson(c.req.raw.clone())
    const plan = typeof body?.plan === "string" ? body.plan : undefined

    if (!plan) {
      return c.json(
        {
          statusCode: 422,
          name: "validation_error" as const,
          message: 'Send `{ "plan": "pro" }`.',
        },
        422,
      )
    }

    const outcome = await deps.planChange.to(auth.tenantId, plan)

    switch (outcome.status) {
      case "requested":
        // ⚠ 202, NOT 200. Polar has accepted the change; the ENTITLEMENT moves
        // when their webhook says it did, which is the only path that grants a
        // plan. The console polls `GET /plan`, exactly as it does after a
        // checkout, and a 200 here would invite it not to.
        return c.json(outcome, 202)
      case "unchanged":
        return c.json({ status: "unchanged", plan }, 200)
      case "rejected":
        return c.json(
          {
            statusCode: 422,
            name: "validation_error" as const,
            message: outcome.reason,
          },
          422,
        )
      default:
        return c.json(
          {
            statusCode: 402,
            name: "invalid_access" as const,
            message: outcome.reason,
          },
          402,
        )
    }
  })

  /**
   * A token for the embedded payment-method form.
   *
   * ⚠ MINTED HERE BECAUSE THE ALTERNATIVE IS OUR POLAR TOKEN IN A BROWSER. The
   * session lasts an hour and is scoped to one customer, and the card fields it
   * opens render inside Polar's iframe — so card data never reaches our page or
   * our server, and we stay SAQ A.
   */
  app.post("/payment-method-session", async (c) => {
    if (!deps) return c.json(notWired, 501)

    const auth = c.get("auth")
    try {
      const session = await deps.polar.createCustomerSession(auth.tenantId)
      return c.json({ token: session.token }, 200)
    } catch (error) {
      deps.log.error({ err: error, tenantId: auth.tenantId }, "customer session failed")
      return c.json(
        {
          statusCode: 502,
          name: "internal_server_error" as const,
          message: "Could not start a payment-method session.",
        },
        502,
      )
    }
  })

  app.get("/plan", async (c) => {
    if (!deps) return c.json(notWired, 501)

    const auth = c.get("auth")
    const current: CurrentPlan = await deps.subscriptions.current(auth.tenantId)
    return c.json(
      {
        plan: current.plan,
        status: current.status,
        cancelAtPeriodEnd: current.cancelAtPeriodEnd,
        currentPeriodEnd: current.currentPeriodEnd?.toISOString() ?? null,
      },
      200,
    )
  })

  return app
}

const notWired = {
  statusCode: 501 as const,
  name: "internal_server_error" as const,
  message: "Billing is not configured.",
}

/**
 * ⚠ STRUCTURAL, NOT `req: Request`, AND THE REASON IS A TYPES COLLISION RATHER
 * THAN A STYLE PREFERENCE. Under @types/bun the global `Request` is the merged
 * declaration — Bun's members and Node's — but `clone()` comes from Node's
 * half and is declared as returning undici's `Request`, which lacks the members
 * Bun's half adds. So `readJson(c.req.raw.clone())` failed to typecheck against
 * a nominal `Request` while being, at runtime, exactly the object this wants.
 * Asking only for what is used sidesteps the disagreement and says what the
 * function actually needs.
 */
async function readJson(request: {
  json(): Promise<unknown>
}): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await request.json()
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null
    }
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}
