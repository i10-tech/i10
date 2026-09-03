import { Hono } from "hono"
import type { CurrentPlan, SubscriptionOps } from "../billing/db.js"
import type { Logger } from "../billing/grants.js"
import type { PolarClient } from "../billing/polar.js"
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

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
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
