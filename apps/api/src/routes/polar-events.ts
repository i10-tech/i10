import { Hono } from "hono"
import { decide, type DecideOptions, type PolarEvent } from "../billing/events.js"
import type { Logger, SubscriptionGrants } from "../billing/grants.js"
import { verifyPolarWebhook } from "../billing/signature.js"

/**
 * Polar subscription events.
 *
 * ⚠ THIS IS THE ONE ENDPOINT IN THE PRODUCT THAT GRANTS PAID PLANS, and it is
 * unauthenticated by necessity — Polar has no API key of ours to present. The
 * signature is the entire access control, so nothing is parsed for meaning
 * before it verifies, and the tenant id is read from the verified payload
 * rather than from anything in the URL or a header.
 *
 * ⚠ AND NOTHING ELSE MAY DO WHAT THIS DOES. The checkout endpoint creates a
 * session and grants nothing; the page Polar redirects the customer to after
 * payment grants nothing, because that redirect is a browser navigation anybody
 * can perform. See billing/grants.ts.
 *
 * ⚠ THE STATUS CODES ARE A RETRY POLICY. Polar redelivers anything that is not
 * 2xx:
 *
 *   403  the signature did not verify. A retry cannot help, and answering 2xx
 *        to an unverified request tells a forger their forgery worked.
 *   202  accepted, or an event that is not ours — an order, a benefit, a
 *        product for some other purpose. "Not ours" is not a failure, and a
 *        non-2xx would have Polar retrying it all afternoon.
 *   500  a real event we could not apply. Retry is exactly right: the
 *        subscription row is already durable, so the retry re-runs the
 *        call rather than starting over, and the reconciler is the backstop if
 *        the retries run out.
 */

export interface PolarWebhookDeps {
  /** The endpoint secret from Polar's dashboard. Sandbox and production differ. */
  secret: string
  grants: SubscriptionGrants
  options: DecideOptions
  log: Logger
}

export function createPolarWebhooks(deps?: PolarWebhookDeps) {
  const app = new Hono()

  app.post("/polar", async (c) => {
    if (!deps) {
      // Mounted unconditionally so a missing secret is a 503 that says so,
      // rather than a 404 that looks like Polar having the wrong URL.
      return c.json(
        {
          statusCode: 503,
          name: "service_unavailable",
          message: "Billing events are not configured.",
        },
        503,
      )
    }

    // ⚠ THE RAW TEXT, AND IT IS SIGNED MATERIAL. Parsing and re-serialising
    // moves key order, unicode escapes and number formatting, so a signature
    // checked against the round-tripped body fails in a way that reads exactly
    // like a wrong secret.
    const body = await c.req.text()

    const verified = verifyPolarWebhook(
      body,
      {
        id: c.req.header("webhook-id"),
        timestamp: c.req.header("webhook-timestamp"),
        signature: c.req.header("webhook-signature"),
      },
      deps.secret,
    )

    if (!verified.ok) {
      deps.log.warn({ reason: verified.reason }, "rejected a Polar webhook")
      return c.json(
        { statusCode: 403, name: "invalid_access", message: "Invalid signature." },
        403,
      )
    }

    let event: PolarEvent
    try {
      const parsed: unknown = JSON.parse(body)
      // `JSON.parse` succeeds on `null`, `1` and `"x"`, and `decide` reads
      // `.type` off whatever this is — a four-byte body would be a TypeError
      // and a 500 rather than a rejection.
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new TypeError("not an object")
      }
      event = parsed as PolarEvent
    } catch {
      // Signed by Polar and still unparseable: a contract change rather than an
      // attack, and retrying it forever helps nobody.
      deps.log.error({ webhookId: verified.id }, "Polar payload is not JSON")
      return c.json({ ok: true, outcome: "unparseable" }, 202)
    }

    const decided = decide(event, deps.options)
    if (decided.kind === "ignore") {
      /*
       * ⚠ STILL 202, BECAUSE A RETRY CANNOT HELP EITHER WAY — BUT NOT STILL
       * `info`. A stranded subscription is a customer who has paid, whom Polar
       * shows as active, and whom nothing on this side will ever grant: the
       * reconciler discards it by the same rule this line just applied. That is
       * the loudest thing this endpoint can discover, and it used to read
       * exactly like an order event for somebody else's product.
       */
      if (decided.stranded) {
        deps.log.error(
          { webhookId: verified.id, type: event.type, reason: decided.reason },
          "a paid subscription could not be attributed to a tenant and was " +
            "DISCARDED — set the Polar customer's external_id to the tenant id",
        )
      } else {
        deps.log.info(
          { webhookId: verified.id, type: event.type, reason: decided.reason },
          "ignored a Polar event",
        )
      }
      return c.json({ ok: true, outcome: "ignored" }, 202)
    }

    try {
      const outcome = await deps.grants.apply(decided.state)
      return c.json({ ok: true, outcome: outcome.status }, 202)
    } catch (error) {
      deps.log.error(
        { err: error, webhookId: verified.id, tenantId: decided.state.tenantId },
        "could not apply a subscription event",
      )
      return c.json(
        {
          statusCode: 500,
          name: "internal_server_error",
          message: "Could not apply the subscription.",
        },
        500,
      )
    }
  })

  return app
}
