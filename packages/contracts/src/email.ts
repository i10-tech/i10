import { z } from "zod"

/**
 * The wire contract for the send API.
 *
 * ⚠ THIS SHAPE IS A CONSTRAINT, NOT A DESIGN SPACE. The product's migration
 * pitch is one line - `resend/node` becomes `@i10/node` - and that promise is
 * only true if the transport is identical: `Authorization: Bearer`, the same
 * request and response bodies, the same error semantics. The key *format* is
 * ours (`i10_live_…`); the header is not.
 *
 * ⚠ UNVERIFIED AGAINST THE LIVE API. These fields are the ones the public
 * documentation makes certain. Before `@i10/node` is published claiming
 * drop-in compatibility, every field, every response body and every error code
 * must be diffed against real Resend traffic - a scaffold's best guess is not
 * a compatibility guarantee. Treat that diff as a release gate.
 */

/**
 * `Name <addr@example.com>` or a bare address.
 *
 * ⚠ NO LINE BREAKS AND NO CONTROL CHARACTERS (#189). An address is written
 * into `From`, `To`, `Cc` and `Reply-To` headers, and a CR or LF in a display
 * name is header injection: `Evil\r\nX-Anything: …<me@verified.test>` still
 * parses as an address on the verified domain, and would put a header of the
 * caller's choosing - or a blank line and a body - into the message.
 */
export const addressSchema = z
  .string()
  .min(3)
  .max(320)
  .refine(
    (s) => !hasControl(s),
    "An address may not contain line breaks or control characters.",
  )

/** True when the string has a C0 control character (CR and LF among them) or DEL. */
export function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x20 || c === 0x7f) return true
  }
  return false
}

/**
 * A lone surrogate: text that cannot be encoded as UTF-8 at all. JSON can
 * carry one (`"\ud800"`), and it would reach the recipient as a replacement
 * character wherever it happened to be (#189).
 */
const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
const wellFormed = (s: string) => !LONE_SURROGATE.test(s)
const NOT_UTF8 = "Must be valid Unicode text (it contains a lone surrogate)."

/** The largest `html` or `text`, in characters. Mail far past this is refused by receivers anyway. */
export const MAX_BODY_CHARS = 5 * 1024 * 1024

/**
 * At most this many attachments. SES refuses a message of more than 500 MIME
 * parts; the body takes up to three, so this keeps a send that SES would
 * refuse later, asynchronously, a 422 now.
 */
export const MAX_ATTACHMENTS = 490

/**
 * A header name as RFC 5322 defines one: printable ASCII, no colon, no space.
 *
 * ⚠ THE NAME IS WRITTEN RAW, before the colon (#189). A name carrying a line
 * break is header injection exactly as a value would be, and values are
 * flattened before they are written but names never were.
 */
export const headerNameSchema = z
  .string()
  .regex(
    /^[\x21-\x39\x3b-\x7e]{1,76}$/,
    "Header names are printable ASCII, without spaces or colons, at most 76 characters.",
  )

export const addressListSchema = z.union([
  addressSchema,
  z.array(addressSchema).min(1).max(50), // SES caps recipients per message at 50.
])

/**
 * How much attachment one message may carry, decoded.
 *
 * ⚠ A CAP EXISTS BECAUSE THE CONTENT IS STORED IN THE DATABASE AND THEN SENT
 * WHOLE. Every byte here is a byte in `core.message_bodies`, a byte through the
 * worker's memory, and a byte - inflated by a third once base64-encoded -
 * against SES's own message size limit. Ten megabytes is comfortably inside
 * that limit and comfortably outside what mail providers accept anyway; the
 * number matters less than there being one.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

/** Base64 expands by 4/3, so this is the decoded size of an encoded string. */
const decodedSize = (base64: string) => Math.floor((base64.length * 3) / 4)

export const attachmentSchema = z
  .object({
    /**
     * ⚠ NO CR, NO LF, NO QUOTE. This goes into a `Content-Disposition` header,
     * and a newline in it is header injection - a caller could otherwise append
     * headers, or an entire second MIME part, to their own message.
     */
    filename: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[^\r\n"]+$/, "`filename` may not contain quotes or newlines."),
    /** The file itself, base64-encoded. */
    content: z.base64().optional(),
    path: z.url().optional(),
    content_type: z.string().max(255).optional(),
    /**
     * Makes the file an INLINE image the HTML refers to as `cid:<content_id>`
     * (#168), Resend's name for the same field. The file is sent as a part of
     * `multipart/related` with this `Content-ID` and `Content-Disposition:
     * inline`, instead of as a download.
     *
     * ⚠ NO WHITESPACE, NO ANGLE BRACKETS, NO QUOTES. It goes into a
     * `Content-ID: <...>` header, so a newline is header injection and a `>`
     * would close the id early; we add the brackets, the caller does not.
     */
    content_id: z
      .string()
      .min(1)
      .max(255)
      .regex(
        /^[^\s<>"]+$/,
        "`content_id` may not contain whitespace, quotes or angle brackets.",
      )
      .optional(),
  })
  .refine((a) => a.content !== undefined, {
    // ⚠ A DELIBERATE GAP AGAINST RESEND, AND THE REASON IS NOT EFFORT. Fetching
    // a caller-supplied URL means the worker makes an outbound request to an
    // address the caller chooses - the shape of every SSRF, from a cloud
    // metadata endpoint to a service reachable only from inside the cluster.
    // Supporting it needs an allowlist, a resolver that refuses private ranges,
    // a size limit and a timeout; until those exist, an explicit error is the
    // honest answer and a silent fetch would be the dangerous one.
    message:
      "Attachments must be inline: supply base64 `content`. " +
      "Fetching `path` is not supported.",
    path: ["content"],
  })
  .refine((a) => decodedSize(a.content ?? "") <= MAX_ATTACHMENT_BYTES, {
    message: `An attachment may be at most ${MAX_ATTACHMENT_BYTES} bytes.`,
    path: ["content"],
  })

export const tagSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
    value: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
  })
  // ⚠ `i10_` IS OURS AND CANNOT BE CLAIMED. `i10_message_id` is the join key
  // between a delivery event and the message it belongs to; a customer tag that
  // could overwrite it would detach every bounce, complaint and delivery for
  // that send from the row that explains them - and suppression, which reads
  // those events, would stop working for exactly the sends that need it.
  .refine((t) => !/^i10_/i.test(t.name), {
    message: "Tag names beginning `i10_` are reserved.",
    path: ["name"],
  })

/** How far ahead a send may be scheduled. */
export const SCHEDULE_HORIZON_DAYS = 30
const SCHEDULE_HORIZON_MS = SCHEDULE_HORIZON_DAYS * 24 * 60 * 60 * 1000

/**
 * A send from a stored template: `{ id, variables }`, as in Resend, plus our
 * optional `version`.
 *
 * ⚠ `id` IS AN ID OR A NAME. A template's name is unique in its workspace and
 * is the alias a caller hard-codes; Resend accepts either in the same field.
 *
 * ⚠ `version` PINS; ITS ABSENCE FOLLOWS WHATEVER IS LIVE. Versions are
 * immutable, so a pinned send renders the same email for ever, while an
 * unpinned one changes when somebody promotes a new version in the console.
 */
export const templateRefSchema = z.object({
  id: z.string().min(1).max(200),
  version: z.number().int().positive().optional(),
  variables: z.record(z.string(), z.unknown()).optional(),
})

export const sendEmailSchema = z
  .object({
    /**
     * ⚠ OPTIONAL ONLY WITH A TEMPLATE THAT HAS ONE, exactly like `subject`:
     * a template may carry a default sender, and the request's wins (Resend's
     * template defaults). Without a template it is required, as it always was.
     */
    from: addressSchema.optional(),
    to: addressListSchema,
    /**
     * ⚠ OPTIONAL ONLY WITH A TEMPLATE THAT HAS ONE. Without a template it is
     * required, as it always was - see the refinement below. With one, the
     * request's subject wins over the template's, as in Resend.
     */
    subject: z.string().refine(wellFormed, NOT_UTF8).optional(),
    bcc: addressListSchema.optional(),
    cc: addressListSchema.optional(),
    reply_to: addressListSchema.optional(),
    html: z.string().max(MAX_BODY_CHARS).refine(wellFormed, NOT_UTF8).optional(),
    text: z.string().max(MAX_BODY_CHARS).refine(wellFormed, NOT_UTF8).optional(),
    /** Send a stored template instead of `html`/`text`. See `templateRefSchema`. */
    template: templateRefSchema.optional(),
    headers: z.record(headerNameSchema, z.string().max(998)).optional(),
    attachments: z.array(attachmentSchema).max(MAX_ATTACHMENTS).optional(),
    tags: z.array(tagSchema).optional(),
    /**
     * When to send it, as an ISO 8601 timestamp - `2026-09-03T09:00:00Z`.
     *
     * ⚠ ISO ONLY, WHICH IS A KNOWN GAP AGAINST RESEND. Resend also accepts
     * natural language ("in 1 min"), and a caller migrating from it will get a
     * 422 for those. Parsing English dates needs a parser and a timezone
     * policy, and guessing either is worse than an error that says exactly what
     * the field wants - but this belongs on the compatibility diff.
     *
     * A time in the past is not an error; it means now.
     */
    scheduled_at: z.iso.datetime({ offset: true }).optional(),
  })
  .refine(
    (v) =>
      (v.attachments ?? []).reduce(
        (total, a) => total + decodedSize(a.content ?? ""),
        0,
      ) <= MAX_ATTACHMENT_BYTES,
    {
      // Per attachment AND in total: ten files of nine megabytes each would
      // otherwise pass a per-file check and still be ninety megabytes.
      message: `Attachments may total at most ${MAX_ATTACHMENT_BYTES} bytes.`,
      path: ["attachments"],
    },
  )
  .refine(
    (v) =>
      v.scheduled_at === undefined ||
      new Date(v.scheduled_at).getTime() - Date.now() <= SCHEDULE_HORIZON_MS,
    {
      // ⚠ A HORIZON, BECAUSE A SCHEDULED MESSAGE HOLDS A ROW AND A DELAYED JOB
      // FOR ITS WHOLE WAIT. Accepting a send two years out means carrying that
      // pair - and the body - across every migration and retention drop in
      // between, and `core.messages` is partitioned by acceptance rather than
      // by due date, so the partition it lives in is dropped long before it is
      // due.
      message: `\`scheduled_at\` may be at most ${SCHEDULE_HORIZON_DAYS} days from now.`,
      path: ["scheduled_at"],
    },
  )
  // ⚠ A TEMPLATE REPLACES THE BODY; IT DOES NOT MERGE WITH ONE. Resend refuses
  // `html`/`text` beside `template`, and so do we: which one "wins" is a guess
  // somebody would find out about from a customer's inbox.
  .refine(
    (v) => v.template === undefined || (v.html === undefined && v.text === undefined),
    {
      message: "`template` cannot be combined with `html` or `text`.",
      path: ["template"],
    },
  )
  .refine(
    (v) => v.template !== undefined || v.html !== undefined || v.text !== undefined,
    {
      message: "Either `html`, `text` or `template` is required.",
      path: ["html"],
    },
  )
  .refine((v) => v.template !== undefined || v.subject !== undefined, {
    message: "`subject` is required.",
    path: ["subject"],
  })
  .refine((v) => v.template !== undefined || v.from !== undefined, {
    message: "`from` is required.",
    path: ["from"],
  })

export const sendEmailResponseSchema = z.object({
  id: z.uuid(),
})

/** `POST /emails/batch` - an array of sends, one response id per element. */
export const batchSendSchema = z.array(sendEmailSchema).min(1).max(100)

export const batchSendResponseSchema = z.object({
  data: z.array(sendEmailResponseSchema),
})

/**
 * `GET /emails/{id}` - what happened to one message.
 *
 * ⚠ THE ASYNCHRONOUS HALF OF A SYNCHRONOUS-LOOKING API. `POST /emails` returns
 * an id before anything has been sent, which is what keeps a password reset off
 * the mail server's latency - but it leaves the caller holding an identifier
 * and no way to ask about it. Without this route the only answer to "did it
 * arrive" is a webhook the caller may not have set up, and support has to read
 * the database.
 *
 * ⚠ `last_event` IS A STATE, NOT A LOG. One value, the furthest the message has
 * got, so a caller can branch on it - `delivered`, `bounced`, `queued`. The
 * full sequence is what webhooks are for; putting it here would make a status
 * check unbounded in size for a heavily retried message.
 */
export const emailEventName = z.enum([
  "queued",
  "scheduled",
  "sending",
  "sent",
  "delivered",
  "delivery_delayed",
  "opened",
  "clicked",
  "unsubscribed",
  "bounced",
  "complained",
  "failed",
  "canceled",
])

export const getEmailResponseSchema = z.object({
  object: z.literal("email"),
  id: z.uuid(),
  from: z.string(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  bcc: z.array(z.string()),
  reply_to: z.array(z.string()),
  subject: z.string(),
  html: z.string().nullable(),
  text: z.string().nullable(),
  created_at: z.string(),
  scheduled_at: z.string().nullable(),
  last_event: emailEventName,
})

/**
 * The events a customer's endpoint can subscribe to.
 *
 * ⚠ THESE STRINGS APPEAR IN CUSTOMER CODE AS LITERALS, so a rename breaks every
 * `if (event.type === …)` anyone has written - and breaks it silently, because
 * their handler simply stops matching. Add, never rename. They mirror
 * `core.webhook_event_type`; the two must be changed together.
 */
export const webhookEventName = z.enum([
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.bounced",
  "email.complained",
  "email.failed",
  /**
   * ⚠ ONLY FOR DOMAINS WITH TRACKING TURNED ON, and off is the default. SES
   * inserts a pixel for opens and rewrites every link for clicks, which is a
   * privacy decision the domain's owner makes - see `open_tracking` and
   * `click_tracking` on the domain.
   */
  "email.opened",
  "email.clicked",
  /**
   * The recipient unsubscribed through SES's own list management. i10 does not
   * use SES contact lists today, so this is published and carried rather than
   * dropped, but does not currently fire.
   */
  "email.unsubscribed",
])

/**
 * How webhooks to an endpoint are signed, both per Standard Webhooks:
 * `hmac_sha256` (`v1,`) with a shared `whsec_` secret, or `ed25519` (`v1a,`)
 * verified with a `whpk_` public key, so nothing the receiver stores can forge
 * a webhook.
 */
export const webhookSignatureScheme = z.enum(["hmac_sha256", "ed25519"])

/** `POST /webhook-endpoints` - where a customer wants their events delivered. */
export const createWebhookEndpointSchema = z.object({
  /** ⚠ https, public, and not an IP literal - see webhooks/endpoints.ts. */
  url: z.url(),
  /** At least one, because an endpoint subscribed to nothing is a silent bug. */
  events: z.array(webhookEventName).min(1),
  description: z.string().max(255).optional(),
  /** Defaults to `hmac_sha256`. */
  signature_scheme: webhookSignatureScheme.optional(),
  /**
   * The most deliveries a second this endpoint will take, 1 to 1000. Held
   * across all of i10's workers. Omit for no limit.
   */
  rate_limit: z.number().int().min(1).max(1000).optional(),
})

export const webhookEndpointSchema = z.object({
  object: z.literal("webhook_endpoint"),
  id: z.uuid(),
  url: z.url(),
  events: z.array(webhookEventName),
  description: z.string().nullable(),
  enabled: z.boolean(),
  /**
   * Why i10 switched the endpoint off, when it did: it answered 410 Gone, or
   * had no successful delivery for the plan's stretch (2 to 7 days).
   */
  disabled_reason: z.string().nullable(),
  created_at: z.string(),
  signature_scheme: webhookSignatureScheme,
  /** Deliveries a second, at most; null for no limit. */
  rate_limit: z.number().int().nullable(),
  /** The `whpk_` key to verify with, for `ed25519`; null for HMAC. Not a secret. */
  public_key: z.string().nullable(),
  /**
   * Keys a rotation replaced that still sign until `expires_at`, because the
   * customer chose a grace period. Never the key material itself.
   */
  previous_secrets: z.array(
    z.object({ signature_scheme: webhookSignatureScheme, expires_at: z.string() }),
  ),
})

/**
 * ⚠ THE SECRET IS RETURNED ONCE, ON CREATION AND ON ROTATION, AND NEVER AGAIN.
 * There is no "show me my signing secret" endpoint on purpose: such a call is a
 * far better target than the database it would read from, and every customer
 * who needs it has it at the moment they need it.
 *
 * `null` for `ed25519`: we keep the private key, and the customer verifies
 * with `public_key`, which is on every endpoint response.
 */
export const webhookEndpointWithSecretSchema = webhookEndpointSchema.extend({
  secret: z.string().nullable(),
})

/** The longest an old secret may keep signing after a rotation: 72 hours. */
export const MAX_PREVIOUS_SECRET_SECONDS = 72 * 60 * 60

/**
 * `POST /webhook-endpoints/{id}/rotate-secret`.
 *
 * ⚠ NO DEFAULT FOR THE SECRET BEING REPLACED. A stolen secret that keeps
 * verifying is not a risk i10 takes on silently, so the caller decides:
 * `revoke` stops it at once; `expire` keeps it signing for `expires_in`
 * seconds (60 to 259200, which is 72 hours) so receivers can deploy the new
 * one first.
 */
export const rotateWebhookSecretSchema = z
  .object({
    previous_secret: z.enum(["revoke", "expire"]),
    expires_in: z.number().int().min(60).max(MAX_PREVIOUS_SECRET_SECONDS).optional(),
    /** Switch schemes on rotation. Defaults to the endpoint's current one. */
    signature_scheme: webhookSignatureScheme.optional(),
  })
  .refine((b) => (b.previous_secret === "expire") === (b.expires_in !== undefined), {
    message:
      '`expires_in` is required with `previous_secret: "expire"` and not allowed with `"revoke"`.',
    path: ["expires_in"],
  })

export const webhookEndpointListSchema = z.object({
  data: z.array(webhookEndpointSchema),
})

export type EmailEventName = z.infer<typeof emailEventName>
export type GetEmailResponse = z.infer<typeof getEmailResponseSchema>
export type WebhookEventName = z.infer<typeof webhookEventName>
export type CreateWebhookEndpoint = z.infer<typeof createWebhookEndpointSchema>
export type WebhookEndpoint = z.infer<typeof webhookEndpointSchema>
export type WebhookSignatureScheme = z.infer<typeof webhookSignatureScheme>
export type RotateWebhookSecret = z.infer<typeof rotateWebhookSecretSchema>
export type Address = z.infer<typeof addressSchema>
export type Attachment = z.infer<typeof attachmentSchema>
export type Tag = z.infer<typeof tagSchema>
export type SendEmail = z.infer<typeof sendEmailSchema>
export type TemplateRef = z.infer<typeof templateRefSchema>
export type SendEmailResponse = z.infer<typeof sendEmailResponseSchema>
export type BatchSend = z.infer<typeof batchSendSchema>
export type BatchSendResponse = z.infer<typeof batchSendResponseSchema>
