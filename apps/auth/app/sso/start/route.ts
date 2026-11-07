import type { NextRequest } from "next/server"
import { callApi } from "../../_lib/devices-server"
import { afterAuthUrl } from "../../_lib/redirect"
import { connectionOf } from "../../_lib/saml-server"
import {
  bindingCookie,
  confirmUrl,
  decideSsoEntry,
  failedUrl,
  issWireValue,
  newBinding,
  readIss,
  readLoginHint,
  readStartForm,
  redirectHere,
  samlBindingCookie,
  submittedFromHere,
} from "../../_lib/sso-server"

export const dynamic = "force-dynamic"

/**
 * `GET /sso/start?connection=<id>&redirect_url=<where to>` (#337): where the
 * API's `403 sso_required` sends a managed account, and where "Continue with
 * your company's SSO" points (#340).
 *
 *   - Reached from our own sites (`startedByUs`): starts the attempt and
 *     redirects to the IdP immediately.
 *   - Reached cross-site without our console as `Referer`: redirects to
 *     `/sso/confirm` instead of starting or refusing, so a user click on our
 *     own origin (`POST /sso/start`) authorizes the start.
 *
 * ⚠ A FRESH BINDING EVERY TIME. Starting again replaces the cookie, so an
 * older attempt still in flight can no longer be finished from this browser -
 * the last one started is the only one that counts.
 */
export async function GET(request: NextRequest) {
  const entry = decideSsoEntry(
    request,
    request.nextUrl.searchParams.get("connection"),
    request.nextUrl.searchParams,
  )
  if (entry.action === "invalid") return redirectHere(confirmUrl())
  if (entry.action === "interstitial") return redirectHere(confirmUrl(entry))

  // "Sign in as" on the continue page: the IdP must ask, not reuse its session.
  const fresh = request.nextUrl.searchParams.get("fresh") === "1"
  return beginAttempt({
    connection: entry.connection,
    returnTo: entry.returnTo ?? afterAuthUrl(undefined),
    loginHint: entry.loginHint ?? "",
    iss: entry.iss,
    fresh,
  })
}

/**
 * `POST /sso/start`: submitted by the button on `/sso/confirm`.
 *
 * ⚠ SAME-ORIGIN SUBMISSIONS ONLY (`submittedFromHere`). Cross-site form POSTs
 * are refused outright so another site cannot auto-submit a hidden form to
 * start a sign-in into an attacker-chosen connection.
 */
export async function POST(request: NextRequest) {
  if (!submittedFromHere(request))
    return redirectHere(failedUrl("Start your company's sign-in from i10."))

  const form = await readStartForm(request)
  if (!form) return redirectHere(confirmUrl())
  const connection = connectionOf(form.get("connection") ?? "")
  if (!connection) return redirectHere(confirmUrl())

  const redirects = form.getAll("redirect_url")
  const returnTo = afterAuthUrl(redirects.length === 1 ? redirects[0] : undefined)
  const loginHint = readLoginHint(form.getAll("login_hint")) ?? ""
  const iss = issWireValue(readIss(form.getAll("iss")))

  return beginAttempt({
    connection,
    returnTo,
    loginHint,
    iss,
    fresh: false,
  })
}

async function beginAttempt(input: {
  connection: string
  returnTo: string
  loginHint: string
  iss: string | null
  fresh: boolean
}): Promise<Response> {
  const binding = newBinding()

  let answer: {
    redirectUrl?: string
    message?: string
    protocol?: string
    reason?: string
  }
  try {
    const upstream = await callApi("/sso/attempts", {
      connection: input.connection,
      purpose: "sign_in",
      binding,
      returnTo: input.returnTo,
      loginHint: input.loginHint,
      ...(input.fresh ? { fresh: true } : {}),
      ...(input.iss !== null ? { iss: input.iss } : {}),
    })
    answer = (await upstream.json()) as typeof answer
    if (!upstream.ok || !answer.redirectUrl) {
      if (
        answer.reason === "connection_inactive" ||
        answer.reason === "issuer_mismatch"
      )
        return redirectHere(confirmUrl())
      return redirectHere(
        failedUrl(answer.message ?? "We could not start your company's sign-in."),
      )
    }
  } catch {
    return redirectHere(
      failedUrl("Sign-in is temporarily unavailable. Try again in a moment."),
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
