import { z } from "zod"

/**
 * Error semantics are part of the compatibility surface. An SDK that maps a
 * 422 to a thrown exception and a 429 to a retry is reading these fields, so
 * changing one is a breaking change to every customer's error handling — not
 * a message tweak.
 */
export const errorNames = [
  "validation_error",
  "missing_required_field",
  "invalid_access",
  "not_found",
  "method_not_allowed",
  "rate_limit_exceeded",
  "daily_quota_exceeded",
  "invalid_from_address",
  "invalid_to_address",
  "domain_not_verified",
  "internal_server_error",
] as const

export const errorSchema = z.object({
  statusCode: z.number().int(),
  name: z.enum(errorNames),
  message: z.string(),
})

export type ErrorName = (typeof errorNames)[number]
export type ApiError = z.infer<typeof errorSchema>

/**
 * Quota is NOT rate limit, and they must not share a layer.
 *
 * `rate_limit_exceeded` answers "too fast" and is retryable with backoff.
 * `daily_quota_exceeded` answers "this customer has no sending budget left"
 * and is not retryable — it is a billing state, owned by Autumn, not by the
 * request path. Collapsing the two into one 429 makes it impossible to sell a
 * plan that differs only by volume.
 */
export const RETRYABLE_ERRORS: readonly ErrorName[] = [
  "rate_limit_exceeded",
  "internal_server_error",
]
