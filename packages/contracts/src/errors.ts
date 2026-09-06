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
  // ⚠ ADDITIVE, AND THE ONLY HONEST ANSWER FOR A REUSED Idempotency-Key. The
  // same key with a DIFFERENT body cannot be a replay (the caller would get an
  // id for an email they did not send) and cannot be a second send (the key
  // says they did not mean to). It is not a validation error either — the body
  // is fine, the key is ambiguous — so it needs a name of its own.
  //
  // Adding a name is safe in a way that changing one is not: an SDK switching
  // on these already needs a default branch.
  "idempotency_conflict",
  /**
   * ⚠ 409, AND IT DELIBERATELY DOES NOT SAY WHOSE. `core.domains.name` is
   * unique across every tenant — two customers cannot both own example.com,
   * because a second claim on a verified domain could send as it and receive
   * its mail. So this answer is returned whether the domain is the caller's own
   * duplicate or somebody else's, and the message must never distinguish them:
   * "another customer has example.com" is a way to enumerate who our customers
   * are.
   */
  "domain_already_exists",
  /**
   * ⚠ NOT `daily_quota_exceeded`, AND NOT A 429. That one is volume — a
   * customer who waits gets more. This is a plan limit on a resource that is
   * held rather than consumed: a fourth domain does not become available by
   * waiting, and an SDK that backs off on it retries forever. The fix is an
   * upgrade or a deletion, which is a 403.
   */
  "plan_limit_exceeded",
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
