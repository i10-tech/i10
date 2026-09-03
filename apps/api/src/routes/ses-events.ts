import { Hono, type Context } from "hono"
import { ingestSesEvent, type EventOps, type Logger } from "../webhooks/events.js"
import {
  cachingCertificateFetcher,
  isAwsUrl,
  verifySnsMessage,
  type CertificateFetcher,
  type SnsMessage,
} from "../webhooks/sns.js"

/**
 * SES delivery events, arriving over SNS.
 *
 * ⚠ THE ENDPOINT IS PUBLIC AND WHAT IT WRITES IS PERMANENT. A `Bounce` here
 * suppresses an address for a tenant — their mail to that person stops, quietly
 * and for good — and a `Complaint` does the same. Anyone who learns this URL can
 * do that to every customer at once unless each notification is proved to be
 * Amazon's, so nothing reaches the database before the signature verifies.
 *
 * ⚠ AND THE STATUS CODES ARE A RETRY POLICY, NOT DECORATION. SNS retries
 * anything that is not 2xx, for hours, with backoff:
 *
 *   403  the signature did not verify. Retrying cannot help — and answering 200
 *        to an unverified request tells a forger their forgery worked.
 *   200  accepted, ignored, duplicate, or about a message we no longer have.
 *        All four mean "stop sending this": the first three are done, and the
 *        fourth is retention doing its job rather than a fault.
 *   500  a genuine event we failed to write. Retry is exactly right, and the
 *        transaction rolled back, so the retry is not swallowed as a duplicate.
 */

export interface SesWebhookDeps {
  events: EventOps
  log: Logger
  /** Injected in tests; caches Amazon's signing certificates in production. */
  fetchCertificate?: CertificateFetcher
  /**
   * ⚠ CONFIRMATION IS AUTOMATIC AND THAT IS A DECISION WITH A COST. An
   * unconfirmed subscription delivers nothing, so requiring a human to paste a
   * URL means every environment silently has no delivery events until someone
   * notices. It is only safe because the confirmation is signed by Amazon and
   * the SubscribeURL is checked to be Amazon's before it is fetched — without
   * both, this would be an open redirect that we follow on request.
   */
  confirmSubscriptions?: boolean
  fetch?: typeof fetch
}

export function createSesWebhooks(deps?: SesWebhookDeps) {
  const app = new Hono()
  const fetchCertificate = deps?.fetchCertificate ?? cachingCertificateFetcher()

  app.post("/ses", async (c) => {
    if (!deps) {
      return c.json(
        {
          statusCode: 503,
          name: "service_unavailable",
          message: "Event ingestion is not configured.",
        },
        503,
      )
    }

    let message: SnsMessage
    try {
      const parsed: unknown = await c.req.json()
      // ⚠ `JSON.parse` SUCCEEDS ON `null`, `1` AND `"x"`. The verifier reads
      // `.Type` off whatever this is, so a four-byte body of `null` would be a
      // TypeError rather than a rejection — a public endpoint anyone can make
      // log an error and answer 500 on demand.
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new TypeError("not an object")
      }
      message = parsed as SnsMessage
    } catch {
      return c.json(
        { statusCode: 400, name: "validation_error", message: "Body is not JSON." },
        400,
      )
    }

    const verified = await verifySnsMessage(message, fetchCertificate)
    if (!verified.ok) {
      deps.log.warn(
        { reason: verified.reason, snsMessageId: message.MessageId },
        "rejected an SNS notification",
      )
      return c.json(
        { statusCode: 403, name: "invalid_access", message: "Invalid signature." },
        403,
      )
    }

    if (message.Type === "SubscriptionConfirmation") {
      return confirmSubscription(c, message, deps)
    }

    if (message.Type !== "Notification") {
      // An UnsubscribeConfirmation, or something new. Signed by Amazon, so not
      // an attack — and not ours to act on.
      deps.log.info({ type: message.Type }, "ignoring an SNS control message")
      return c.json({ ok: true }, 200)
    }

    let payload: unknown
    try {
      payload = JSON.parse(message.Message)
    } catch {
      // Signed by Amazon and still unparseable: a contract change rather than an
      // attack. Retrying will not fix it, so take it off the queue and be loud.
      deps.log.error({ snsMessageId: message.MessageId }, "SNS payload is not JSON")
      return c.json({ ok: true }, 200)
    }

    try {
      const outcome = await ingestSesEvent(
        payload,
        message.MessageId,
        { ...deps.events, log: deps.log },
        // ⚠ SNS's OWN TIMESTAMP AS THE FALLBACK CLOCK. It is present on every
        // notification and identical on every redelivery, which is what keeps
        // the (source_event_id, occurred_at) dedupe working for a payload whose
        // own timestamps are unusable.
        parseTimestamp(message.Timestamp),
      )
      if (outcome.status === "recorded") {
        deps.log.info(
          { snsMessageId: message.MessageId, queued: outcome.queued },
          "ingested an SES event",
        )
      }
      return c.json({ ok: true, outcome: outcome.status }, 200)
    } catch (err) {
      // ⚠ 500 SO SNS RETRIES. This is the one path where losing the event
      // matters: a bounce we never record is an address we keep sending to.
      deps.log.error({ err, snsMessageId: message.MessageId }, "failed to ingest")
      return c.json(
        {
          statusCode: 500,
          name: "internal_server_error",
          message: "Could not record the event.",
        },
        500,
      )
    }
  })

  return app
}

async function confirmSubscription(
  c: Context,
  message: SnsMessage,
  deps: SesWebhookDeps,
) {
  const url = message.SubscribeURL
  // ⚠ CHECKED AGAIN HERE EVEN THOUGH THE MESSAGE IS SIGNED. The signature says
  // Amazon sent it; it does not say the SubscribeURL points at Amazon, and this
  // is a URL we are about to fetch from inside the cluster.
  if (!url || !isAwsUrl(url)) {
    deps.log.warn({ url }, "refusing to confirm a non-AWS SubscribeURL")
    return c.json(
      { statusCode: 400, name: "validation_error", message: "Bad SubscribeURL." },
      400,
    )
  }

  if (deps.confirmSubscriptions === false) {
    deps.log.warn({ topic: message.TopicArn }, "subscription awaiting manual confirm")
    return c.json({ ok: true, outcome: "confirmation_skipped" }, 200)
  }

  try {
    const response = await (deps.fetch ?? fetch)(url, {
      signal: AbortSignal.timeout(5000),
    })
    deps.log.info(
      { topic: message.TopicArn, status: response.status },
      "confirmed an SNS subscription",
    )
  } catch (err) {
    deps.log.error({ err, topic: message.TopicArn }, "could not confirm subscription")
    // 500 so SNS resends the confirmation; an unconfirmed topic delivers nothing
    // and the failure is otherwise completely silent.
    return c.json(
      {
        statusCode: 500,
        name: "internal_server_error",
        message: "Could not confirm.",
      },
      500,
    )
  }

  return c.json({ ok: true, outcome: "confirmed" }, 200)
}

function parseTimestamp(value: string | undefined): Date | undefined {
  if (!value) return undefined
  const at = new Date(value)
  return Number.isNaN(at.getTime()) ? undefined : at
}
