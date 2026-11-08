import type { NextRequest } from "next/server"
import { finishCallback } from "../../_lib/sso-callback"

export const dynamic = "force-dynamic"

/**
 * `GET /sso/callback?code=...&state=...&iss=...` (#338): the redirect URI every
 * OIDC IdP is given. The API verifies everything (identity/oidc.ts); this route
 * adds the binding cookie, forwards the query, and sends the browser on.
 *
 * ⚠ A CROSS-SITE ARRIVAL BY DESIGN, SO NO `startedByUs` HERE. The IdP's
 * redirect is a top-level navigation from its own site. What makes it safe is
 * the binding cookie (SameSite=Lax, so it comes back on exactly this kind of
 * navigation) and the state: a callback carrying somebody else's code and
 * state, planted in this browser by a link (login CSRF), names an attempt
 * bound to THEIR browser and is refused as `wrong_browser` before the code is
 * ever exchanged.
 *
 * ⚠ THE CODE, THE STATE AND THE ID TOKEN ARE NEVER LOGGED HERE OR AT THE API.
 * The browser leaves this URL with a 303 and `Referrer-Policy: no-referrer`,
 * and the one-time handoff code it is given travels in a fragment.
 */
export async function GET(request: NextRequest) {
  return finishCallback(request, "oidc")
}
