import type { NextRequest } from "next/server"
import { callApi, fromOwnPage, json } from "../../../_lib/devices-server"
import { BINDING_COOKIE, handoffCookie, readCookie } from "../../../_lib/sso-server"

/**
 * The continue page swaps its one-time code for a Clerk ticket (#337).
 *
 * ⚠ THE HANDOFF SECRET GOES STRAIGHT INTO AN httpOnly COOKIE; the page gets
 * the sixty-second ticket and nothing else, as with saved accounts.
 */
export async function POST(request: NextRequest) {
  if (!fromOwnPage(request)) return json({ message: "Not allowed." }, 403)
  const binding = readCookie(request, BINDING_COOKIE)
  if (!binding) return json({ message: "This sign-in has expired. Start again." }, 409)
  const body = (await request.json().catch(() => null)) as { code?: unknown } | null
  try {
    const upstream = await callApi("/sso/handoff", { code: body?.code, binding })
    const answer = (await upstream.json()) as {
      ticket?: string
      handoff?: string
      message?: string
    }
    if (!upstream.ok || !answer.ticket || !answer.handoff)
      return json(
        { message: answer.message ?? "This sign-in has expired. Start again." },
        409,
      )
    const response = json({ ticket: answer.ticket })
    response.headers.append("Set-Cookie", handoffCookie(answer.handoff))
    return response
  } catch {
    return json(
      { message: "Sign-in is temporarily unavailable. Try again in a moment." },
      503,
    )
  }
}
