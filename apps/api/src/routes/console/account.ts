import type { Hono } from "hono"
import type { Step } from "../../console/onboarding.js"
import { STEPS } from "../../console/onboarding.js"
import type { ConsoleDeps } from "./deps.js"
import { notFound, notWired, readJson, validation } from "./http.js"

/**
 * Who this workspace is, what it has used, and what it is paying for.
 *
 * ⚠ THESE ROUTES ANSWER FOR THE ACCOUNT RATHER THAN FOR ITS MAIL, which is why
 * they sit together: `/me` is what the shell renders on every page, and the
 * usage, billing and onboarding routes are the three things that change what it
 * says. A change to any of them is a change to the first screen after sign-in.
 */
export function mountAccount(app: Hono, d: ConsoleDeps): void {
  // ───────────────────────────────────────────────────────────────────────────
  // Who am I, and what is my workspace
  // ───────────────────────────────────────────────────────────────────────────

  app.get("/me", async (c) => {
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")

    /*
     * ⚠ ONE BILLING READ, PASSED INTO THE ONBOARDING DECISION. This used to
     * start a second `billing()` inside the `Promise.all` so that the two could
     * run concurrently, which made the comment claiming they share a plan a
     * lie: two reads a few milliseconds apart can straddle a Polar webhook, and
     * then the header renders one plan while the redirect decides on another —
     * a free tenant sent through onboarding with "Pro" in the corner. The
     * onboarding read is the only thing that has to wait, and it waits on a
     * query that was already in flight.
     */
    const [profile, billing] = await Promise.all([
      d.profile.get(tenantId),
      d.usage.billing(tenantId),
    ])
    const onboardingState = await d.onboarding.get(tenantId, billing.plan?.id ?? null)

    return c.json({
      user: { id: userId },
      tenant: profile,
      billing,
      onboarding: onboardingState,
    })
  })

  app.patch("/me/tenant", async (c) => {
    const { tenantId } = c.get("auth")
    const body = await readJson(c)
    const name = typeof body?.name === "string" ? body.name.trim() : ""

    if (!name) return c.json(validation("`name` is required."), 422)
    if (name.length > 120) return c.json(validation("`name` is too long."), 422)

    const updated = await d.profile.rename(tenantId, name)
    return updated ? c.json({ ok: true, name }) : c.json(notFound("No workspace."), 404)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Usage and billing
  // ───────────────────────────────────────────────────────────────────────────

  app.get("/usage", async (c) => {
    const { tenantId } = c.get("auth")
    const [usage, billing] = await Promise.all([
      d.usage.usage(tenantId),
      d.usage.billing(tenantId),
    ])
    return c.json({ usage, billing })
  })

  app.get("/plans", async (c) => {
    const { tenantId } = c.get("auth")
    return c.json({ data: await d.usage.catalog(tenantId) })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Billing
  // ───────────────────────────────────────────────────────────────────────────

  app.post("/billing/checkout", async (c) => {
    if (!d.billing) return c.json(notWired("Billing"), 501)
    const { tenantId } = c.get("auth")
    const body = await readJson(c)
    const plan = typeof body?.plan === "string" ? body.plan : ""

    /*
     * ⚠ THE PRODUCT COMES FROM OUR MAP, NEVER FROM THE REQUEST. A caller who
     * could name a Polar product id could name a free one, or a one-cent one,
     * and buy the top plan with it — and the webhook would then grant it
     * perfectly correctly, because from Polar's side the payment really did
     * succeed. The same rule routes/billing.ts states at length.
     */
    const productId = d.billing.products[plan]
    if (!productId)
      return c.json(validation(`No such plan: ${plan || "(missing)"}.`), 422)

    try {
      const checkout = await d.billing.polar.createCheckout({
        productId,
        tenantId,
        successUrl: returnTo(d.billing.successUrl, body?.return_to),
      })

      /*
       * ⚠ THE EMBED ORIGIN IS SENT, AND THE NOTE THAT USED TO SIT HERE SAYING
       * IT WAS UNNECESSARY WAS WRONG IN A WAY WORTH RECORDING. It reported a
       * real measurement — the checkout page answers `frame-ancestors *` with
       * or without the field, and renders fine under `?embed=true&
       * embed_origin=…` because the SDK appends that query parameter itself —
       * and then drew a conclusion the measurement did not support. Framing is
       * governed by the organisation's embedding host list; MESSAGING is
       * governed by `embed_origin` on the checkout object, and Polar's page
       * returns early from every `postMessage` without it. The field renders
       * nothing and is the only reason the modal can ever close.
       *
       * ⚠ IT IS SET IN `billing/polar.ts`, DERIVED FROM `success_url`, rather
       * than passed from here. Both values name the console, and two settings
       * that must agree are one setting and one bug.
       */
      /*
       * ⚠ THE ID IS RETURNED SO THE CONSOLE CAN ASK US WHETHER THE MONEY
       * LANDED, RATHER THAN ONLY BELIEVING POLAR'S IFRAME. Their embedded
       * checkout is supposed to `postMessage` a `success` event to the parent
       * when it completes; measured on 2026-09-18 it did not — the checkout
       * reached `succeeded` on Polar's side, their page's follow-up
       * `PATCH /v1/checkouts/client/…` answered 403, and no message was ever
       * posted. The customer sat in front of a modal saying "waiting for
       * confirmation" for a payment that had already gone through.
       *
       * The id is what lets the console poll `/checkout-status/{id}` instead.
       * See @repo/console lib/polar-embed.ts.
       */
      return c.json({
        id: checkout.id,
        url: checkout.url,
        expiresAt: checkout.expiresAt,
      })
    } catch (error) {
      d.log.error({ err: String(error), tenantId, plan }, "console checkout failed")
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
   * A short-lived token for the embedded "add a card" form.
   *
   * ⚠ THE SAME OPERATION `/billing/payment-method-session` ALREADY EXPOSES, AND
   * IT HAS TO EXIST TWICE FOR THE SAME REASON CHECKOUT DOES. That one is behind
   * `requireApiKey`, and the browser adding the card does not have an API key
   * and must not be given one. Both call the identical Polar method, so there
   * is no second way to mint a session that could drift from the first.
   *
   * ⚠ THE TOKEN IS THE WHOLE CREDENTIAL, AND IT IS SCOPED AND SHORT-LIVED FOR
   * THAT REASON. It authorises one customer's portal for an hour; the
   * alternative is our Polar access token in a browser, which authorises every
   * customer forever. It is returned to the page rather than logged.
   *
   * ⚠ AND NO CARD NUMBER EVER TOUCHES US. The fields render inside Polar's own
   * iframe on Polar's origin, so the digits never enter this application's DOM
   * or its logs — which is what keeps i10 in PCI SAQ A rather than in scope for
   * the questionnaire that asks how our servers handle cardholder data.
   */
  app.post("/billing/payment-method-session", async (c) => {
    if (!d.billing) return c.json(notWired("Billing"), 501)
    const { tenantId } = c.get("auth")

    try {
      const session = await d.billing.polar.createCustomerSession(tenantId)
      return c.json({ token: session.token })
    } catch (error) {
      d.log.error({ err: String(error), tenantId }, "console customer session failed")

      /*
       * ⚠ A MISSING SCOPE IS OUR MISCONFIGURATION AND SAYS SO, because "try
       * again in a moment" is false advice for a condition that will never
       * clear on its own. Polar's organisation access tokens do not include
       * `customer_sessions:write` by default, so this is the FIRST thing that
       * fails on a fresh deployment — and the generic message sent whoever hit
       * it looking at the customer record instead of at the token.
       */
      const message = String(error)

      /*
       * ⚠ NO POLAR CUSTOMER IS A 409, NOT A 502, BECAUSE NOTHING IS BROKEN.
       * Polar creates the customer at the first checkout, so a workspace that
       * has never subscribed genuinely has nothing to attach a card to. The
       * console does not offer the button in that state — see the billing page —
       * so reaching this means the two disagreed, and the status has to say
       * "not applicable" rather than "our fault".
       */
      if (message.includes("no Polar customer for tenant")) {
        return c.json(
          {
            statusCode: 409,
            name: "no_billing_account" as const,
            message:
              "There is no payment account for this workspace yet. Start a plan " +
              "first — the card is collected as part of that.",
          },
          409,
        )
      }

      /*
       * ⚠ A MISSING SCOPE IS OUR MISCONFIGURATION AND SAYS SO, because "try
       * again in a moment" is false advice for a condition that will never
       * clear on its own. Polar's organisation access tokens do not include
       * `customer_sessions:write` by default, so this is the FIRST thing that
       * fails on a fresh deployment — and a generic message sends whoever hit
       * it looking at the customer record instead of at the token.
       */
      if (message.includes("customer_sessions:write")) {
        return c.json(
          {
            statusCode: 502,
            name: "internal_server_error" as const,
            message:
              "Card management is not configured on this deployment yet. This is " +
              "on us, not on your account — please contact support.",
          },
          502,
        )
      }

      return c.json(
        {
          statusCode: 502,
          name: "internal_server_error" as const,
          message: "Could not open the card form. Try again in a moment.",
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
  app.post("/billing/plan", async (c) => {
    if (!d.billing?.planChange) return c.json(notWired("Plan changes"), 501)
    const { tenantId } = c.get("auth")
    const body = await readJson(c)
    const plan = typeof body?.plan === "string" ? body.plan : ""
    if (!plan) return c.json(validation('Send `{ "plan": "pro" }`.'), 422)

    const outcome = await d.billing.planChange.to(tenantId, plan)

    switch (outcome.status) {
      case "requested":
        // ⚠ 202, NOT 200. Polar has accepted the change; the ENTITLEMENT moves
        // when their webhook says it did. The console polls `/console/me`,
        // exactly as it does after a checkout, and a 200 would invite it not to.
        return c.json(outcome, 202)
      case "unchanged":
        return c.json({ status: "unchanged", plan })
      case "rejected":
        return c.json(validation(outcome.reason), 422)
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

  // ───────────────────────────────────────────────────────────────────────────
  // Onboarding
  // ───────────────────────────────────────────────────────────────────────────

  app.get("/onboarding", async (c) => {
    const { tenantId } = c.get("auth")
    const billing = await d.usage.billing(tenantId)
    return c.json(await d.onboarding.get(tenantId, billing.plan?.id ?? null))
  })

  app.patch("/onboarding", async (c) => {
    const { tenantId } = c.get("auth")
    const body = await readJson(c)

    if (typeof body?.use_case === "string") {
      await d.onboarding.setUseCase(tenantId, body.use_case.slice(0, 500))
    }

    if (typeof body?.step === "string") {
      if (!(STEPS as readonly string[]).includes(body.step)) {
        return c.json(validation(`\`step\` must be one of ${STEPS.join(", ")}.`), 422)
      }
      await d.onboarding.setStep(tenantId, body.step as Step)
    }

    if (body?.completed === true) {
      const billing = await d.usage.billing(tenantId)
      await d.onboarding.complete(tenantId, billing.plan?.id ?? null)
    }

    const billing = await d.usage.billing(tenantId)
    return c.json(await d.onboarding.get(tenantId, billing.plan?.id ?? null))
  })
}

/**
 * Where Polar sends the browser back, for the page that started the checkout.
 *
 * ⚠ SOMEBODY WHO BOUGHT A PLAN DURING ONBOARDING BELONGS BACK IN ONBOARDING.
 * `POLAR_SUCCESS_URL` names one page for every checkout in the product, so
 * everyone landed on the same confirmation regardless of what they were in the
 * middle of — and for a flow with steps after the payment, that is a dead end
 * dressed as a success.
 *
 * ⚠ THE ORIGIN IS ALWAYS OURS, AND ONLY THE PATH IS THE CALLER'S. Polar will
 * redirect a browser to whatever `success_url` says, so accepting a whole URL
 * here would make this endpoint an open redirect that a payment page performs —
 * and one that looks entirely legitimate, because the money really was taken.
 * The configured value supplies the origin; the request may only choose a path
 * beneath it.
 *
 * ⚠ AND `//` IS REFUSED ALONGSIDE AN ABSOLUTE URL, because it starts with a
 * slash and still resolves to another origin. Same rule, same reason, as
 * `safeReturnTo` in dns/oauth.ts — see the note there.
 */
function returnTo(
  configured: string | undefined,
  requested: unknown,
): string | undefined {
  if (!configured) return undefined
  if (typeof requested !== "string" || !requested.startsWith("/")) return configured
  if (/^\/[/\\]/.test(requested)) return configured

  try {
    return new URL(requested, new URL(configured).origin).toString()
  } catch {
    return configured
  }
}
