import { Hono } from "hono"
import { ingestEvent, type EventOps, type Logger } from "../webhooks/events.js"
import {
  interpretStalwartEvent,
  verifyStalwartSignature,
  type StalwartEventBatch,
} from "../webhooks/stalwart.js"

/**
 * Delivery outcomes for the direct route, pushed by our own MTA.
 *
 * ⚠ THE ENDPOINT IS PUBLIC AND WHAT IT WRITES IS PERMANENT, EXACTLY AS THE SES
 * ONE IS. A forged `delivery.rcpt-to-rejected` with a 5xx suppresses an address
 * for a tenant — their mail to that person stops, quietly and for good. Nothing
 * reaches the database before the HMAC verifies.
 *
 * ⚠ AND THE SIGNATURE CARRIES NO TIMESTAMP, SO IT NEVER EXPIRES. Stalwart signs
 * the raw body and nothing else, which means a captured request stays valid
 * forever and can be posted again at will. The `(source_event_id, occurred_at)`
 * dedupe is what makes that harmless, and it only works because the id is
 * derived from the event's content rather than from Stalwart's own event id —
 * see `sourceEventIdFor`. That is a security property here, not a tidiness one.
 *
 * ⚠ THE STATUS CODES ARE A RETRY POLICY. Stalwart holds an undelivered batch and
 * retries until `discardAfter` (five minutes by default), so:
 *
 *   403  the signature did not verify. Retrying cannot help, and answering 200
 *        to an unverified request tells a forger their forgery worked.
 *   200  accepted, ignored, duplicate, or about a message we no longer have.
 *        All four mean "stop sending this".
 *   500  a genuine batch we failed to write. Retry is exactly right.
 *
 * ⚠ A BATCH IS MANY EVENTS AND ONE STATUS CODE, WHICH IS THE AWKWARD PART.
 * Stalwart groups everything inside its `throttle` window into one POST, so a
 * 500 replays events that already committed. The dedupe absorbs that — which is
 * the same reason it exists above, and why partial failure is allowed to be
 * loud rather than clever.
 */

export interface StalwartWebhookDeps {
  events: EventOps
  log: Logger
  /** The `signatureKey` configured on Stalwart's WebHook object. */
  secret: string
}

export function createStalwartWebhooks(deps?: StalwartWebhookDeps) {
  const app = new Hono()

  app.post("/stalwart", async (c) => {
    if (!deps) {
      return c.json(
        {
          statusCode: 503,
          name: "service_unavailable",
          message: "Direct-route event ingestion is not configured.",
        },
        503,
      )
    }

    // ⚠ THE RAW TEXT, AND IT MUST BE READ BEFORE ANYTHING PARSES IT. The HMAC
    // is over the exact bytes Stalwart serialised; `c.req.json()` would give us
    // an object, and re-serialising it changes key order, whitespace and number
    // formatting — a signature that can never match, on a body that is
    // genuinely Stalwart's.
    const body = await c.req.text()

    if (!verifyStalwartSignature(body, c.req.header("X-Signature"), deps.secret)) {
      deps.log.warn({ bytes: body.length }, "rejected a Stalwart notification")
      return c.json(
        { statusCode: 403, name: "invalid_access", message: "Invalid signature." },
        403,
      )
    }

    let batch: StalwartEventBatch
    try {
      const parsed: unknown = JSON.parse(body)
      // `JSON.parse` succeeds on `null`, `1` and `"x"`, and the loop below reads
      // `.events` off whatever this is.
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new TypeError("not an object")
      }
      batch = parsed as StalwartEventBatch
    } catch {
      // Signed with our key and still unparseable: a Stalwart version change
      // rather than an attack. Retrying will not fix it.
      deps.log.error({ bytes: body.length }, "Stalwart payload is not JSON")
      return c.json({ ok: true }, 200)
    }

    const events = batch.events ?? []
    let recorded = 0
    let queued = 0
    let ignored = 0

    for (const event of events) {
      const normalised = interpretStalwartEvent(event)
      // Not an event we act on, or not one of our messages — Stalwart's queue
      // carries mailbox mail and its own reports through the same path.
      if (!normalised) {
        ignored++
        continue
      }

      // ⚠ NOT `Promise.all`, AND THE ORDER IS THE REASON. Events for one message
      // arrive in the order they happened — `delivered` after `attempt-start`,
      // `failed` after a retry — and `webhook_deliveries` is drained per
      // endpoint in insertion order. Writing a batch concurrently would let a
      // customer's endpoint receive `bounced` before the `delivery_delayed` that
      // preceded it, and their state machine would read backwards.
      try {
        const outcome = await ingestEvent(normalised, { ...deps.events, log: deps.log })
        if (outcome.status === "recorded") {
          recorded++
          queued += outcome.queued
        }
      } catch (err) {
        // ⚠ 500 SO STALWART REDELIVERS, AND THE EVENTS ALREADY WRITTEN IN THIS
        // BATCH ARE REPLAYED WITH IT. That is the right trade: the dedupe makes
        // a replay a no-op, and losing a bounce means an address we keep
        // sending to. Failing the whole batch also keeps the ordering promise —
        // skipping the failure and continuing would let a later event land
        // without the one it follows.
        deps.log.error(
          { err, messageId: normalised.messageId, type: normalised.type },
          "failed to ingest a Stalwart event",
        )
        return c.json(
          {
            statusCode: 500,
            name: "internal_server_error",
            message: "Could not record the event.",
          },
          500,
        )
      }
    }

    if (recorded > 0 || ignored > 0) {
      deps.log.info(
        { received: events.length, recorded, ignored, queued },
        "ingested Stalwart delivery events",
      )
    }

    return c.json({ ok: true, recorded, ignored }, 200)
  })

  return app
}
