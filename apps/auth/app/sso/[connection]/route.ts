import type { NextRequest } from "next/server"
import { confirmUrl, decideSsoEntry, redirectHere } from "../../_lib/sso-server"

export const dynamic = "force-dynamic"

/**
 * `GET /sso/<connection id>` (#340): the link an admin gives their team, and
 * the Initiate Login URI an IdP dashboard tile (Okta, Entra My Apps) opens.
 *
 *   - Reached from our own sites or the address bar (`startedByUs`): hands
 *     straight over to `/sso/start` with no interstitial.
 *   - Reached cross-site from anywhere else (an IdP tile, webmail, chat, or
 *     an IdP logout page): hands over to `/sso/confirm`, where the person's
 *     own click starts the flow on our origin and prevents login CSRF.
 *
 * Accepts OIDC Core Section 4 `iss`, `login_hint` and `target_link_uri`
 * alongside our own `redirect_url`.
 *
 * ⚠ THE STATIC ROUTES UNDER /sso (start, confirm, test, callback...) WIN OVER
 * THIS DYNAMIC ONE, so only everything else reaches here.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ connection: string }> },
) {
  const { connection } = await params
  const entry = decideSsoEntry(request, connection, request.nextUrl.searchParams)
  if (entry.action === "invalid") return redirectHere(confirmUrl())
  if (entry.action === "interstitial") return redirectHere(confirmUrl(entry))

  const query = new URLSearchParams({ connection: entry.connection })
  if (entry.forwardedRedirectUrl) query.set("redirect_url", entry.forwardedRedirectUrl)
  if (entry.loginHint) query.set("login_hint", entry.loginHint)
  if (entry.iss !== null) query.set("iss", entry.iss)
  return redirectHere(`/sso/start?${query.toString()}`)
}
