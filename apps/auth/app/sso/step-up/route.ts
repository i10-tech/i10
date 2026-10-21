import { auth } from "@clerk/nextjs/server"
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
 * `GET /sso/step-up?connection=<id>&redirect_url=<where to>` (#337, sso.md
 * 2.4): a managed account proving itself to its IdP again before something
 * irreversible. The API's `403 sso_step_up_required` names this URL.
 *
 * ⚠ THE SESSION BEING MADE FRESH IS THE ONE THIS BROWSER HOLDS, read here
 * from Clerk, never named by the caller. The IdP's answer is then accepted
 * only for that session's own user (`stepUp` in identity/bridge.ts).
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
    const token = await (await auth()).getToken()
    if (!token) return Response.redirect(new URL("/sign-in", request.url), 303)
    const upstream = await callApi(
      "/sso/attempts",
      { connection, purpose: "step_up", binding, returnTo },
      { authorization: `Bearer ${token}` },
    )
    answer = (await upstream.json()) as typeof answer
    if (!upstream.ok || !answer.redirectUrl)
      return Response.redirect(
        failedUrl(
          request,
          answer.message ?? "We could not ask your company to confirm it is you.",
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
