import { render } from "@react-email/components"
import { SLUG } from "./slugs.js"
import { VerificationCode } from "./templates/verification-code.js"
import { ResetPasswordCode } from "./templates/reset-password-code.js"
import { MagicLink, type MagicLinkPurpose } from "./templates/magic-link.js"
import { AccountLocked } from "./templates/account-locked.js"
import { PasswordChanged } from "./templates/password-changed.js"
import { PasswordRemoved } from "./templates/password-removed.js"
import { PrimaryEmailChanged } from "./templates/primary-email-changed.js"
import { NewSignIn } from "./templates/new-sign-in.js"
import { MfaEnabled } from "./templates/mfa-enabled.js"
import { PasskeyChanged } from "./templates/passkey-changed.js"
import { Invitation } from "./templates/invitation.js"
import { OrganizationInvitation } from "./templates/organization-invitation.js"
import { OrganizationMemberJoined } from "./templates/organization-member-joined.js"
import { WaitlistConfirmation } from "./templates/waitlist-confirmation.js"

export { NOT_OURS, SLUG } from "./slugs.js"
export type { KnownSlug } from "./slugs.js"
export * from "./templates/billing/payment-succeeded.js"
export * from "./templates/billing/payment-failed.js"
export * from "./templates/billing/subscription-price-changed.js"

/**
 * One `email.created` payload, narrowed to what rendering needs.
 *
 * ⚠ ALMOST EVERY FIELD IS OPTIONAL BECAUSE CLERK'S OWN TYPE SAYS SO — `slug`,
 * `subject`, `body` and the rest are all nullable in `EmailJSON`. Treating any
 * of them as guaranteed is how a webhook for an unusual template throws inside
 * the handler and is retried until Svix gives up.
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
 * Reads one template variable out of `data`.
 *
 * ⚠ IT WALKS A DOTTED PATH, BECAUSE HALF OF CLERK'S VARIABLES ARE NESTED.
 * The templates say `{{invitation.expires_in_days}}`, `{{org.name}}` and
 * `{{app.url}}` — those are objects in the payload, not flat keys with dots in
 * their names. Reading `data["org_name"]` finds nothing and the value silently
 * disappears from the email, which is exactly what an earlier version of this
 * file did.
 *
 * ⚠ AND IT ACCEPTS A NUMBER. `invitation.expires_in_days` and
 * `failed_attempts` arrive as numbers; a string-only guard would drop both and
 * leave a sentence with a hole where the figure should be.
 */
function str(data: Record<string, unknown> | null | undefined, path: string) {
  const value = path
    .split(".")
    .reduce<unknown>(
      (node, key) =>
        node && typeof node === "object"
          ? (node as Record<string, unknown>)[key]
          : undefined,
      data,
    )

  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/**
 * The device line Clerk splits across three variables.
 *
 * ⚠ JOINED HERE RATHER THAN IN THE TEMPLATE so that a missing piece degrades to
 * a shorter sentence instead of "undefined undefined for undefined", which is
 * what interpolating them straight into the copy would produce.
 */
function deviceFrom(data: Record<string, unknown> | null | undefined) {
  const parts = [
    str(data, "device_type"),
    str(data, "browser_name"),
    str(data, "operating_system"),
  ].filter(Boolean)

  return parts.length > 0 ? parts.join(" · ") : undefined
}

function magicLink(
  purpose: MagicLinkPurpose,
  data: Record<string, unknown> | null | undefined,
) {
  const url = str(data, "magic_link")
  if (!url) return null

  return MagicLink({
    purpose,
    url,
    ttlMinutes: str(data, "ttl_minutes"),
    requestedFrom: str(data, "requested_from"),
    requestedAt: str(data, "requested_at"),
  })
}

/**
 * Picks the template for one Clerk email, or `null` to fall back.
 *
 * ⚠ EVERY BRANCH THAT NEEDS A VARIABLE RETURNS `null` WITHOUT IT. A code email
 * rendered with an empty box, or a link email with no link, is worse than
 * Clerk's version of the same message — so a missing variable sends us down the
 * passthrough path rather than producing a broken email confidently.
 */
function templateFor(payload: ClerkEmailPayload) {
  const d = payload.data
  const code = str(d, "otp_code")

  switch (payload.slug) {
    case SLUG.verificationCode:
      return code
        ? VerificationCode({
            code,
            requestedFrom: str(d, "requested_from"),
            requestedAt: str(d, "requested_at"),
          })
        : null

    case SLUG.resetPasswordCode:
      return code
        ? ResetPasswordCode({
            code,
            requestedFrom: str(d, "requested_from"),
            requestedAt: str(d, "requested_at"),
          })
        : null

    case SLUG.magicLinkSignIn:
      return magicLink("sign-in", d)
    case SLUG.magicLinkSignUp:
      return magicLink("sign-up", d)
    case SLUG.magicLinkVerify:
      return magicLink("verify", d)

    case SLUG.accountLocked:
      return AccountLocked({
        lockedAt: str(d, "locked_date"),
        failedAttempts: str(d, "failed_attempts"),
        lockoutDuration: str(d, "lockout_duration"),
      })

    case SLUG.passwordChanged:
      return PasswordChanged({
        greetingName: str(d, "greeting_name"),
        emailAddress: str(d, "primary_email_address"),
      })

    case SLUG.passwordRemoved:
      return PasswordRemoved({
        greetingName: str(d, "greeting_name"),
        emailAddress: str(d, "primary_email_address"),
      })

    case SLUG.primaryEmailChanged:
      return PrimaryEmailChanged({ newEmailAddress: str(d, "new_email_address") })

    case SLUG.newSignIn:
      return NewSignIn({
        signInMethod: str(d, "sign_in_method"),
        device: deviceFrom(d),
        location: str(d, "location"),
        ipAddress: str(d, "ip_address"),
        signedInAt: str(d, "session_created_at"),
        revokeUrl: str(d, "revoke_session_url"),
        supportEmail: str(d, "support_email"),
      })

    case SLUG.mfaEnabled:
      return MfaEnabled({
        greetingName: str(d, "greeting_name"),
        emailAddress: str(d, "primary_email_address"),
        requestedFrom: str(d, "requested_from"),
        requestedAt: str(d, "requested_at"),
      })

    case SLUG.passkeyAdded:
    case SLUG.passkeyRemoved:
      return PasskeyChanged({
        action: payload.slug === SLUG.passkeyAdded ? "added" : "removed",
        greetingName: str(d, "greeting_name"),
        emailAddress: str(d, "primary_email_address"),
        passkeyName: str(d, "passkey_name"),
      })

    case SLUG.invitation:
    case SLUG.waitlistInvitation: {
      const url = str(d, "action_url")
      return url
        ? Invitation({
            url,
            expiresInDays: str(d, "invitation.expires_in_days"),
            fromWaitlist: payload.slug === SLUG.waitlistInvitation,
          })
        : null
    }

    case SLUG.organizationInvitation: {
      const url = str(d, "action_url")
      return url
        ? OrganizationInvitation({
            url,
            organizationName: str(d, "org.name"),
            inviterName: str(d, "inviter_name"),
          })
        : null
    }

    case SLUG.organizationMemberJoined: {
      const url = str(d, "app.url")
      return url
        ? OrganizationMemberJoined({
            url,
            organizationName: str(d, "org.name"),
            emailAddress: str(d, "email_address"),
          })
        : null
    }

    case SLUG.waitlistConfirmation:
      return WaitlistConfirmation()

    default:
      return null
  }
}

/**
 * Turns one Clerk email into something the send path can post.
 *
 * ⚠ RETURNS CLERK'S OWN BODY FOR ANYTHING WE HAVE NOT TEMPLATED, RATHER THAN
 * NULL. Clerk sends more templates than we will ever style, and adds new ones;
 * a handler that dropped them would silently stop delivering mail the product
 * depends on the first time somebody enabled a feature in the dashboard.
 * Falling through means the worst outcome is an email that looks like Clerk's —
 * which is exactly what customers get today.
 *
 * ⚠ AND IT RETURNS NULL ONLY WHEN THERE IS GENUINELY NOTHING TO SEND. The
 * caller treats that as "acknowledge and drop", never as an error to retry.
 */
export async function renderClerkEmail(
  payload: ClerkEmailPayload,
): Promise<RenderedEmail | null> {
  const element = templateFor(payload)

  if (element) {
    return {
      subject: payload.subject ?? "i10",
      html: await render(element),
      // ⚠ RENDERED SEPARATELY, NOT STRIPPED FROM THE HTML. A real plain-text
      // part is what stops a message scoring as HTML-only in spam filters, and
      // react-email produces one from the same tree.
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
