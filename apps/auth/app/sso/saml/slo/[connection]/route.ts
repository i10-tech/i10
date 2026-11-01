import type { NextRequest } from "next/server"
import { callApi } from "../../../../_lib/devices-server"
import { leave } from "../../../../_lib/sso-callback"
import { connectionOf, readForm } from "../../../../_lib/saml-server"

export const dynamic = "force-dynamic"

/**
 * `/sso/saml/slo/<connection id>` (#339, sso.md 2.5): an IdP's single logout,
 * on the Redirect binding (GET) or the POST binding.
 *
 * ⚠ THE RAW QUERY STRING IS FORWARDED UNTOUCHED. The Redirect binding's
 * signature covers the parameters exactly as the IdP encoded them; parsing
 * and rebuilding them here would break every signature.
 *
 * The API ends the sessions a signed LogoutRequest names and gives back where
 * to send the LogoutResponse; a LogoutResponse (the end of our own logout)
 * lands on the sign-in page.
 */
async function finish(
  request: NextRequest,
  body: Record<string, unknown>,
): Promise<Response> {
  const signedOut = "/sign-in"
  try {
    const upstream = await callApi("/sso/saml/slo", body)
    const answer = (await upstream.json()) as { redirectUrl?: string | null }
    if (upstream.ok && answer.redirectUrl) return leave(answer.redirectUrl, true)
    return leave(signedOut, true)
  } catch {
    return leave(signedOut, true)
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ connection: string }> },
) {
  const connection = connectionOf((await params).connection)
  const rawQuery = request.nextUrl.search.replace(/^\?/, "")
  if (!connection || !rawQuery || rawQuery.length > 96 * 1024)
    return leave("/sign-in", true)
  return finish(request, { connection, binding: "redirect", rawQuery })
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ connection: string }> },
) {
  const connection = connectionOf((await params).connection)
  const form = await readForm(request)
  const parameter = form?.has("SAMLRequest")
    ? "SAMLRequest"
    : form?.has("SAMLResponse")
      ? "SAMLResponse"
      : null
  if (!connection || !form || !parameter) return leave("/sign-in", true)
  const relayState = form.get("RelayState")
  return finish(request, {
    connection,
    binding: "post",
    parameter,
    message: form.get(parameter),
    relayState: relayState && relayState.length <= 80 ? relayState : null,
  })
}
