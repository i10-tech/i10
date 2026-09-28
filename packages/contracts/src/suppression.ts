import { z } from "zod"

/**
 * A workspace's suppression list, on the public API (#159).
 *
 * ⚠ THE SAME SHAPE THE CONSOLE READS. Both are backed by one store, and a list
 * that looked different depending on where somebody asked would invite the
 * question of which one is true.
 */
export const suppressionReason = z.enum([
  "hard_bounce",
  "complaint",
  "manual",
  "unsubscribe",
])

export const suppressionSchema = z.object({
  object: z.literal("suppression"),
  /** Always lowercase: suppression matching ignores case. */
  address: z.string(),
  reason: suppressionReason,
  /** The message whose bounce or complaint caused it, when there was one. */
  message_id: z.uuid().nullable(),
  created_at: z.string(),
})

export const suppressionListSchema = z.object({
  data: z.array(suppressionSchema),
  /** Pass as `cursor` for the next page; null on the last one. */
  next_cursor: z.string().nullable(),
})

/**
 * ⚠ AN `@`, NOT A FULL ADDRESS GRAMMAR - THE SAME TEST THE CONSOLE APPLIES.
 * Suppressing is the safe direction: refusing to block an odd but real address
 * because a validator disliked it would keep mail going where the customer said
 * it must not.
 */
export const createSuppressionSchema = z.object({
  address: z
    .string()
    .trim()
    .max(320)
    .regex(/.@./, "`address` must be an email address."),
})

export type Suppression = z.infer<typeof suppressionSchema>
export type SuppressionReason = z.infer<typeof suppressionReason>
