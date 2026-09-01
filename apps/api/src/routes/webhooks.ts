import { Hono } from "hono"
import type { Database } from "../db/client.js"
import { applyClerkEvent } from "../projection/writer.js"
import { readSvixHeaders, verifySvixSignature } from "../webhooks/svix.js"

export interface Logger {
  info: (o: object, m: string) => void
  warn: (o: object, m: string) => void
  error: (o: object, m: string) => void
}

export interface ClerkWebhookDeps {
  db: Database
  signingSecret: string
  hostedDomains: readonly string[]
  log?: Logger
}

/**
 * Receives Clerk's webhooks and maintains the mailbox projection.
 *
 * The projection is what `services/authd` serves to Stalwart, so this endpoint
 * decides which addresses exist as local recipients. Nothing reaches the
 * database before the Svix signature verifies.
 *
 * On status codes — Svix retries anything that is not 2xx, with backoff, then
 * gives up:
 *
 *   401  bad or missing signature. Retrying will not help, but answering 200 to
 *        an unverified request would tell a forger it worked.
 *   400  signed by us and still unparseable, so a contract change rather than
 *        an attack. Retrying will not fix it; take it off the queue and be loud.
 *   200  accepted, ignored, stale, or a duplicate. All mean "stop sending this".
 *   500  we failed to process a genuine event. Retry is exactly right, and the
 *        transaction rolled back so the retry is not swallowed as a duplicate.
 */
export function createClerkWebhooks(deps?: ClerkWebhookDeps) {
  const app = new Hono()

  app.post("/clerk", async (c) => {
    if (!deps) {
      return c.json(
        {
          statusCode: 503,
          name: "service_unavailable",
          message: "Webhook processing is not configured.",
        },
        503,
      )
    }

    // ⚠ VERIFY THE RAW BYTES. The signature covers the exact text received;
    // parsing to JSON and re-serialising changes key order and whitespace, and
    // every delivery would fail to verify.
    const body = await c.req.text()
    const headers = readSvixHeaders((name) => c.req.header(name))

    const verified = verifySvixSignature(body, headers, deps.signingSecret)
    if (!verified.ok) {
      deps.log?.warn(
        { reason: verified.reason, svixId: headers.id },
        "rejected clerk webhook",
      )
      return c.json(
        { statusCode: 401, name: "invalid_access", message: "Invalid signature." },
        401,
      )
    }

    let event: { type?: unknown; data?: unknown }
    try {
      event = JSON.parse(body) as { type?: unknown; data?: unknown }
    } catch {
      deps.log?.error({ svixId: headers.id }, "clerk webhook body is not JSON")
      return c.json(
        { statusCode: 400, name: "validation_error", message: "Body is not JSON." },
        400,
      )
    }

    if (typeof event.type !== "string") {
      deps.log?.error({ svixId: headers.id }, "clerk webhook has no event type")
      return c.json(
        { statusCode: 400, name: "validation_error", message: "Missing event type." },
        400,
      )
    }

    try {
      const result = await applyClerkEvent(
        deps.db,
        headers.id!,
        event.type,
        event.data,
        deps.hostedDomains,
      )
      deps.log?.info(
        { svixId: headers.id, type: event.type, outcome: result.outcome },
        "clerk webhook applied",
      )
      return c.json({ ok: true, ...result })
    } catch (err) {
      deps.log?.error(
        { svixId: headers.id, type: event.type, err: String(err) },
        "clerk webhook failed",
      )
      return c.json(
        {
          statusCode: 500,
          name: "internal_server_error",
          message: "Could not process the event.",
        },
        500,
      )
    }
  })

  return app
}
