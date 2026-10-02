import type { NextRequest } from "next/server"
import {
  callApi,
  fromOwnPage,
  json,
  normalise,
  readEntries,
  writeEntries,
} from "../../../_lib/devices-server"

/**
 * After a real sign-in: let this browser bring the account back later (#192).
 *
 * The page sends its fresh Clerk session token; the API checks it and binds
 * the row to that session, so it can later tell "expired" from "signed out".
 * Every entry the cookie already holds goes along as `prior`, and the API
 * reuses the one belonging to this account rather than piling up rows.
 */
export async function POST(request: NextRequest) {
  if (!fromOwnPage(request)) return json({ ok: false }, 403)

  const authorization = request.headers.get("authorization")
  const body = (await request.json().catch(() => null)) as { email?: unknown } | null
  if (!authorization || typeof body?.email !== "string") return json({ ok: false }, 400)

  const email = normalise(body.email)
  const entries = readEntries(request)

  let upstream: Response
  try {
    upstream = await callApi(
      "/devices/remember",
      { prior: entries.map(({ id, s }) => ({ id, secret: s })) },
      { authorization },
    )
  } catch {
    return json({ ok: false }, 503)
  }
  if (!upstream.ok) return json({ ok: false }, upstream.status === 401 ? 401 : 503)

  const device = (await upstream.json()) as { id: string; secret: string }
  const response = json({ ok: true })
  // Most recent first, one entry per account and per row.
  writeEntries(response, [
    { e: email, id: device.id, s: device.secret },
    ...entries.filter((entry) => entry.e !== email && entry.id !== device.id),
  ])
  return response
}
