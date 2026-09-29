import { z } from "zod"

/**
 * Templates a workspace submits for review (#222), on the public API.
 *
 * ⚠ WHAT IS APPROVED IS THE FIXED PART. Mark every place a value goes with
 * `{{name}}`; a sent message gets credit only when it matches the rest byte
 * for byte, with each value within its limit, no markup in any value, and any
 * link in a value on the workspace's own verified domains. Approval stops the
 * template's repetition counting against the workspace; it never excuses
 * bounces or complaints, and it is withdrawn automatically when those run
 * high.
 */
export const trustedTemplateStatus = z.enum([
  "pending",
  "approved",
  "rejected",
  "revoked",
  "withdrawn",
])

export const trustedTemplateHoleSchema = z.object({
  name: z.string(),
  /** The longest value this placeholder may take, in characters. */
  max: z.number().int(),
})

export const trustedTemplateSchema = z.object({
  object: z.literal("trusted_template"),
  id: z.uuid(),
  name: z.string(),
  status: trustedTemplateStatus,
  html: z.string().nullable(),
  text: z.string().nullable(),
  holes: z.array(trustedTemplateHoleSchema),
  /** Messages that matched it and were credited. */
  matched: z.number().int(),
  submitted_at: z.string(),
  decided_at: z.string().nullable(),
  /** Our note on the decision, when there is one. */
  decision_reason: z.string().nullable(),
})

export const trustedTemplateListSchema = z.object({
  data: z.array(trustedTemplateSchema),
})

export const createTrustedTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    /** The HTML body exactly as you send it, with `{{name}}` where values go. */
    html: z.string().max(200_000).nullable().optional(),
    /** The plain-text body, the same way. */
    text: z.string().max(200_000).nullable().optional(),
    /** The longest value per placeholder; 100 characters when not given. */
    holes: z.record(z.string(), z.number().int().min(1).max(1_000)).optional(),
  })
  .refine((v) => Boolean(v.html) || Boolean(v.text), {
    message: "Give `html`, `text` or both.",
  })

export type TrustedTemplate = z.infer<typeof trustedTemplateSchema>
export type TrustedTemplateStatus = z.infer<typeof trustedTemplateStatus>
export type CreateTrustedTemplate = z.infer<typeof createTrustedTemplateSchema>
