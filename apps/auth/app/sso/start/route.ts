import type { NextRequest } from "next/server"
import { callApi } from "../../_lib/devices-server"
import { afterAuthUrl } from "../../_lib/redirect"
import {
  bindingCookie,
  failedUrl,
  samlBindingCookie,
  newBinding,
  startedByUs,
} from "../../_lib/sso-server"

export const dynamic = "force-dynamic"

/**
 * `GET /sso/start?connection=<id>&redirect_url=<where to>` (#337): where the
 * API's `403 sso_required` sends a managed account, and where "Continue with
 * your company's SSO" will point (#340).
 *
 * ⚠ A FRESH BINDING EVERY TIME. Starting again replaces the cookie, so an
 * older attempt still in flight can no longer be finished from this browser -
 * the last one started is the only one that counts.
 */
export async function GET(request: NextRequest) {
  if (!startedByUs(request))
    return Response.redirect(
      failedUrl(request, "Start your company's sign-in from i10."),
      303,
    )
  const connection = request.nextUrl.searchParams.get("connection") ?? ""
  const returnTo = afterAuthUrl(
    request.nextUrl.searchParams.get("redirect_url") ?? undefined,
  )
  const binding = newBinding()

  let answer: { redirectUrl?: string; message?: string; protocol?: string }
  try {
    const upstream = await callApi("/sso/attempts", {
      connection,
      purpose: "sign_in",
      binding,
      returnTo,
    })
    answer = (await upstream.json()) as typeof answer
    if (!upstream.ok || !answer.redirectUrl)
      return Response.redirect(
        failedUrl(
          request,
          answer.message ?? "We could not start your company's sign-in.",
        ),
        303,
      )
  } catch {
    return Response.redirect(
      failedUrl(request, "Sign-in is temporarily unavailable. Try again in a moment."),
      303,
    )
  }

  const response = new Response(null, {
    status: 303,
    headers: { Location: answer.redirectUrl },
  })
  response.headers.append("Set-Cookie", bindingCookie(binding))
  // A SAML IdP answers with a cross-site POST: see SAML_COOKIE (#339).
  if (answer.protocol === "saml")
    response.headers.append("Set-Cookie", samlBindingCookie(binding))
  response.headers.set("Cache-Control", "no-store")
  return response
}
