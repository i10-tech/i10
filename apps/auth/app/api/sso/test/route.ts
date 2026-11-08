import type { NextRequest } from "next/server"
import { callApi, fromOwnPage, json } from "../../../_lib/devices-server"
import { BINDING_COOKIE, readCookie } from "../../../_lib/sso-server"

/**
 * The TEST engine's "IdP" (#337): the dev page posts a subject and email, and
 * this adds the binding cookie and asks the API to finish the sign-in.
 *
 * ⚠ THE API IS THE GATE, NOT THIS FILE. `POST /sso/test/assert` is a 404
 * unless the API runs with `IDENTITY_TEST_ENGINE=on`, which env.ts refuses in
 * production and against a live Clerk instance. This route is also closed in a
 * production build, so it is not even reachable there.
 */
export async function POST(request: NextRequest) {
  if (process.env.NODE_ENV === "production") return json({ message: "Not found." }, 404)
  if (!fromOwnPage(request)) return json({ message: "Not allowed." }, 403)
  const binding = readCookie(request, BINDING_COOKIE)
  if (!binding) return json({ message: "This sign-in has expired. Start again." }, 409)
  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null
  try {
    const upstream = await callApi("/sso/test/assert", {
      state: body?.state,
      subject: body?.subject,
      email: body?.email,
      amr: Array.isArray(body?.amr) ? body.amr : undefined,
      binding,
    })
    const answer = (await upstream.json()) as Record<string, unknown>
    return json(answer, upstream.status)
  } catch {
    return json(
      { message: "Sign-in is temporarily unavailable. Try again in a moment." },
      503,
    )
  }
}
