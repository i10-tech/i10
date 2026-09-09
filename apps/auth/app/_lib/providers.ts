import "server-only"
import type { SsoStrategy } from "./clerk-types"
import { isAppleUserAgent } from "./apple"

/**
 * Which SSO buttons to draw — asked of Clerk, not hard-coded here.
 *
 * ⚠ THE LIST USED TO BE A CONSTANT IN THE COMPONENT, AND THAT IS HOW WE SHIPPED
 * A "Continue with Apple" BUTTON FOR A PROVIDER THE INSTANCE HAD NEVER HAD.
 * Clerk's environment endpoint is the only thing that actually knows what is
 * configured; a literal in our source is a second copy of that answer, and the
 * two drift the moment somebody adds or removes a connection in the dashboard.
 * Reading it means adding a provider in Clerk is the whole of adding a provider
 * — no deploy, no code change.
 *
 * ⚠ IT IS FETCHED ON THE SERVER, WHICH IS WHAT KEEPS THE FIRST PAINT HONEST.
 * Deciding this in the browser would draw the buttons we guessed at and then
 * correct them a moment later, moving every control underneath while somebody
 * is reaching for one. Both pages are `force-dynamic` already.
 *
 * ⚠ THE ENDPOINT NEEDS NO CREDENTIALS. It is the same document clerk-js fetches
 * from the browser on every page load, and it is public by design — verified by
 * fetching it with a bare curl and no cookie. So this needs no secret and no
 * new environment variable.
 */
export interface SsoProvider {
  strategy: SsoStrategy
  /** Clerk's own display name, which becomes the button's label — "GitHub". */
  name: string
}

/**
 * ⚠ CACHED, BECAUSE THIS IS ON THE PATH OF EVERY SIGN-IN PAGE RENDER. Five
 * minutes is long enough that Clerk is not asked once per visitor and short
 * enough that adding a provider shows up without a deploy.
 */
const ENVIRONMENT_TTL_SECONDS = 300

/**
 * ⚠ APPLE IS GATED TWICE, AND BOTH GATES ARE NEEDED. Clerk has to have the
 * connection (or the button cannot work at all) AND the person has to be on
 * Apple hardware (or it is noise) — see _lib/apple.ts. Neither condition
 * implies the other.
 */
const APPLE: string = "oauth_apple"

/**
 * ⚠ AN EXPLICIT ORDER, BECAUSE JSON KEY ORDER IS NOT A PROMISE. Providers we
 * know come first in a deliberate sequence; anything enabled later follows,
 * alphabetically, rather than landing in whatever position the API happened to
 * serialise it in.
 */
const PREFERRED_ORDER = ["oauth_google", "oauth_github", "oauth_apple"]

export async function ssoProviders(
  userAgent: string | null | undefined,
): Promise<SsoProvider[]> {
  const configured = await configuredProviders()

  return isAppleUserAgent(userAgent)
    ? configured
    : configured.filter((provider) => provider.strategy !== APPLE)
}

interface SocialEntry {
  enabled?: boolean
  authenticatable?: boolean
  not_selectable?: boolean
  deprecated?: boolean
  strategy?: string
  name?: string
}

async function configuredProviders(): Promise<SsoProvider[]> {
  const host = frontendApiHost()
  if (!host) return []

  try {
    const response = await fetch(`https://${host}/v1/environment`, {
      next: { revalidate: ENVIRONMENT_TTL_SECONDS },
    })
    if (!response.ok) return []

    const body = (await response.json()) as {
      user_settings?: { social?: Record<string, SocialEntry> }
    }

    const social = Object.values(body.user_settings?.social ?? {})

    return social
      .filter(
        (entry): entry is SocialEntry & { strategy: string; name: string } =>
          // ⚠ ALL FOUR FLAGS, NOT JUST `enabled`. Clerk keeps an entry for a
          // provider that is configured but cannot be used to sign in
          // (`authenticatable: false`), one it is retiring (`deprecated`), and
          // one it does not want offered as a button (`not_selectable`).
          // Rendering any of those is a button that fails when pressed.
          Boolean(entry.enabled) &&
          entry.authenticatable !== false &&
          entry.not_selectable !== true &&
          entry.deprecated !== true &&
          typeof entry.strategy === "string" &&
          typeof entry.name === "string",
      )
      .map((entry) => ({
        strategy: entry.strategy as SsoStrategy,
        name: entry.name,
      }))
      .sort(byPreferredOrder)
  } catch {
    /*
     * ⚠ NO BUTTONS RATHER THAN GUESSED BUTTONS, AND THAT IS THE DELIBERATE
     * TRADE. If Clerk's environment cannot be read we do not know what is
     * configured, and inventing a list is how the Apple button existed in the
     * first place. The password form still carries the page, and an instance
     * we cannot reach is one whose SSO would not have completed anyway.
     */
    return []
  }
}

function byPreferredOrder(a: SsoProvider, b: SsoProvider): number {
  const ai = PREFERRED_ORDER.indexOf(a.strategy)
  const bi = PREFERRED_ORDER.indexOf(b.strategy)
  if (ai !== -1 && bi !== -1) return ai - bi
  if (ai !== -1) return -1
  if (bi !== -1) return 1
  return a.name.localeCompare(b.name)
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
    return decoded.endsWith("$") ? decoded.slice(0, -1) : null
  } catch {
    return null
  }
}
