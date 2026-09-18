import type { Metadata } from "next"
import { CallbackHandler } from "./callback-handler"

export const metadata: Metadata = { title: "Connecting" }

/**
 * Where a DNS provider sends the browser back after authorisation.
 *
 * ⚠ THE PATH IS FIXED AND THE SLUG IS A SEGMENT, BECAUSE PROVIDERS COMPARE THE
 * REDIRECT URI EXACTLY. `DNS_OAUTH_REDIRECT_BASE` on the API has to equal what
 * is registered with each provider character for character, so this route's
 * shape is part of that contract rather than a routing preference — moving it
 * breaks every registered application at once, silently, with a provider-side
 * error nobody here can see.
 *
 * ⚠ IT IS INSIDE THE `(app)` GROUP ON PURPOSE. The exchange is a session-
 * authenticated call: `state` proves which workspace STARTED the flow, and the
 * session proves the person finishing it may act for that workspace. Those are
 * different questions and the API asks both. A page outside the console shell
 * would have the first and not the second.
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
