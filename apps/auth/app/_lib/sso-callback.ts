import "server-only"
import type { NextRequest } from "next/server"
import { callApi } from "./devices-server"
import { afterAuthUrl } from "./redirect"
import { BINDING_COOKIE, clearCookies, failedUrl, readCookie } from "./sso-server"

/**
 * Shared with `/sso/callback/google`. `via` says which redirect URI the browser
 * came back to; the API refuses a Google connection's callback anywhere but the
 * Google one, and every other connection's there (the OAuth mix-up defence).
 */
export async function finishCallback(request: NextRequest, via: "oidc" | "google") {
  const params = request.nextUrl.searchParams
  const binding = readCookie(request, BINDING_COOKIE)
  if (!binding)
    return leave(failedUrl(request, "This sign-in has expired. Start again."), true)

  let answer: {
    outcome?: string
    code?: string
    returnTo?: string | null
    passed?: boolean
    message?: string
  }
  try {
    const upstream = await callApi("/sso/oidc/callback", {
      state: params.get("state") ?? "",
      binding,
      via,
      query: {
        code: params.get("code") ?? undefined,
        iss: params.get("iss") ?? undefined,
        error: params.get("error") ?? undefined,
      },
    })
    answer = (await upstream.json()) as typeof answer
    if (!upstream.ok)
      return leave(
        failedUrl(request, answer.message ?? "We could not sign you in. Start again."),
        true,
      )
  } catch {
    return leave(
      failedUrl(request, "Sign-in is temporarily unavailable. Try again in a moment."),
      true,
    )
  }

  if (answer.outcome === "signed_in" && answer.code) {
    // The binding cookie stays: the continue page's handoff swap needs it.
    const url = new URL("/sso/continue", request.url)
    url.hash = new URLSearchParams({ code: answer.code }).toString()
    return leave(url, false)
  }
  if (answer.outcome === "stepped_up")
    return leave(new URL(answer.returnTo ?? afterAuthUrl(undefined)), true)
  if (answer.outcome === "tested") {
    const result = answer.passed ? "passed" : "failed"
    const url = answer.returnTo
      ? new URL(answer.returnTo)
      : new URL("/sso/continue", request.url)
    url.hash = new URLSearchParams({ sso_test: result }).toString()
    return leave(url, true)
  }
  return leave(failedUrl(request, "We could not sign you in. Start again."), true)
}

function leave(to: URL, clear: boolean): Response {
  const response = new Response(null, { status: 303, headers: { Location: to.href } })
  response.headers.set("Cache-Control", "no-store")
  response.headers.set("Referrer-Policy", "no-referrer")
  if (clear) clearCookies(response)
  return response
}
