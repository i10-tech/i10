import { render } from "@react-email/components"
import { SLUG } from "./slugs.js"
import { VerificationCode } from "./templates/verification-code.js"
import { SignInCode } from "./templates/sign-in-code.js"
import { ResetPasswordCode } from "./templates/reset-password-code.js"
import { PasswordChanged } from "./templates/password-changed.js"

export { SLUG } from "./slugs.js"
export type { KnownSlug } from "./slugs.js"

/**
 * One `email.created` payload, narrowed to what rendering needs.
 *
 * ⚠ ALMOST EVERY FIELD IS OPTIONAL BECAUSE CLERK'S TYPE SAYS SO — `slug`,
 * `subject`, `body` and `to_email_address` are all nullable in `EmailJSON`.
 * Treating any of them as guaranteed is how a webhook for an unusual template
 * throws inside the handler and gets retried forever.
 */
export interface ClerkEmailPayload {
  slug?: string | null
  subject?: string
  body?: string
  body_plain?: string | null
  data?: Record<string, unknown> | null
}

export interface RenderedEmail {
  subject: string
  html: string
  text?: string
}

/**
 * The variable Clerk puts the one-time code in.
 *
 * ⚠ IT LIVES IN `data`, NOT AT THE TOP LEVEL. The deliverability guide calls it
 * `otp_code` and it is the single field that makes rendering our own code email
 * possible at all — without it the only way to send the code would be to
 * forward Clerk's own HTML.
 */
function codeFrom(payload: ClerkEmailPayload): string | null {
  const value = payload.data?.["otp_code"]
  return typeof value === "string" && value.length > 0 ? value : null
}

/**
 * Turns one Clerk email into something our send path can post.
 *
 * ⚠ RETURNS CLERK'S OWN BODY FOR ANYTHING WE HAVE NOT TEMPLATED, RATHER THAN
 * NULL. Clerk sends more templates than we will ever style — organization
 * invitations, waitlist notices, whatever they add next — and a handler that
 * dropped them would silently stop delivering mail the product depends on the
 * first time somebody enabled a new feature in the dashboard. Falling through
 * means the worst outcome is an email that looks like Clerk's, which is exactly
 * what customers get today.
 *
 * ⚠ AND IT RETURNS NULL ONLY WHEN THERE IS GENUINELY NOTHING TO SEND — no
 * template of ours and no body from Clerk either. The caller treats that as
 * "acknowledge and drop", never as an error to retry.
 */
export async function renderClerkEmail(
  payload: ClerkEmailPayload,
): Promise<RenderedEmail | null> {
  const code = codeFrom(payload)

  // ⚠ EVERY CODE TEMPLATE NEEDS `otp_code` AND FALLS BACK WITHOUT IT. A code
  // email rendered with an empty box is worse than Clerk's version of the same
  // email, so the absence of the variable sends us down the passthrough path.
  const element =
    payload.slug === SLUG.verificationCode && code
      ? VerificationCode({ code })
      : payload.slug === SLUG.signInCode && code
        ? SignInCode({ code })
        : payload.slug === SLUG.resetPasswordCode && code
          ? ResetPasswordCode({ code })
          : payload.slug === SLUG.passwordChanged
            ? PasswordChanged()
            : null

  if (element) {
    return {
      subject: payload.subject ?? "i10",
      html: await render(element),
      // ⚠ RENDERED SEPARATELY, NOT STRIPPED FROM THE HTML. A plain-text part is
      // what stops a message scoring as HTML-only in spam filters, and
      // react-email produces a real one from the same tree.
      text: await render(element, { plainText: true }),
    }
  }

  if (payload.body) {
    return {
      subject: payload.subject ?? "i10",
      html: payload.body,
      text: payload.body_plain ?? undefined,
    }
  }

  return null
}
