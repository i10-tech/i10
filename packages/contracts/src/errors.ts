import { z } from "zod"

/**
 * Error semantics are part of the compatibility surface. An SDK that maps a
 * 422 to a thrown exception and a 429 to a retry is reading these fields, so
 * changing one is a breaking change to every customer's error handling - not
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
  /**
   * ⚠ ADDITIVE (#165). A free workspace's monthly ceiling - its sending tier -
   * is spent. A 429 like `daily_quota_exceeded` and just as un-retryable, but
   * named apart because the remedy differs: waiting until tomorrow does not
   * help, upgrading or waiting for the month does.
   */
  "monthly_quota_exceeded",
  "invalid_from_address",
  "invalid_to_address",
  "domain_not_verified",
  // ⚠ ADDITIVE, AND THE ONLY HONEST ANSWER FOR A REUSED Idempotency-Key. The
  // same key with a DIFFERENT body cannot be a replay (the caller would get an
  // id for an email they did not send) and cannot be a second send (the key
  // says they did not mean to). It is not a validation error either - the body
  // is fine, the key is ambiguous - so it needs a name of its own.
  //
  // Adding a name is safe in a way that changing one is not: an SDK switching
  // on these already needs a default branch.
  "idempotency_conflict",
  /**
   * ⚠ 409, AND SINCE MIGRATION 0039 IT MEANS *THE CALLER'S OWN* DUPLICATE.
   * `core.domains.name` used to be unique across every tenant, and this answer
   * covered both cases deliberately so that it could not be used to enumerate
   * customers. That constraint turned out to be a denial-of-service: the first
   * account to type `spotify.com` held it for ever without publishing a single
   * record, and the real owner had no route past this error. Exclusivity now
   * follows proof of ownership, so a name nobody has verified is simply
   * available and this error no longer fires for it.
   */
  "domain_already_exists",
  /**
   * Another workspace verified the name in the same moment as the caller.
   *
   * ⚠ ONLY A RACE NOW. It used to mean "somebody else holds this name
   * verified, talk to us if it is yours" - but proving a name now takes it from
   * whoever holds it, so the only way to meet this is two proofs landing at
   * once. Verifying again settles it.
   *
   * ⚠ STILL SEPARATE FROM `domain_already_exists`, BECAUSE THE REMEDIES
   * DIFFER. That one means "look in your own domain list"; this one means
   * "press verify again".
   */
  "domain_already_claimed",
  /**
   * ⚠ NOT `daily_quota_exceeded`, AND NOT A 429. That one is volume - a
   * customer who waits gets more. This is a plan limit on a resource that is
   * held rather than consumed: a fourth domain does not become available by
   * waiting, and an SDK that backs off on it retries forever. The fix is an
   * upgrade or a deletion, which is a 403.
   */
  "plan_limit_exceeded",
  /**
   * ⚠ A PRECONDITION THE CALLER CAN FIX, WHICH IS WHY IT IS NOT
   * `invalid_access`. The account is authenticated and permitted; it simply has
   * no password, and a mailbox is unusable without one - an IMAP login is an
   * LDAP bind that authd delegates to Clerk, so a user who signed up with
   * Google or an email link has no credential for the mail server to check.
   * The client's correct response is to send the person to set one and retry
   * the identical request, which is a conflict with current state rather than a
   * permission they lack.
   */
  "password_required",
  /**
   * ⚠ SAYS "TAKEN", NEVER BY WHOM - the same rule as `domain_already_exists`.
   * It covers both the caller already having a mailbox and the address
   * belonging to somebody else, because distinguishing them would turn this
   * endpoint into a way to test which addresses exist on a domain.
   */
  "mailbox_already_exists",
  /**
   * The key is real and was refused on what it asked to do.
   *
   * ⚠ RESEND'S OWN NAME, WHICH IS WHY IT IS NOT `forbidden`. A customer
   * pointing an SDK at us is switching on these strings, and `restricted_api_key`
   * is the one already in their error handling - see the note at the top of
   * this file about the compatibility surface.
   *
   * ⚠ AND IT IS A 403, NOT A 401, WHICH IS THE DISTINCTION THAT MATTERS MORE
   * THAN THE NAME. 401 tells somebody their key is wrong, and their next move
   * is to rotate a credential that was fine. This key authenticated; it is
   * scoped to other domains than the `from` address it was used with, and the
   * fix is a different address or a wider scope.
   */
  "restricted_api_key",
  /**
   * The request is allowed and well formed, and does something that needs a
   * second, explicit yes - repeated with the confirmation the message names.
   *
   * ⚠ FIRST USED FOR REMOVING A COMPLAINT FROM THE SUPPRESSION LIST (#159): a
   * person pressed "this is spam", and mailing them again has legal weight in
   * several jurisdictions. A 409 rather than a 403, because the caller has the
   * permission - it is the state of the address that stands in the way.
   */
  "confirmation_required",
  /**
   * Our email provider has paused sending for the workspace (#157), usually on
   * its bounce or complaint rate.
   *
   * ⚠ A 403, NOT A 429. Waiting does not lift a pause; a review does. An SDK
   * that backs off on it retries until it gives up.
   */
  "sending_paused",
  /**
   * Our own review holds the workspace's sending (#170), pending a person.
   *
   * ⚠ A 403, AND NOT `sending_paused`: a pause is the email provider's and
   * lifts with better rates; a hold is ours and lifts with a review.
   */
  "sending_held",
  /**
   * ⚠ ADDITIVE (#222). The same template, fixed part for fixed part, is
   * already waiting for review or approved in this workspace; a second copy
   * would be a second approval nobody reviewed.
   */
  "template_already_submitted",
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
 * and is not retryable - it is a billing state, owned by the meter, not by the
 * request path. Collapsing the two into one 429 makes it impossible to sell a
 * plan that differs only by volume.
 */
export const RETRYABLE_ERRORS: readonly ErrorName[] = [
  "rate_limit_exceeded",
  "internal_server_error",
]
