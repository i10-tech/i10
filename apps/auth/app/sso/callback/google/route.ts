import type { NextRequest } from "next/server"
import { finishCallback } from "../../../_lib/sso-callback"

export const dynamic = "force-dynamic"

/**
 * `GET /sso/callback/google` (#338): the one redirect URI registered on OUR
 * Google OAuth client, kept apart from customer IdPs' `/sso/callback` so a
 * Google code can never be delivered to another IdP's attempt. See
 * `googleRedirectUri` in the API's identity/oidc.ts.
 */
export async function GET(request: NextRequest) {
  return finishCallback(request, "google")
}
