import type { NextRequest } from "next/server"
import { callApi, fromOwnPage, json } from "../../../_lib/devices-server"
import { clearCookies, HANDOFF_COOKIE, readCookie } from "../../../_lib/sso-server"

/**
 * After `signIn.ticket()`: the new session, with the handoff secret, becomes
 * a bound SSO session (#337). The page sends its new session token; the
 * secret comes from the cookie the handoff set.
 *
 * ⚠ BOTH COOKIES ARE CLEARED WHATEVER THE ANSWER. A bind is attempted once;
 * a failed one means starting again, with a fresh binding.
 */
export async function POST(request: NextRequest) {
  if (!fromOwnPage(request)) return json({ message: "Not allowed." }, 403)
  const authorization = request.headers.get("authorization") ?? ""
  const handoff = readCookie(request, HANDOFF_COOKIE)
  if (!authorization.startsWith("Bearer ") || !handoff)
    return json({ message: "This sign-in has expired. Start again." }, 409)
  let response: Response
  try {
    const upstream = await callApi("/sso/bind", { handoff }, { authorization })
    const answer = (await upstream.json()) as {
      returnTo?: string | null
      message?: string
    }
    response = upstream.ok
      ? json({ returnTo: answer.returnTo ?? null })
      : json({ message: answer.message ?? "We could not finish signing you in." }, 409)
  } catch {
    response = json(
      { message: "Sign-in is temporarily unavailable. Try again in a moment." },
      503,
    )
  }
  clearCookies(response)
  return response
}
