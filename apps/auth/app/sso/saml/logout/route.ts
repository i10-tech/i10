import { auth } from "@clerk/nextjs/server"
import type { NextRequest } from "next/server"
import { callApi } from "../../../_lib/devices-server"
import { leave } from "../../../_lib/sso-callback"
import { failedUrl, startedByUs } from "../../../_lib/sso-server"

export const dynamic = "force-dynamic"

/**
 * `GET /sso/saml/logout` (#339, sso.md 2.5): SP-initiated single logout for
 * the session this browser holds. The API ends it here and at Clerk first,
 * then hands back the IdP's SLO URL with a LogoutRequest, or nothing when the
 * connection has none.
 *
 * ⚠ ONLY FROM OUR OWN PAGES (`startedByUs`): another site must not be able to
 * sign somebody out of i10 by linking here.
 */
export async function GET(request: NextRequest) {
  const signedOut = new URL("/sign-in", request.url)
  if (!startedByUs(request))
    return leave(failedUrl(request, "Sign out from i10 itself."), true)
  try {
    const token = await (await auth()).getToken()
    if (!token) return leave(signedOut, true)
    const upstream = await callApi(
      "/sso/saml/logout",
      {},
      { authorization: `Bearer ${token}` },
    )
    const answer = (await upstream.json()) as { redirectUrl?: string | null }
    if (upstream.ok && answer.redirectUrl)
      return leave(new URL(answer.redirectUrl), true)
    return leave(signedOut, true)
  } catch {
    return leave(
      failedUrl(request, "Sign-out is temporarily unavailable. Try again."),
      true,
    )
  }
}
