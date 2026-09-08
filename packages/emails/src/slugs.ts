/**
 * The Clerk templates we render ourselves.
 *
 * ⚠ THESE STRINGS ARE CLERK'S, NOT OURS, AND THEY MUST BE VERIFIED AGAINST THE
 * INSTANCE RATHER THAN TRUSTED FROM MEMORY. Clerk does not publish the slug
 * list in its documentation — it lives in the dashboard and in the API. Get the
 * authoritative set with:
 *
 *     npx clerk@latest api templates/email
 *
 * ⚠ AND A SLUG THAT IS WRONG HERE DOES NOT BREAK ANYTHING, WHICH IS THE WHOLE
 * REASON THE TABLE IS SHAPED THIS WAY. An unrecognised slug falls through to
 * Clerk's own rendered body — see `renderClerkEmail` — so the worst case for a
 * typo is a correct email in Clerk's styling rather than a customer who never
 * receives one. Adding a template is a new entry here; getting one wrong is
 * cosmetic.
 */
export const SLUG = {
  verificationCode: "verification_code",
  signInCode: "sign_in_code",
  resetPasswordCode: "reset_password_code",
  passwordChanged: "password_changed",
} as const

export type KnownSlug = (typeof SLUG)[keyof typeof SLUG]
