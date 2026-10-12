import "server-only"

/**
 * What this Clerk instance has switched on, read from its environment - the
 * same document Clerk's `<UserProfile />` read to decide which rows to draw.
 * The account page is ours now (2026-10-12), so it asks the same question.
 *
 * ⚠ A MIRROR OF THE AUTH APP'S `_lib/environment.ts`, NARROWED TO WHAT THE
 * ACCOUNT PAGE NEEDS. Unreadable means the conservative answer: no providers
 * to connect, the default password length, passkeys hidden.
 */

const TTL_SECONDS = 300

/** Clerk's provider names, for the strategies this product offers. */
const NAMES: Record<string, string> = {
  oauth_google: "Google",
  oauth_github: "GitHub",
  oauth_apple: "Apple",
  oauth_microsoft: "Microsoft",
  oauth_gitlab: "GitLab",
  oauth_linkedin_oidc: "LinkedIn",
}

export interface AccountSettings {
  providers: { strategy: string; name: string }[]
  minLength: number
  passkeys: boolean
}

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

export async function accountSettings(): Promise<AccountSettings> {
  const fallback: AccountSettings = { providers: [], minLength: 8, passkeys: false }
  const host = frontendApiHost()
  if (!host) return fallback
  try {
    const response = await fetch(`https://${host}/v1/environment`, {
      next: { revalidate: TTL_SECONDS },
    })
    if (!response.ok) return fallback
    const env = (await response.json()) as {
      user_settings?: {
        social?: Record<string, { enabled?: boolean; strategy?: string; name?: string }>
        attributes?: Record<string, { enabled?: boolean }>
        password_settings?: { min_length?: number }
      }
    }
    const settings = env.user_settings ?? {}
    const providers = Object.entries(settings.social ?? {})
      .filter(([, entry]) => entry.enabled)
      .map(([strategy, entry]) => ({
        strategy: entry.strategy ?? strategy,
        name: NAMES[strategy] ?? entry.name ?? strategy.replace(/^oauth_/, ""),
      }))
    const min = settings.password_settings?.min_length
    return {
      providers,
      minLength: typeof min === "number" && min > 0 ? min : 8,
      passkeys: settings.attributes?.passkey?.enabled === true,
    }
  } catch {
    return fallback
  }
}
