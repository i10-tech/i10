import { z } from "zod"
import { webhookEventName } from "./email.js"

/**
 * The event catalog (#283): what every webhook's `data` contains, exactly.
 *
 * ⚠ STRICT, IN BOTH DIRECTIONS. Every schema here refuses fields it does not
 * name, and the API's contract tests run every payload our interpreters emit
 * (SES's and Stalwart's) through them. A field added in code but not here
 * fails a test; a field documented here but no longer sent fails one too.
 * Svix stores event schemas and never checks a payload against them.
 *
 * ⚠ ONE SHAPE WHICHEVER MAIL SERVER CARRIED THE MESSAGE. A field one route
 * cannot know is present and `null`, never missing - a customer must not be
 * able to tell from a webhook whether SES or Stalwart sent their mail.
 *
 * ⚠ VERSIONED. A breaking change to an event ships as a new version beside the
 * old one, never in place; `version` says which one a schema describes.
 */

const base = z
  .object({
    /** The email this is about: the id the send API returned. */
    email_id: z.string(),
    /** The From address as sent, `Name <address>` or bare. */
    from: z.string().nullable(),
    to: z.array(z.string()),
    subject: z.string().nullable(),
    /** When the event happened (also the envelope's `created_at`). */
    created_at: z.string(),
    /** The tags you put on the send. Never i10's or the mail server's own. */
    tags: z.record(z.string(), z.string()),
    /** Present, and true, only on test events. */
    test: z.literal(true).optional(),
  })
  .strict()

const bounce = z
  .object({
    /** `permanent`: the address does not exist and is now suppressed. */
    type: z.enum(["permanent", "transient", "undetermined"]),
    subtype: z.string().nullable(),
    recipients: z.array(z.string()),
    /** The receiving server's own words, when it gave any. */
    diagnostic: z.string().nullable(),
  })
  .strict()

const recipientsOnly = (fields: Record<string, z.ZodType>) =>
  z.object({ recipients: z.array(z.string()), ...fields }).strict()

/**
 * About one of your own endpoints (#284), not about an email.
 *
 * ⚠ NO EMAIL FIELDS. These are not mail events, and pretending otherwise with
 * nulls would make every receiver branch on which kind it got anyway.
 */
const endpointEvent = z
  .object({
    endpoint_id: z.string(),
    /** The endpoint's URL when it changed. */
    url: z.string(),
    /** The last error, or why it was switched off; null for a recovery. */
    reason: z.string().nullable(),
    /** When its run of failures began; null for a recovery. */
    failing_since: z.string().nullable(),
    /** When the change happened (also the envelope's `created_at`). */
    created_at: z.string(),
    /** Present, and true, only on test events. */
    test: z.literal(true).optional(),
  })
  .strict()

export const webhookEventData = {
  "email.sent": base,
  "email.delivered": base,
  "email.delivery_delayed": base.extend({
    delay: recipientsOnly({
      type: z.string().nullable(),
      /** When the mail server will try again, when it says. */
      next_retry: z.string().nullable(),
    }),
  }),
  "email.bounced": base.extend({ bounce }),
  "email.complained": base.extend({
    complaint: recipientsOnly({ type: z.string().nullable() }),
  }),
  "email.failed": base.extend({
    /** Why it was refused before it left. */
    reason: z.string(),
  }),
  "email.opened": base.extend({
    open: z.object({ user_agent: z.string().nullable() }).strict(),
  }),
  "email.clicked": base.extend({
    click: z
      .object({ link: z.string().nullable(), user_agent: z.string().nullable() })
      .strict(),
  }),
  "email.unsubscribed": base.extend({
    unsubscribe: z
      .object({ list: z.string().nullable(), source: z.string().nullable() })
      .strict(),
  }),
  "webhook_endpoint.failing": endpointEvent,
  "webhook_endpoint.disabled": endpointEvent,
  "webhook_endpoint.recovered": endpointEvent,
} as const satisfies Record<z.infer<typeof webhookEventName>, z.ZodType>

export interface WebhookEventCatalogEntry {
  type: z.infer<typeof webhookEventName>
  version: number
  description: string
}

/** Every event, its version and what it means. */
export const WEBHOOK_EVENT_CATALOG: readonly WebhookEventCatalogEntry[] = [
  {
    type: "email.sent",
    version: 1,
    description: "The mail server accepted the email for delivery.",
  },
  {
    type: "email.delivered",
    version: 1,
    description: "The recipient's server accepted it.",
  },
  {
    type: "email.delivery_delayed",
    version: 1,
    description:
      "Delivery is being retried; the recipient's server deferred it for now.",
  },
  {
    type: "email.bounced",
    version: 1,
    description:
      "The recipient's server refused it. A permanent bounce suppresses the address.",
  },
  {
    type: "email.complained",
    version: 1,
    description: "The recipient marked it as spam. The address is suppressed.",
  },
  {
    type: "email.failed",
    version: 1,
    description: "It was refused before it left, and was not sent.",
  },
  {
    type: "email.opened",
    version: 1,
    description: "The recipient opened it (tracking on).",
  },
  {
    type: "email.clicked",
    version: 1,
    description: "The recipient clicked a link in it (tracking on).",
  },
  {
    type: "email.unsubscribed",
    version: 1,
    description: "The recipient unsubscribed.",
  },
  {
    type: "webhook_endpoint.failing",
    version: 1,
    description:
      "One of your endpoints has had no successful delivery for 15 minutes. Retries continue.",
  },
  {
    type: "webhook_endpoint.disabled",
    version: 1,
    description:
      "i10 switched one of your endpoints off: it answered 410 Gone, or nothing succeeded for your plan's stretch.",
  },
  {
    type: "webhook_endpoint.recovered",
    version: 1,
    description:
      "An endpoint that was failing or disabled delivered successfully again.",
  },
]

/**
 * The body every webhook is POSTed with: the envelope around one event's
 * `data`.
 */
export const webhookPayloadSchema = <T extends z.infer<typeof webhookEventName>>(
  type: T,
) =>
  z
    .object({
      /** The delivery id, also `webhook-id`. Stable across retries: dedupe on it. */
      id: z.uuid(),
      type: z.literal(type),
      created_at: z.string(),
      /** The event's place in this endpoint's stream; absent on test events. */
      sequence: z.number().int().positive().optional(),
      data: webhookEventData[type],
    })
    .strict()

/** The catalog as `GET /webhook-event-types` returns it. */
export const webhookEventTypeSchema = z.object({
  object: z.literal("webhook_event_type"),
  type: webhookEventName,
  version: z.number().int(),
  description: z.string(),
  /** JSON Schema for the event's `data`. */
  schema: z.record(z.string(), z.unknown()),
  /** A realistic `data`, as a test event sends it. */
  example: z.record(z.string(), z.unknown()),
})

export const webhookEventTypeListSchema = z.object({
  data: z.array(webhookEventTypeSchema),
})
