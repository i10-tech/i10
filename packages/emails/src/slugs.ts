/**
 * Clerk's template slugs, and the one place they are written down.
 *
 * ⚠ VERIFIED AGAINST THE INSTANCE with `npx clerk@latest api templates/email`,
 * not guessed. Clerk publishes the template HTML in its dashboard but the slugs
 * appear only in that API — re-run it after any Clerk release that adds
 * templates, because a new one falls through to Clerk's own styling rather than
 * failing, which is easy not to notice.
 *
 * ⚠ A WRONG SLUG IS COSMETIC, NOT FATAL. An unrecognised slug falls through to
 * Clerk's own rendered body — see `renderClerkEmail` — so the worst case is an
 * email that looks like Clerk's rather than a customer who never receives one.
 */
export const SLUG = {
  verificationCode: "verification_code",
  resetPasswordCode: "reset_password_code",

  magicLinkSignIn: "magic_link_sign_in",
  magicLinkSignUp: "magic_link_sign_up",
  magicLinkVerify: "magic_link_user_profile",

  accountLocked: "account_locked",
  passwordChanged: "password_changed",
  passwordRemoved: "password_removed",
  primaryEmailChanged: "primary_email_address_changed",
  newSignIn: "new_device_sign_in",

  mfaEnabled: "mfa_enabled",

  passkeyAdded: "passkey_added",
  passkeyRemoved: "passkey_removed",

  invitation: "invitation",
  organizationInvitation: "organization_invitation",
  organizationMemberJoined: "organization_invitation_accepted",

  waitlistConfirmation: "waitlist_confirmation",
  waitlistInvitation: "waitlist_invitation",
} as const

export type KnownSlug = (typeof SLUG)[keyof typeof SLUG]

/**
 * Templates that are Clerk's to send and will never be ours.
 *
 * ⚠ LISTED SO THEY PASS THROUGH QUIETLY RATHER THAN AS "SOMEBODY SHOULD STYLE
 * THIS". Two groups: Clerk's own BILLING product, which i10 does not use —
 * Polar takes the money — and Clerk's operational mail to us as their customer,
 * about API usage and Stripe. Styling either would mean adopting a system we
 * deliberately did not buy, or rewriting a supplier's message to ourselves.
 *
 * They still get delivered; they simply arrive in Clerk's design, and the
 * handler does not log them as a gap.
 */
export const NOT_OURS: readonly string[] = [
  "billing_receipt",
  "billing_failed_payment",
  "billing_price_transition_upcoming",
  "billing_free_trial_renewal_upcoming",
  "billing_free_trial_renewal_failed",
  "commerce_gateway_account_deauthorized",
  "opaque_token_usage_limit_alert",
  "opaque_token_usage_limit_exceeded",
  // Addressed to us, not to a customer, and it links into Clerk's dashboard.
  "waitlist_entry_created",
]
