/**
 * When to insist on a provider's consent screen.
 *
 * ⚠ THIS EXISTS TO GET A REFRESH TOKEN OUT OF GOOGLE, AND NOTHING ELSE. Clerk's
 * user profile renders "This account has been disconnected" for exactly four
 * error codes — read out of its shipped bundle — and one of them is
 * `external_account_missing_refresh_token`. Google returns a refresh token only
 * when the authorize request carries `access_type=offline` AND the consent
 * screen is actually shown. Clerk asks for `access_type=offline&prompt=select_account`,
 * so anybody who has consented to i10 before gets the account chooser, skips
 * consent, and comes back without one.
 *
 * ⚠ AND IT IS DELIBERATELY NOT APPLIED TO EVERY SIGN-IN. Forcing consent on the
 * sign-in button would put an extra click in front of every returning customer,
 * forever, to fix something they will never see. The rule is:
 *
 *   - SIGNING UP    → ask for consent. They expect a set-up step, and this is
 *                     the one moment the refresh token can be captured for free.
 *   - SIGNING IN    → account chooser only. No consent screen.
 *   - SIGNING IN and turning out to be new → the callback asks once, AFTER they
 *                     have said yes to creating an account, and only if the
 *                     first round trip did not already produce a token.
 *
 * ⚠ GITHUB IS ABSENT ON PURPOSE. Its tokens do not expire and Clerk asks it for
 * no refresh token, which is why GitHub never showed the badge and Google
 * always did. Adding a provider here costs a consent screen, so only add one
 * that is actually failing this way.
 */

/**
 * ⚠ `consent` ALONGSIDE `select_account`, NOT INSTEAD OF IT. Google's `prompt`
 * is a space-delimited list; dropping `select_account` would stop somebody with
 * several Google accounts choosing which one — a worse bug than the one being
 * fixed.
 */
export const CONSENT_PROMPT = "consent select_account"

/** Providers that withhold a refresh token unless consent is shown. */
const NEEDS_CONSENT: ReadonlySet<string> = new Set(["oauth_google"])

/** The `oidcPrompt` for a button, or undefined to leave Clerk's default alone. */
export function consentPromptFor(
  strategy: string,
  intent: "sign-in" | "sign-up",
): string | undefined {
  return intent === "sign-up" && NEEDS_CONSENT.has(strategy)
    ? CONSENT_PROMPT
    : undefined
}

/** Whether this provider is one we would re-ask consent for after a sign-up. */
export function needsConsentForRefreshToken(provider: string): boolean {
  return NEEDS_CONSENT.has(`oauth_${provider}`)
}

/**
 * The code Clerk records when a provider came back without a refresh token.
 *
 * ⚠ IT IS THE TRIGGER FOR THE SECOND ROUND TRIP, WHICH IS WHY IT IS CHECKED
 * RATHER THAN ASSUMED. Somebody authorising i10 for the very first time IS
 * shown Google's consent screen and DOES come back with a token — sending them
 * to Google twice would be a redirect nobody needed.
 */
export const MISSING_REFRESH_TOKEN = "external_account_missing_refresh_token"
