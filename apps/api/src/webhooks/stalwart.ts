import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import type { WebhookEventName } from "@repo/contracts"
import type { NormalisedEvent, Suppression } from "./events.js"

/**
 * Delivery outcomes for the direct route, pushed by Stalwart.
 *
 * ⚠ THIS IS THE DIRECT ROUTE'S ONLY SOURCE OF `delivered` AND `bounced`, AND
 * WITHOUT IT A DIRECT-ROUTED MESSAGE STOPS AT `sent` FOREVER.
 * `core.message_events` was written exclusively by the SES ingest, so a customer
 * watching webhooks saw SES-routed mail progress and direct-routed mail go
 * quiet — the one difference in the product that the per-domain route lever is
 * supposed to make invisible.
 *
 * ⚠ A WEBHOOK FROM OUR OWN MTA, NOT A PARSED DSN, AND THAT IS A BETTER DEAL
 * THAN THE ONE ORIGINALLY PLANNED. The VERP envelope was built so a bounce
 * message could be attributed, which assumed we would receive DSN mail: an MX
 * for every customer's `bounce.<domain>`, Stalwart configured to accept those
 * domains, a mailbox to read, and an RFC 3464 `multipart/report` parser. None of
 * that exists, and none of it is needed for the outcomes Stalwart itself
 * observes — it is the one attempting delivery, so it knows the answer before
 * any DSN could be written. It also reports `delivered`, which a DSN never does
 * unless the sender asked for a success notification.
 *
 * ⚠ WHAT THIS DOES NOT COVER IS THE ASYNCHRONOUS BOUNCE. A receiver that
 * answers `250` and only later decides the mailbox is gone sends a DSN to the
 * envelope sender, and that is inbound mail we still do not accept. Those
 * bounces remain invisible. The VERP envelope keeps its purpose — it is what
 * will make those attributable — so this narrows the gap rather than closing it,
 * and says so rather than letting a half-covered case read as a whole one.
 */

/**
 * ⚠ THE KEY IS THE SECRET'S OWN BYTES, NOT BASE64-DECODED, AND THIS FILE IS THE
 * ONE PLACE IN THE REPOSITORY WHERE THAT IS TRUE. Every other signature here
 * goes through `decodeSecret`, because Svix's scheme keys the HMAC with the
 * decoded value and `signing.ts` says at length that using the printable form is
 * the mistake that looks right from inside this codebase. Stalwart is not Svix:
 * its source does `hmac::Key::new(HMAC_SHA256, settings.key.as_bytes())` over
 * the configured string exactly as written. Reusing `decodeSecret` here would
 * reject every genuine notification, and the symptom — a 403 on a signature that
 * is demonstrably correct — sends you looking at the wrong half.
 *
 * ⚠ AND IT SIGNS THE RAW BODY, WITH NO TIMESTAMP AND NO ID IN THE PREIMAGE.
 * `hmac::sign(&key, body.as_bytes())`, base64 standard, in `X-Signature`. That
 * means the signature is REPLAYABLE: anyone who captures one request can post it
 * again forever, and nothing in the scheme expires. The dedupe below is the
 * mitigation and is load-bearing rather than an optimisation — a replayed batch
 * must be a no-op, not a second round of customer webhooks.
 */
export function verifyStalwartSignature(
  body: string,
  header: string | undefined,
  secret: string,
): boolean {
  if (!header) return false

  const expected = createHmac("sha256", secret).update(body, "utf8").digest()

  let given: Buffer
  try {
    given = Buffer.from(header, "base64")
  } catch {
    return false
  }

  // ⚠ CONSTANT TIME, AND THE LENGTH GUARD IS NOT OPTIONAL — `timingSafeEqual`
  // throws on a mismatch rather than returning false. The length itself is not
  // a secret: a SHA-256 tag is always 32 bytes.
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/** One event as Stalwart serialises it. */
export interface StalwartEvent {
  id?: string
  createdAt?: string
  type?: string
  data?: Record<string, unknown>
}

export interface StalwartEventBatch {
  events?: StalwartEvent[]
}

/**
 * ⚠ EVERY EVENT WE ACT ON, AND NOTHING ELSE. Stalwart emits hundreds, its
 * webhook takes an explicit include list with no wildcards, and this map is the
 * other half of that list — see `plan.ndjson`. An event arriving that is not
 * here is ignored rather than an error, for the same reason the SES ingest
 * ignores `Open`: somebody will widen the list in the admin UI to see what it
 * does, and that must not make this endpoint fail every batch.
 *
 * ⚠ THE FOUR ARE NOT INTERCHANGEABLE, AND THE SUPPRESSION COLUMN IS THE WHOLE
 * REASON THIS IS A TABLE RATHER THAN A SET:
 *
 *   delivery.delivered         250 on DATA for this recipient.
 *   delivery.rcpt-to-rejected  the receiver refused this address. 5xx means it
 *                              does not exist — the only hard bounce here.
 *   delivery.message-rejected  the receiver refused the MESSAGE, not the
 *                              address. Never suppresses: the recipient is
 *                              fine and the content or our reputation is not.
 *   delivery.failed            we gave up after the retry window expired. A
 *                              bounce, but NOT evidence the address is dead —
 *                              the receiver was down, and suppressing on it
 *                              would stop a customer's mail to somebody whose
 *                              mailbox works.
 */
const TYPES: Record<string, WebhookEventName> = {
  "delivery.delivered": "email.delivered",
  "delivery.rcpt-to-rejected": "email.bounced",
  "delivery.message-rejected": "email.bounced",
  "delivery.failed": "email.bounced",
  "queue.rescheduled": "email.delivery_delayed",
}

/**
 * i10's message id, out of the VERP envelope sender.
 *
 * ⚠ THE `from` KEY IS NOT ON THE OUTCOME EVENT — IT ARRIVES FROM THE SPAN, AND
 * THAT IS WHY THIS WORKS AT ALL. `delivery.delivered` carries only
 * `spanId`, `hostname`, `to`, `code`, `details` and `elapsed`; the envelope
 * sender is on `delivery.attempt-start`, which opens the span. Stalwart's
 * collector attaches the open span to every event carrying its id, and the JSON
 * serializer is built `.with_spans()`, so the span's keys are merged into
 * `data`. Read in the source rather than assumed, because the alternative
 * design — correlating outcome events to an earlier `attempt-start` by
 * `queueId` — needs state we would have to keep and expire ourselves.
 *
 * ⚠ THE EVENT'S OWN KEY WINS ON A COLLISION, WHICH IS WHAT WE WANT. Both the
 * event and the span define `to`; the serializer inserts the event's first and
 * skips the duplicate, so `to` is the ONE recipient this outcome is about rather
 * than the span's list of all of them.
 */
export function messageIdFrom(envelopeSender: unknown): string | null {
  if (typeof envelopeSender !== "string") return null
  // `bounce+<uuid>@bounce.<domain>` — see stalwartTransport.
  const match =
    /\+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@/i.exec(
      envelopeSender,
    )
  return match?.[1]?.toLowerCase() ?? null
}

/**
 * A dedupe key that survives a redelivery.
 *
 * ⚠ STALWART'S OWN `id` DOES NOT, AND USING IT WOULD HAVE BEEN THE BUG. It is
 * `{timestamp}{counter}{typeId}`, where the counter is a PROCESS-GLOBAL ATOMIC
 * INCREMENTED AT SERIALISATION TIME — not a property of the event. When a POST
 * fails, Stalwart pushes the same events back onto its pending list and a later
 * batch serialises them again, drawing fresh counter values. So the "unique
 * identifier for the event" is a different string every time the same event is
 * sent, and keying `(source_event_id, occurred_at)` on it would turn every
 * failed delivery attempt into a second `email.bounced`, a second suppression
 * and a second customer webhook.
 *
 * ⚠ SO THE KEY IS DERIVED FROM WHAT THE EVENT IS, NOT FROM WHAT IT IS CALLED.
 * Type, timestamp, queue id and recipient identify one outcome for one address
 * on one queued message; a genuine second attempt to the same recipient carries
 * a later `createdAt` and is a different event, which is correct.
 *
 * ⚠ AND IT IS PREFIXED, BECAUSE THE COLUMN IS SHARED WITH SNS. `source_event_id`
 * holds Amazon's message ids too, and an unprefixed hash could in principle
 * collide with one — which would silently discard a real event as a duplicate.
 */
export function sourceEventIdFor(event: StalwartEvent): string {
  const data = event.data ?? {}
  const canonical = [
    event.type ?? "",
    event.createdAt ?? "",
    String(data["queueId"] ?? ""),
    firstRecipient(data["to"]) ?? "",
  ].join(" ")
  return `stalwart_${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`
}

/**
 * Turns one Stalwart event into the shape the ingest already understands.
 *
 * ⚠ IT PRODUCES THE SAME `NormalisedEvent` THE SES PATH DOES, SO EVERYTHING
 * DOWNSTREAM IS SHARED — the dedupe, the suppression write, the endpoint fan-out
 * and the customer's payload shape. Two interpreters, one persistence path: a
 * customer must not be able to tell from a webhook which MTA carried their
 * message, and the surest way to guarantee that is for there to be only one
 * piece of code that writes one.
 */
export function interpretStalwartEvent(
  event: StalwartEvent,
  fallbackAt: Date = new Date(),
): NormalisedEvent | null {
  const type = event.type ? TYPES[event.type] : undefined
  if (!type) return null

  const data = event.data ?? {}
  const messageId = messageIdFrom(data["from"])
  // ⚠ NOT EVERY MESSAGE IN THIS QUEUE IS OURS. Stalwart carries human mailbox
  // mail and its own reports and DSNs through the same outbound path, and none
  // of those has a VERP envelope. No id means "not a transactional send", which
  // is ordinary rather than a fault.
  if (!messageId) return null

  const occurredAt = parseDate(event.createdAt) ?? fallbackAt
  const code = numberOf(data["code"])
  const recipients = recipientsOf(data["to"])

  return {
    type,
    messageId,
    occurredAt,
    sourceEventId: sourceEventIdFor(event),
    suppress: suppressionsFor(event.type, code, recipients),
    data: publicData(type, event, messageId, occurredAt, code, recipients),
    raw: event,
  }
}

/**
 * ⚠ ONE EVENT SUPPRESSES, AND ONLY WITH A 5xx. `delivery.rcpt-to-rejected`
 * carries the receiver's reply code for THIS address: 5xx means the mailbox does
 * not exist and writing to it again is pointless, 4xx means come back later.
 * This is the same Permanent/Transient split `suppressionsFrom` makes for SES,
 * in a different vocabulary.
 *
 * ⚠ AND NOTHING ELSE SUPPRESSES, DELIBERATELY. `delivery.failed` is the retry
 * window expiring — the receiver was unreachable for days, which says nothing
 * about the address — and `delivery.message-rejected` is about the message. A
 * suppression is permanent and silent from the customer's side, so the bar for
 * writing one is evidence about the ADDRESS.
 *
 * ⚠ THERE IS NO COMPLAINT PATH HERE, AND THERE CANNOT BE. Feedback loops arrive
 * as ARF reports by mail, not as delivery outcomes; SES subscribes to them on
 * our behalf and our own MTA does not. A direct-routed message can be
 * complained about and we will not know.
 */
function suppressionsFor(
  stalwartType: string | undefined,
  code: number | null,
  recipients: string[],
): Suppression[] {
  if (stalwartType !== "delivery.rcpt-to-rejected") return []
  if (code === null || code < 500 || code >= 600) return []
  return recipients.map((address) => ({ address, reason: "hard_bounce" as const }))
}

/**
 * What the customer sees.
 *
 * ⚠ THE SHAPE IS THE SES PATH'S SHAPE, FIELD FOR FIELD, AND MATCHING IT IS THE
 * POINT. A customer's handler switches on `type` and reads `bounce.type`; if the
 * direct route spelled the same outcome differently, the route would be visible
 * in their integration — and they would have to write two branches for a choice
 * we made on their behalf.
 *
 * ⚠ `from` AND `subject` ARE NULL RATHER THAN INVENTED. Stalwart's events carry
 * the ENVELOPE sender, which is our VERP bounce address and not the customer's
 * `From:` header, and they carry no subject at all. Echoing the envelope into a
 * field a customer reads as the From would be worse than omitting it.
 */
function publicData(
  type: WebhookEventName,
  event: StalwartEvent,
  messageId: string,
  occurredAt: Date,
  code: number | null,
  recipients: string[],
): Record<string, unknown> {
  const data = event.data ?? {}
  const base: Record<string, unknown> = {
    email_id: messageId,
    from: null,
    to: recipients,
    subject: null,
    created_at: occurredAt.toISOString(),
  }

  switch (type) {
    case "email.bounced":
      return {
        ...base,
        bounce: {
          // ⚠ THE SAME THREE WORDS SES USES. A 5xx on the recipient is
          // `permanent`; an expired retry window is `transient`, because the
          // message never got a verdict; anything else is `undetermined`.
          type: bounceType(event.type, code),
          subtype: null,
          recipients,
          diagnostic: stringOf(data["details"]) ?? stringOf(data["reason"]) ?? null,
        },
      }
    case "email.delivery_delayed":
      return {
        ...base,
        delay: {
          type: null,
          recipients,
          next_retry: stringOf(data["nextRetry"]) ?? null,
        },
      }
    default:
      return base
  }
}

function bounceType(stalwartType: string | undefined, code: number | null): string {
  if (stalwartType === "delivery.failed") return "transient"
  if (code !== null && code >= 500 && code < 600) return "permanent"
  if (code !== null && code >= 400 && code < 500) return "transient"
  return "undetermined"
}

/**
 * ⚠ `to` IS A STRING ON SOME EVENTS AND A LIST ON OTHERS, AND BOTH REACH HERE.
 * An outcome for one recipient carries its own `to`; `delivery.message-rejected`
 * has none of its own and inherits the span's, which is every recipient in the
 * attempt. Reading one shape and not the other loses the recipients on exactly
 * the events where they are least obvious.
 */
function recipientsOf(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value]
  return list
    .map((entry) => (typeof entry === "string" ? entry.trim().toLowerCase() : null))
    .filter((entry): entry is string => Boolean(entry))
}

const firstRecipient = (value: unknown): string | null => recipientsOf(value)[0] ?? null

function numberOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

const stringOf = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string") return null
  const at = new Date(value)
  return Number.isNaN(at.getTime()) ? null : at
}
