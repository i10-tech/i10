import "server-only"
import type { NextRequest } from "next/server"
import { callApi, FINISH_SIGN_IN_MS } from "./devices-server"
import { afterAuthUrl } from "./redirect"
import {
  BINDING_COOKIE,
  clearCookies,
  failedUrl,
  readCookie,
  redirectHere,
} from "./sso-server"

/**
 * Shared with `/sso/callback/google`. `via` says which redirect URI the browser
 * came back to; the API refuses a Google connection's callback anywhere but the
 * Google one, and every other connection's there (the OAuth mix-up defence).
 */
export async function finishCallback(request: NextRequest, via: "oidc" | "google") {
  const params = request.nextUrl.searchParams
  const binding = readCookie(request, BINDING_COOKIE)
  if (!binding) return leave(failedUrl("This sign-in has expired. Start again."), true)

  // Passed whole to `outcomeRedirect`: `confirmAs`, `typed` and `connectionId` too.
  let answer: Parameters<typeof outcomeRedirect>[0] & { message?: string }
  try {
    const upstream = await callApi(
      "/sso/oidc/callback",
      {
        state: params.get("state") ?? "",
        binding,
        via,
        query: {
          code: params.get("code") ?? undefined,
          iss: params.get("iss") ?? undefined,
          error: params.get("error") ?? undefined,
        },
      },
      {},
      FINISH_SIGN_IN_MS,
    )
    answer = (await upstream.json()) as typeof answer
    if (!upstream.ok)
      return leave(
        failedUrl(answer.message ?? "We could not sign you in. Start again."),
        true,
      )
  } catch {
    return leave(
      failedUrl("Sign-in is temporarily unavailable. Try again in a moment."),
      true,
    )
  }

  return outcomeRedirect(answer)
}

/** Where a finished callback sends the browser, OIDC or SAML. */
export function outcomeRedirect(
  answer: {
    outcome?: string
    code?: string
    returnTo?: string | null
    passed?: boolean
    /** SAML IdP-initiated (#339): ask before signing in as this address. */
    confirmAs?: string | null
    /** With `confirmAs`: the IdP answered for somebody other than this typed address. */
    typed?: string
    /** With `typed`: the connection to start again, forcing a fresh login. */
    connectionId?: string
  },
  setCookie?: string,
): Response {
  if (answer.outcome === "signed_in" && answer.code) {
    // The binding cookie stays: the continue page's handoff swap needs it.
    const hash = new URLSearchParams({
      code: answer.code,
      ...(answer.confirmAs !== undefined ? { confirm: answer.confirmAs ?? "" } : {}),
      ...(answer.typed ? { typed: answer.typed } : {}),
      ...(answer.connectionId ? { connection: answer.connectionId } : {}),
    }).toString()
    const response = leave(`/sso/continue#${hash}`, false)
    if (setCookie) response.headers.append("Set-Cookie", setCookie)
    return response
  }
  if (answer.outcome === "stepped_up")
    return leave(answer.returnTo ?? afterAuthUrl(undefined), true)
  if (answer.outcome === "tested") {
    const result = answer.passed ? "passed" : "failed"
    const hash = new URLSearchParams({ sso_test: result }).toString()
    if (!answer.returnTo) return leave(`/sso/continue#${hash}`, true)
    const url = new URL(answer.returnTo)
    url.hash = hash
    return leave(url.href, true)
  }
  return leave(failedUrl("We could not sign you in. Start again."), true)
}

/** `to` is a path+hash of this app (relative) or an already-validated absolute URL. */
export function leave(to: string, clear: boolean): Response {
  const response = redirectHere(to)
  response.headers.set("Referrer-Policy", "no-referrer")
  if (clear) clearCookies(response)
  return response
}
