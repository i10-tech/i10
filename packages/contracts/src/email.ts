import { z } from "zod"

/**
 * The wire contract for the send API.
 *
 * ⚠ THIS SHAPE IS A CONSTRAINT, NOT A DESIGN SPACE. The product's migration
 * pitch is one line — `resend/node` becomes `@i10/node` — and that promise is
 * only true if the transport is identical: `Authorization: Bearer`, the same
 * request and response bodies, the same error semantics. The key *format* is
 * ours (`i10_live_…`); the header is not.
 *
 * ⚠ UNVERIFIED AGAINST THE LIVE API. These fields are the ones the public
 * documentation makes certain. Before `@i10/node` is published claiming
 * drop-in compatibility, every field, every response body and every error code
 * must be diffed against real Resend traffic — a scaffold's best guess is not
 * a compatibility guarantee. Treat that diff as a release gate.
 */

/** `Name <addr@example.com>` or a bare address. */
export const addressSchema = z.string().min(3).max(320)

export const addressListSchema = z.union([
  addressSchema,
  z.array(addressSchema).min(1).max(50), // SES caps recipients per message at 50.
])

/**
 * How much attachment one message may carry, decoded.
 *
 * ⚠ A CAP EXISTS BECAUSE THE CONTENT IS STORED IN THE DATABASE AND THEN SENT
 * WHOLE. Every byte here is a byte in `core.message_bodies`, a byte through the
 * worker's memory, and a byte — inflated by a third once base64-encoded —
 * against SES's own message size limit. Ten megabytes is comfortably inside
 * that limit and comfortably outside what mail providers accept anyway; the
 * number matters less than there being one.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

/** Base64 expands by 4/3, so this is the decoded size of an encoded string. */
const decodedSize = (base64: string) => Math.floor((base64.length * 3) / 4)

export const attachmentSchema = z.object({
  /**
   * ⚠ NO CR, NO LF, NO QUOTE. This goes into a `Content-Disposition` header,
   * and a newline in it is header injection — a caller could otherwise append
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
})
  .refine((a) => a.content !== undefined, {
    // ⚠ A DELIBERATE GAP AGAINST RESEND, AND THE REASON IS NOT EFFORT. Fetching
    // a caller-supplied URL means the worker makes an outbound request to an
    // address the caller chooses — the shape of every SSRF, from a cloud
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

export const tagSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
  value: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
})
  // ⚠ `i10_` IS OURS AND CANNOT BE CLAIMED. `i10_message_id` is the join key
  // between a delivery event and the message it belongs to; a customer tag that
  // could overwrite it would detach every bounce, complaint and delivery for
  // that send from the row that explains them — and suppression, which reads
  // those events, would stop working for exactly the sends that need it.
  .refine((t) => !/^i10_/i.test(t.name), {
    message: "Tag names beginning `i10_` are reserved.",
    path: ["name"],
  })

/** How far ahead a send may be scheduled. */
export const SCHEDULE_HORIZON_DAYS = 30
const SCHEDULE_HORIZON_MS = SCHEDULE_HORIZON_DAYS * 24 * 60 * 60 * 1000

export const sendEmailSchema = z
  .object({
    from: addressSchema,
    to: addressListSchema,
    subject: z.string(),
    bcc: addressListSchema.optional(),
    cc: addressListSchema.optional(),
    reply_to: addressListSchema.optional(),
    html: z.string().optional(),
    text: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    attachments: z.array(attachmentSchema).optional(),
    tags: z.array(tagSchema).optional(),
    /**
     * When to send it, as an ISO 8601 timestamp — `2026-09-03T09:00:00Z`.
     *
     * ⚠ ISO ONLY, WHICH IS A KNOWN GAP AGAINST RESEND. Resend also accepts
     * natural language ("in 1 min"), and a caller migrating from it will get a
     * 422 for those. Parsing English dates needs a parser and a timezone
     * policy, and guessing either is worse than an error that says exactly what
     * the field wants — but this belongs on the compatibility diff.
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
      // pair — and the body — across every migration and retention drop in
      // between, and `core.messages` is partitioned by acceptance rather than
      // by due date, so the partition it lives in is dropped long before it is
      // due.
      message: `\`scheduled_at\` may be at most ${SCHEDULE_HORIZON_DAYS} days from now.`,
      path: ["scheduled_at"],
    },
  )
  .refine((v) => v.html !== undefined || v.text !== undefined, {
    message: "Either `html` or `text` is required.",
    path: ["html"],
  })

export const sendEmailResponseSchema = z.object({
  id: z.uuid(),
})

/** `POST /emails/batch` — an array of sends, one response id per element. */
export const batchSendSchema = z.array(sendEmailSchema).min(1).max(100)

export const batchSendResponseSchema = z.object({
  data: z.array(sendEmailResponseSchema),
})

export type Address = z.infer<typeof addressSchema>
export type Attachment = z.infer<typeof attachmentSchema>
export type Tag = z.infer<typeof tagSchema>
export type SendEmail = z.infer<typeof sendEmailSchema>
export type SendEmailResponse = z.infer<typeof sendEmailResponseSchema>
export type BatchSend = z.infer<typeof batchSendSchema>
export type BatchSendResponse = z.infer<typeof batchSendResponseSchema>
