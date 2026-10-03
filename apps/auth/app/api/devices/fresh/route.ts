import type { NextRequest } from "next/server"
import { callApi, fromOwnPage, json } from "../../../_lib/devices-server"

/**
 * Just signed up: a one-time sign-in token for a session Clerk counts as
 * freshly verified. See `freshAfterSignUp` in apps/api/src/devices/resume.ts
 * for why, and for the age limit the API enforces.
 */
export async function POST(request: NextRequest) {
  if (!fromOwnPage(request)) return json({ outcome: "refused" }, 403)

  const authorization = request.headers.get("authorization")
  if (!authorization) return json({ outcome: "refused" }, 400)

  try {
    const upstream = await callApi("/devices/fresh", {}, { authorization })
    if (!upstream.ok) return json({ outcome: "refused" })
    return json(await upstream.json())
  } catch {
    return json({ outcome: "refused" })
  }
}
