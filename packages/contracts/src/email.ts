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

export const attachmentSchema = z.object({
  /** Base64 content, or omit and supply `path`. */
  content: z.string().optional(),
  filename: z.string(),
  path: z.url().optional(),
  content_type: z.string().optional(),
})

export const tagSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
  value: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
})

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
    scheduled_at: z.string().optional(),
  })
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
