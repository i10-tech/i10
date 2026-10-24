import { auth } from "@clerk/nextjs/server"
import type { NextRequest } from "next/server"
import { callApi } from "../../_lib/devices-server"
import { afterAuthUrl } from "../../_lib/redirect"
import {
  bindingCookie,
  failedUrl,
  newBinding,
  samlBindingCookie,
  startedByUs,
} from "../../_lib/sso-server"

export const dynamic = "force-dynamic"

/**
 * `GET /sso/test-run?connection=<id>&redirect_url=<the console page>` (#340):
 * an admin starts a test sign-in at their identity provider. Nobody is signed
 * in; the run's claims are recorded for the console and the browser returns to
 * `redirect_url` with `#sso_test=passed|failed`.
 *
 * ⚠ THE ADMIN IS THE SESSION THIS BROWSER HOLDS, read here from Clerk, and the
 * API refuses anybody who may not manage the connection's workspace (`POST
 * /sso/attempts` with purpose `test_run`). A fresh binding every time, as for
 * a sign-in.
 */
export async function GET(request: NextRequest) {
  if (!startedByUs(request))
    return Response.redirect(failedUrl(request, "Start the test from i10."), 303)
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
      { connection, purpose: "test_run", binding, returnTo },
      { authorization: `Bearer ${token}` },
    )
    answer = (await upstream.json()) as typeof answer
    if (!upstream.ok || !answer.redirectUrl)
      return Response.redirect(
        failedUrl(request, answer.message ?? "We could not start the test."),
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
  if (answer.protocol === "saml")
    response.headers.append("Set-Cookie", samlBindingCookie(binding))
  response.headers.set("Cache-Control", "no-store")
  return response
}
