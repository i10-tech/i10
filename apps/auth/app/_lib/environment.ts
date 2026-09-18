import "server-only"

/**
 * Clerk's environment document, fetched once and read by everything that needs
 * to know what this instance is configured to do.
 *
 * ⚠ IT IS THE ONLY HONEST ANSWER TO "WHAT CAN THIS FLOW OFFER?", AND THE
 * ALTERNATIVE HAS ALREADY BITTEN US ONCE. The SSO list used to be a constant in
 * the component, which is how a "Continue with Apple" button shipped for a
 * provider the instance had never had. The same failure is waiting for every
 * step of the sign-up flow: a passkey step on an instance with passkeys off is
 * a button that opens a WebAuthn prompt and then fails, and a two-factor step
 * on an instance with no authenticator strategy is a QR code Clerk will refuse
 * to issue. Asking means turning a feature on in the Clerk dashboard is the
 * whole of turning it on.
 *
 * ⚠ THE ENDPOINT NEEDS NO CREDENTIALS. It is the same document clerk-js fetches
 * from the browser on every page load, and it is public by design — verified by
 * fetching it with a bare curl and no cookie. So this needs no secret and no
 * new environment variable.
 *
 * ⚠ AND IT IS FETCHED ON THE SERVER, WHICH IS WHAT KEEPS THE FIRST PAINT
 * HONEST. Deciding this in the browser would draw the steps we guessed at and
 * then correct them a moment later — on a stepped flow that means the number of
 * steps changes under somebody who has already started counting them.
 */

/**
 * ⚠ CACHED, BECAUSE THIS IS ON THE PATH OF EVERY SIGN-IN AND SIGN-UP RENDER.
 * Five minutes is long enough that Clerk is not asked once per visitor and
 * short enough that enabling a provider shows up without a deploy.
 *
 * ⚠ AND TWO CALLERS IN ONE RENDER COST ONE REQUEST. Next dedupes identical
 * `fetch`es within a render pass, so `ssoProviders()` and `signUpAbilities()`
 * on the same page share the response rather than racing for it.
 */
const ENVIRONMENT_TTL_SECONDS = 300

interface SocialEntry {
  enabled?: boolean
  authenticatable?: boolean
  not_selectable?: boolean
  deprecated?: boolean
  strategy?: string
  name?: string
}

interface AttributeEntry {
  enabled?: boolean
  used_for_second_factor?: boolean
}

export interface ClerkEnvironment {
  user_settings?: {
    social?: Record<string, SocialEntry>
    attributes?: Record<string, AttributeEntry>
  }
}

export async function clerkEnvironment(): Promise<ClerkEnvironment | null> {
  const host = frontendApiHost()
  if (!host) return null

  try {
    const response = await fetch(`https://${host}/v1/environment`, {
      next: { revalidate: ENVIRONMENT_TTL_SECONDS },
    })
    if (!response.ok) return null
    return (await response.json()) as ClerkEnvironment
  } catch {
    /*
     * ⚠ NULL RATHER THAN A GUESS, AND EVERY CALLER TREATS IT AS "OFFER
     * NOTHING". If Clerk's environment cannot be read we do not know what is
     * configured, and inventing a list is how the Apple button existed in the
     * first place. An instance we cannot reach is one whose SSO and passkey
     * enrolment would not have completed anyway.
     */
    return null
  }
}

/**
 * The optional steps this instance can actually finish.
 *
 * ⚠ `used_for_second_factor` IS CHECKED SEPARATELY FROM `enabled`, AND THE
 * DISTINCTION IS REAL. Clerk can have the authenticator-app attribute enabled
 * as a FIRST factor — signing in with a TOTP code instead of a password —
 * without it being available as a second one. Offering "turn on two-factor
 * authentication" in that configuration produces a secret Clerk will not accept
 * as a second factor, so the person enrols something that never challenges them.
 */
export interface SignUpAbilities {
  /** `user.createPasskey()` will be accepted. */
  passkey: boolean
  /** `user.createTOTP()` will be accepted AND used as a second factor. */
  totp: boolean
  /** Recovery codes can be issued alongside the authenticator app. */
  backupCodes: boolean
}

export async function signUpAbilities(): Promise<SignUpAbilities> {
  const attributes = (await clerkEnvironment())?.user_settings?.attributes ?? {}

  return {
    passkey: attributes.passkey?.enabled === true,
    totp:
      attributes.authenticator_app?.enabled === true &&
      attributes.authenticator_app.used_for_second_factor === true,
    backupCodes: attributes.backup_code?.enabled === true,
  }
}

/**
 * The instance's Frontend API host, read out of the publishable key.
 *
 * ⚠ THE KEY ENCODES IT, SO THERE IS NOTHING NEW TO CONFIGURE. A publishable key
 * is `pk_live_` (or `pk_test_`) followed by base64 of the FAPI host with a `$`
 * terminator — `pk_live_Y2xlcmsuaTEwLnRlY2gk` decodes to `clerk.i10.tech$`.
 * Deriving it means this cannot drift from the key the rest of the app uses,
 * which a second `AUTH_CLERK_FAPI_URL` variable certainly would.
 */
function frontendApiHost(): string | null {
  const key = process.env.CLERK_PUBLISHABLE_KEY
  if (!key) return null

  const encoded = key.replace(/^pk_(?:live|test)_/, "")
  if (encoded === key) return null

  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8")
    // ⚠ THE `$` IS THE CHECK, NOT A CHARACTER TO TRIM. Base64 decoding never
    // fails loudly on junk — it produces mojibake — so the terminator is the
    // only evidence that what came back is really a host and not a key of some
    // other shape.
    return decoded.endsWith("$") ? decoded.slice(0, -1) : null
  } catch {
    return null
  }
}
