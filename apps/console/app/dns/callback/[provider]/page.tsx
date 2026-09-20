import type { Metadata } from "next"
import { CallbackHandler } from "./callback-handler"

export const metadata: Metadata = { title: "Connecting" }

/**
 * Where a DNS provider sends the browser back after authorisation.
 *
 * ⚠ THE PATH IS FIXED AND THE SLUG IS A SEGMENT, BECAUSE PROVIDERS COMPARE THE
 * REDIRECT URI EXACTLY. `DNS_OAUTH_REDIRECT_BASE` on the API has to equal what
 * is registered with each provider character for character, so this route's
 * shape is part of that contract rather than a routing preference — changing
 * the PATH breaks every registered application at once, silently, with a
 * provider-side error nobody here can see.
 *
 * ⚠ IT SITS OUTSIDE THE `(app)` GROUP, AND BEING INSIDE IT BROKE THE ENTIRE
 * FLOW FOR NEW CUSTOMERS. That layout redirects to `/onboarding` whenever
 * `should_onboard` is true — so somebody connecting a provider DURING
 * onboarding came back from the provider, hit the redirect before this page
 * rendered, and the effect that exchanges the code never ran. No connection
 * was created and nothing was published; they simply arrived back at the step
 * they started from, with no error anywhere, and an authorisation code that is
 * single-use and now spent. The same flow worked perfectly from `/domains`,
 * because by then they had pressed "Skip to the console" and the skip cookie
 * had disabled the gate — which is exactly the shape that makes this kind of
 * bug take days to find.
 *
 * ⚠ THE GROUP WAS NEVER WHAT AUTHENTICATED THIS PAGE, WHICH IS WHAT THE NOTE
 * HERE USED TO CLAIM. The exchange is session-authenticated — `state` proves
 * which workspace started the flow and the session proves the person finishing
 * it may act for that workspace — but the session comes from `clerkMiddleware`
 * and `auth.protect()`, which cover every route not in `isPublic`, and
 * `/dns/callback` is not in it. `/onboarding` has always sat outside this
 * group and makes authenticated `/console/*` calls on every load. Both
 * questions are still asked; only the redirect is escaped.
 *
 * ⚠ AND THE URL IS UNCHANGED, WHICH IS WHY THIS MOVE IS SAFE AT ALL. `(app)` is
 * a route group, so it never appeared in the path — this page was and remains
 * `/dns/callback/<provider>`, character for character, so every registered
 * redirect URI keeps working. See the note above on why that matters.
 */
export const dynamic = "force-dynamic"

export default async function DnsCallbackPage({
  params,
  searchParams,
}: {
  params: Promise<{ provider: string }>
  searchParams: Promise<{
    code?: string
    state?: string
    error?: string
    error_description?: string
  }>
}) {
  const { provider } = await params
  const query = await searchParams

  return (
    <CallbackHandler
      provider={provider}
      code={query.code ?? null}
      state={query.state ?? null}
      // ⚠ THE PROVIDER'S OWN REFUSAL IS CARRIED THROUGH RATHER THAN REPLACED.
      // "You do not have permission to grant DNS access for this account" is a
      // sentence the customer can act on; "the connection failed" is not.
      providerError={query.error_description ?? query.error ?? null}
    />
  )
}
