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
 * The card's × (#192): forget the account here AND kill its row, so a copy of
 * this cookie taken earlier stops working too.
 *
 * ⚠ THE COOKIE ENTRY GOES EVEN IF THE API IS DOWN. The person asked for this
 * browser to forget; the row then just ages out on its own.
 */
export async function POST(request: NextRequest) {
  if (!fromOwnPage(request)) return json({ ok: false }, 403)

  const body = (await request.json().catch(() => null)) as { email?: unknown } | null
  if (typeof body?.email !== "string") return json({ ok: false }, 400)

  const email = normalise(body.email)
  const entries = readEntries(request)
  const entry = entries.find((candidate) => candidate.e === email)

  if (entry) {
    await callApi("/devices/forget", { id: entry.id, secret: entry.s }).catch(
      () => null,
    )
  }

  const response = json({ ok: true })
  writeEntries(
    response,
    entries.filter((candidate) => candidate !== entry),
  )
  return response
}
