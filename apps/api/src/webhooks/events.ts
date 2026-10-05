import type { WebhookEventName } from "@repo/contracts"

/**
 * Turning an SES notification into a customer-facing event.
 *
 * ⚠ EVERY CUSTOMER EVENT ORIGINATES HERE, INCLUDING `email.sent`. The send
 * worker emits nothing: SES's configuration set publishes `Send` the moment it
 * accepts a message, so one ingestion path produces every event, in one order,
 * from one clock. The alternative - `sent` from our worker and the rest from
 * SES - gives a customer two sources that can disagree, and a `sent` for a
 * message SES went on to reject.
 *
 * ⚠ AND THE JOIN KEY IS THE TAG, NOT SES'S MESSAGE ID. `mail.messageId` is
 * SES's own identifier and we only learn it when the send succeeds; an event
 * that arrives before that write lands would have nothing to match. The
 * `i10_message_id` tag is set on the request itself, so it is present on every
 * event including the ones for messages we never finished recording.
 */

/**
 * ⚠ ONE NAME FOR ONE SET. `webhookEventName` in @repo/contracts is what the
 * OpenAPI document publishes and what the SDKs type against, and `core.ts`
 * mirrors it as a Postgres enum. A third hand-written union here would be a
 * third thing to remember on the day an event is added - and the one that
 * fails silently, because a union that is merely out of date still compiles.
 */
export type WebhookEventType = WebhookEventName

/** An address SES told us to stop writing to, and why. */
export interface Suppression {
  address: string
  reason: "hard_bounce" | "complaint"
}

export interface NormalisedEvent {
  type: WebhookEventType
  /** i10's message id, from the `i10_message_id` tag. */
  messageId: string
  occurredAt: Date
  /**
   * ⚠ SNS's OWN MESSAGE ID, WHICH IS WHAT MAKES REDELIVERY FREE. SNS retries a
   * notification the same way we retry a webhook, and the retry is byte-identical
   * - including this. A unique index on it turns "SNS sent it twice" into a
   * no-op instead of two bounces, two suppressions and two customer webhooks.
   */
  sourceEventId: string
  /** Addresses to suppress. Empty for everything except hard bounces and complaints. */
  suppress: Suppression[]
  /** What the customer's endpoint receives, minus the envelope. */
  data: Record<string, unknown>
  /** The raw notification, kept for support questions we cannot predict. */
  raw: unknown
}

interface SesRecipient {
  emailAddress?: string
  /** The receiving server's reply, on a bounced recipient. */
  diagnosticCode?: string
}

interface SesNotification {
  eventType?: string
  mail?: {
    messageId?: string
    timestamp?: string
    source?: string
    destination?: string[]
    tags?: Record<string, string[]>
    commonHeaders?: { subject?: string }
  }
  bounce?: {
    bounceType?: string
    bounceSubType?: string
    bouncedRecipients?: SesRecipient[]
    timestamp?: string
    diagnosticCode?: string
  }
  complaint?: {
    complainedRecipients?: SesRecipient[]
    complaintFeedbackType?: string
    timestamp?: string
  }
  delivery?: { recipients?: string[]; timestamp?: string; smtpResponse?: string }
  deliveryDelay?: {
    delayType?: string
    delayedRecipients?: SesRecipient[]
    timestamp?: string
  }
  reject?: { reason?: string }
  send?: Record<string, unknown>
  open?: { timestamp?: string; userAgent?: string; ipAddress?: string }
  click?: {
    timestamp?: string
    link?: string
    linkTags?: Record<string, string[]>
    userAgent?: string
    ipAddress?: string
  }
  subscription?: {
    contactList?: string
    timestamp?: string
    source?: string
    newTopicPreferences?: unknown
    oldTopicPreferences?: unknown
  }
  failure?: { errorMessage?: string; templateName?: string }
}

/**
 * ⚠ EVERY EVENT TYPE SES PUBLISHES IS CARRIED (#154), and an unrecognised one is
 * still ignored rather than an error: a type SES adds tomorrow would otherwise
 * make this endpoint 500 on every notification, and SNS would retry each one
 * for hours.
 *
 * ⚠ `Open` AND `Click` ONLY ARRIVE FOR DOMAINS THAT OPTED IN. Tracking is a
 * privacy decision, and it is made per domain by its owner - the worker picks a
 * configuration set that publishes these only when the domain asked for them.
 * Nothing here decides it.
 */
const TYPES: Record<string, WebhookEventType> = {
  Send: "email.sent",
  Delivery: "email.delivered",
  Bounce: "email.bounced",
  Complaint: "email.complained",
  DeliveryDelay: "email.delivery_delayed",
  Reject: "email.failed",
  // ⚠ SES SPELLS THIS WITH A SPACE IN THE NOTIFICATION BODY. `RENDERING_FAILURE`
  // is the configuration-set API's spelling and never appears in a payload;
  // both are here because getting it wrong is silent - a template that failed
  // to render would show as `sent` forever.
  "Rendering Failure": "email.failed",
  RENDERING_FAILURE: "email.failed",
  Open: "email.opened",
  Click: "email.clicked",
  Subscription: "email.unsubscribed",
}

export function interpretSesEvent(
  raw: unknown,
  sourceEventId: string,
  /**
   * ⚠ THE DEDUPE KEY'S LAST RESORT, AND IT MUST BE STABLE ACROSS REDELIVERIES.
   * `occurred_at` is half of the unique index that makes an SNS retry a no-op,
   * so falling back to `new Date()` would let a notification with no usable
   * timestamp be recorded twice - two delivery rows and two customer webhooks
   * for one real event. SNS's own `Timestamp` is always present and identical
   * on every redelivery, which is exactly what this needs to be.
   */
  fallbackAt: Date = new Date(),
): NormalisedEvent | null {
  const event = raw as SesNotification
  const type = event.eventType ? TYPES[event.eventType] : undefined
  if (!type) return null

  // ⚠ SES RENDERS TAG VALUES AS ARRAYS, ALWAYS, EVEN FOR ONE VALUE. Reading it
  // as a string yields undefined and every event silently fails to match a
  // message.
  const messageId = event.mail?.tags?.["i10_message_id"]?.[0]
  if (!messageId) return null

  const occurredAt = firstDate(
    [
      event.bounce?.timestamp,
      event.complaint?.timestamp,
      event.delivery?.timestamp,
      event.deliveryDelay?.timestamp,
      event.open?.timestamp,
      event.click?.timestamp,
      event.subscription?.timestamp,
      event.mail?.timestamp,
    ],
    fallbackAt,
  )

  return {
    type,
    messageId,
    occurredAt,
    sourceEventId,
    suppress: suppressionsFrom(event),
    data: publicData(type, event, messageId, occurredAt),
    raw,
  }
}

/**
 * ⚠ A TRANSIENT BOUNCE IS NOT A SUPPRESSION, AND CONFUSING THE TWO LOSES REAL
 * MAIL. A full mailbox, a greylisting, a receiver having a bad afternoon - all
 * arrive as `Bounce` and all recover on their own. Suppressing on those would
 * permanently stop mail to a customer who did nothing wrong, and the customer
 * would never find out why. Only `Permanent` means the address does not exist.
 *
 * A complaint is different: the recipient pressed "this is spam", and sending
 * again is what costs the shared SES reputation every tenant depends on.
 */
function suppressionsFrom(event: SesNotification): Suppression[] {
  if (event.bounce?.bounceType === "Permanent") {
    return addressesOf(event.bounce.bouncedRecipients).map((address) => ({
      address,
      reason: "hard_bounce" as const,
    }))
  }
  if (event.complaint) {
    return addressesOf(event.complaint.complainedRecipients).map((address) => ({
      address,
      reason: "complaint" as const,
    }))
  }
  return []
}

const addressesOf = (recipients: SesRecipient[] | undefined): string[] =>
  (recipients ?? [])
    .map((r) => r.emailAddress?.trim().toLowerCase())
    .filter((a): a is string => Boolean(a))

/**
 * What the customer sees.
 *
 * ⚠ NOT THE RAW SES NOTIFICATION, AND THE REASON IS THAT WE WOULD NEVER BE ABLE
 * TO TAKE IT BACK. Forwarding SES's shape verbatim makes AWS's schema our
 * public API - every field name, every quirk, and the fact that we use SES at
 * all - so changing relay, or SES changing a field, becomes a breaking change
 * for every customer. A small deliberate shape is one we own.
 */
/**
 * The tags the customer put on the send, as `{ name: value }`.
 *
 * ⚠ THEIRS ONLY. SES adds its own (`ses:*`: the source IP, the configuration
 * set, the caller's identity) and we add `i10_message_id`; none of those are
 * the customer's to see, and the source IP and caller identity are ours to
 * keep. The contract already refuses an `i10_` prefix on the way in.
 */
export function customerTags(
  raw: Record<string, string[] | undefined> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, values] of Object.entries(raw ?? {})) {
    if (name.startsWith("ses:") || name.startsWith("i10_")) continue
    const value = values?.[0]
    if (typeof value === "string") out[name] = value
  }
  return out
}

/** The domain an address is at, lowercased, from `a@b.c` or `Name <a@b.c>`. */
export function domainOf(address: unknown): string | null {
  if (typeof address !== "string") return null
  const m = address.match(/@([^\s>]+)>?\s*$/)
  return m ? m[1]!.toLowerCase() : null
}

function publicData(
  type: WebhookEventType,
  event: SesNotification,
  messageId: string,
  occurredAt: Date,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    email_id: messageId,
    from: event.mail?.source ?? null,
    to: event.mail?.destination ?? [],
    subject: event.mail?.commonHeaders?.subject ?? null,
    created_at: occurredAt.toISOString(),
    tags: customerTags(event.mail?.tags),
  }

  switch (type) {
    case "email.bounced":
      return {
        ...base,
        bounce: {
          // `Permanent` / `Transient` / `Undetermined`, lowercased so the
          // values read like the rest of our API rather than like AWS's.
          type: (event.bounce?.bounceType ?? "undetermined").toLowerCase(),
          subtype: (event.bounce?.bounceSubType ?? "").toLowerCase() || null,
          recipients: addressesOf(event.bounce?.bouncedRecipients),
          // ⚠ PRESENT ON EVERY ROUTE (#283): Stalwart reports its own words,
          // and so do we, from the first recipient that has any.
          diagnostic:
            event.bounce?.bouncedRecipients?.find((r) => r.diagnosticCode)
              ?.diagnosticCode ?? null,
        },
      }
    case "email.complained":
      return {
        ...base,
        complaint: {
          type: event.complaint?.complaintFeedbackType ?? null,
          recipients: addressesOf(event.complaint?.complainedRecipients),
        },
      }
    case "email.delivery_delayed":
      return {
        ...base,
        delay: {
          type: event.deliveryDelay?.delayType ?? null,
          recipients: addressesOf(event.deliveryDelay?.delayedRecipients),
          // SES does not say when it retries; Stalwart does. Null, not missing (#283).
          next_retry: null,
        },
      }
    case "email.failed":
      return {
        ...base,
        reason: event.reject?.reason ?? event.failure?.errorMessage ?? "rejected",
      }
    /*
     * ⚠ NO IP ADDRESS. SES reports the opener's and clicker's IP, and
     * forwarding it would hand every customer a location-grade identifier for
     * each of their recipients by default. The user agent is enough to tell a
     * person from a mail client's image proxy; the raw notification keeps the
     * rest for support.
     */
    case "email.opened":
      return { ...base, open: { user_agent: event.open?.userAgent ?? null } }
    case "email.clicked":
      return {
        ...base,
        click: {
          link: event.click?.link ?? null,
          user_agent: event.click?.userAgent ?? null,
        },
      }
    case "email.unsubscribed":
      return {
        ...base,
        unsubscribe: {
          list: event.subscription?.contactList ?? null,
          source: event.subscription?.source ?? null,
        },
      }
    default:
      return base
  }
}

function firstDate(candidates: (string | undefined)[], fallback: Date): Date {
  for (const candidate of candidates) {
    if (!candidate) continue
    const at = new Date(candidate)
    if (!Number.isNaN(at.getTime())) return at
  }
  // ⚠ THE CALLER'S FALLBACK, RATHER THAN A THROW OR `new Date()`. A missing or
  // unparseable timestamp is a malformed notification, and dropping a real
  // bounce over a bad date field costs more than a little imprecision - but the
  // value has to be the same on every redelivery or the dedupe stops working.
  return fallback
}

/** One row waiting to be delivered to one endpoint. */
export interface DeliveryRef {
  id: string
  endpointId: string
  tenantId: string
  /** The event's own clock, which orders the endpoint's queue. */
  occurredAt: Date
}

export interface Logger {
  info: (o: object, m: string) => void
  warn: (o: object, m: string) => void
  error: (o: object, m: string) => void
}

/**
 * The persistence the ingestion path needs, injected so it can be tested.
 */
export interface EventOps {
  /**
   * Finds who owns the message, or null if we have never heard of it.
   *
   * ⚠ CROSS-TENANT BY NECESSITY, AND THEREFORE A `SECURITY DEFINER` FUNCTION
   * RATHER THAN A QUERY. An SES notification carries a message id and nothing
   * else; the tenant has to be known before `app.tenant_id` can be set, and
   * every policy in `core` needs that setting to answer at all.
   */
  ownerOf: (messageId: string) => Promise<{ tenantId: string; createdAt: Date } | null>

  /**
   * Writes the event, any suppressions, and one delivery row per subscribed
   * endpoint - in ONE transaction, so a crash leaves either all of it or none.
   *
   * Returns `duplicate` when SNS has already delivered this notification, in
   * which case nothing is written and nothing is queued.
   */
  record: (input: {
    tenantId: string
    messageCreatedAt: Date
    event: NormalisedEvent
  }) => Promise<
    { status: "recorded"; deliveries: DeliveryRef[] } | { status: "duplicate" }
  >

  /** Pushes the deliveries. Called only after the transaction commits. */
  enqueue: (deliveries: readonly DeliveryRef[]) => Promise<void>

  /**
   * Who a message retention already deleted belonged to, from its tombstone
   * (`core.expired_messages`), and the suppressions alone, for that tenant.
   *
   * ⚠ OPTIONAL SO A TEST DOUBLE CAN LEAVE IT OUT, NEVER IN PRODUCTION. Without
   * it a complaint that arrives after a three-day plan expired its message
   * suppresses nothing, and the workspace keeps mailing the person who
   * complained.
   */
  expiredOwnerOf?: (messageId: string) => Promise<string | null>
  suppressOnly?: (input: { tenantId: string; event: NormalisedEvent }) => Promise<void>
}

export type IngestOutcome =
  | { status: "recorded"; queued: number }
  | { status: "duplicate" }
  /** The tag named a message we have no row for. */
  | { status: "unknown_message" }
  /** Its message expired; only its suppressions were written. */
  | { status: "suppressed_expired" }
  /** A type we do not carry - open, click, or something new. */
  | { status: "ignored" }

/**
 * Ingests one SES notification.
 *
 * ⚠ THE ORDER IS THE SAME AS THE SEND PATH'S, FOR THE SAME REASON. Commit the
 * rows, then enqueue; never the other way round. A job whose delivery row is
 * not committed finds nothing and is dropped, and the customer's webhook is
 * lost with no error anywhere. A committed row that no job points at is late,
 * and it is visible in the table.
 */
export async function ingestSesEvent(
  raw: unknown,
  sourceEventId: string,
  deps: EventOps & { log: Logger },
  /** SNS's own `Timestamp`: stable across redeliveries, always present. */
  fallbackAt?: Date,
): Promise<IngestOutcome> {
  const event = interpretSesEvent(raw, sourceEventId, fallbackAt)
  if (!event) return { status: "ignored" }
  return ingestEvent(event, deps)
}

/**
 * Writing an already-interpreted event.
 *
 * ⚠ ONE PERSISTENCE PATH FOR EVERY ROUTE, WHICH IS THE POINT OF SPLITTING IT OUT
 * OF `ingestSesEvent`. The direct route's outcomes arrive from Stalwart in a
 * completely different shape and reach exactly this function - so the dedupe,
 * the suppression write, the endpoint fan-out and the ordering guarantees are
 * the same code, not two copies that agree today. A customer must not be able to
 * tell from a webhook which MTA carried their message, and the surest way to
 * guarantee that is for there to be only one piece of code that writes one.
 */
export async function ingestEvent(
  event: NormalisedEvent,
  deps: EventOps & { log: Logger },
): Promise<IngestOutcome> {
  const owner = await deps.ownerOf(event.messageId)
  if (!owner && event.suppress.length > 0 && deps.expiredOwnerOf && deps.suppressOnly) {
    // ⚠ RETENTION DELETED THE MESSAGE, NOT THE OBLIGATION. The event row and
    // the customer's webhook go with the message - there is nothing left to
    // attach them to - but a bounce or a complaint still stops the address.
    const tenantId = await deps.expiredOwnerOf(event.messageId)
    if (tenantId) {
      await deps.suppressOnly({ tenantId, event })
      return { status: "suppressed_expired" }
    }
  }
  if (!owner) {
    // ⚠ NOT AN ERROR, AND NOT A RETRY. The likeliest cause is retention: the
    // partition holding a months-old message was dropped and a very late event
    // arrived for it. Answering non-2xx would make the sender retry for hours
    // over a message that no longer exists - SNS for hours, Stalwart until its
    // `discardAfter` elapses.
    //
    // ⚠ AND ON THE DIRECT ROUTE IT IS ALSO THE ORDINARY CASE FOR MAIL THAT IS
    // NOT OURS. Stalwart carries human mailbox mail through the same queue; a
    // VERP envelope is what marks a message as transactional, so anything
    // without one is filtered before it reaches here.
    deps.log.warn(
      { messageId: event.messageId, type: event.type },
      "event for an unknown message",
    )
    return { status: "unknown_message" }
  }

  const written = await deps.record({
    tenantId: owner.tenantId,
    messageCreatedAt: owner.createdAt,
    event,
  })

  if (written.status === "duplicate") return { status: "duplicate" }

  if (written.deliveries.length > 0) {
    try {
      await deps.enqueue(written.deliveries)
    } catch (err) {
      // The rows are committed and `status = 'pending'` is a queryable backlog.
      // Reporting a failure would make SNS redeliver, and the unique index
      // would then discard the event - losing the webhook to fix the queue.
      deps.log.error(
        { err, tenantId: owner.tenantId, count: written.deliveries.length },
        "webhook enqueue failed after commit - deliveries left pending",
      )
    }
  }

  return { status: "recorded", queued: written.deliveries.length }
}

/**
 * The envelope a customer's endpoint receives.
 *
 * ⚠ `id` IS THE DELIVERY ID AND IT IS STABLE ACROSS RETRIES, WHICH IS WHAT
 * MAKES THE RECEIVER ABLE TO BE IDEMPOTENT. We deliver at least once - a
 * timeout after their handler committed looks exactly like a failure - so the
 * only way a customer can avoid double-processing is a key they can store. A
 * fresh id per attempt would take that away.
 */
export interface WebhookPayload {
  id: string
  type: WebhookEventType
  created_at: string
  /**
   * This event's place in its endpoint's stream, from 1. Events arrive in
   * this order while the endpoint is healthy; one that failed for longer than
   * the hold is retried aside, so a receiver that sees a gap knows the missing
   * number is still coming and can reorder by it (decision 1).
   */
  sequence?: number
  data: Record<string, unknown>
}

export const envelope = (
  deliveryId: string,
  event: {
    type: WebhookEventType
    occurredAt: Date
    data: Record<string, unknown>
    sequence?: number | null
  },
): WebhookPayload => ({
  id: deliveryId,
  type: event.type,
  created_at: event.occurredAt.toISOString(),
  ...(event.sequence != null ? { sequence: event.sequence } : {}),
  data: event.data,
})
