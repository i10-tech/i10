/**
 * Clerk's template slugs, and the one place they are written down.
 *
 * ⚠ THESE STRINGS ARE CLERK'S AND HAVE NOT BEEN VERIFIED AGAINST THE INSTANCE.
 * Clerk publishes the template HTML in the dashboard but not the slugs, and
 * they are not in the documentation either. Get the authoritative set with:
 *
 *     npx clerk@latest api templates/email
 *
 * ⚠ A WRONG SLUG HERE IS COSMETIC, NOT FATAL, WHICH IS WHY SHIPPING BEFORE
 * VERIFYING IS SAFE. An unrecognised slug falls through to Clerk's own rendered
 * body — see `renderClerkEmail` — so the worst case is an email in Clerk's
 * styling rather than a customer who never receives one. The webhook handler
 * also LOGS every slug it does not recognise, so one real send of each template
 * produces the exact list to paste here.
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

  passkeyAdded: "passkey_added",
  passkeyRemoved: "passkey_removed",

  invitation: "invitation",
  organizationInvitation: "organization_invitation",
  organizationMemberJoined: "organization_invitation_accepted",

  waitlistConfirmation: "waitlist_confirmation",
  waitlistInvitation: "waitlist_invitation",
} as const

export type KnownSlug = (typeof SLUG)[keyof typeof SLUG]
