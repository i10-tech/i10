import type { NextRequest } from "next/server"
import { callApi, fromOwnPage, json } from "../../../_lib/devices-server"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Home realm discovery (#340): which SSO, if any, an address signs in through.
 *
 * ⚠ THE API'S ANSWER DEPENDS ON THE ADDRESS'S DOMAIN AND NOTHING ELSE, so this
 * reveals nothing about accounts. Only the three fields the sign-in page draws
 * are passed on, and the connection id is checked to be an id: the start link
 * is built here from it, never taken from the API's `startUrl`.
 *
 * ⚠ A FAILURE IS A 503, NEVER "none". The sign-in page stays on the email step
 * and asks again; reading an outage as "no SSO" would offer a password to
 * somebody whose company requires the provider. (The API's gate still refuses
 * them; this is about not saying the wrong thing first.)
 */
export async function POST(request: NextRequest) {
  if (!fromOwnPage(request)) return json({ message: "Not allowed." }, 403)
  const body = (await request.json().catch(() => null)) as { email?: unknown } | null
  const email = typeof body?.email === "string" ? body.email.trim() : ""
  if (!email || email.length > 320) return json({ message: "Enter your email." }, 422)
  try {
    const upstream = await callApi("/sso/discover", { email })
    if (!upstream.ok) return json({ message: "Try again in a moment." }, 503)
    const answer = (await upstream.json()) as {
      sso?: unknown
      connection?: unknown
      name?: unknown
    }
    if (answer.sso === "none") return json({ sso: "none" })
    if (
      (answer.sso !== "required" && answer.sso !== "available") ||
      typeof answer.connection !== "string" ||
      !UUID.test(answer.connection) ||
      typeof answer.name !== "string"
    )
      return json({ message: "Try again in a moment." }, 503)
    return json({
      sso: answer.sso,
      connection: answer.connection,
      name: answer.name.slice(0, 100),
    })
  } catch {
    return json({ message: "Try again in a moment." }, 503)
  }
}
