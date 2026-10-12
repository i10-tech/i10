import type { NextRequest } from "next/server"
import {
  callApi,
  fromOwnPage,
  json,
  readEntries,
  writeEntries,
} from "../../../_lib/devices-server"

/**
 * Which saved accounts no longer exist (2026-10-12), so the sign-in page can
 * clear their cards - somebody who deletes their account is signed out onto
 * this page, where its card was still waiting.
 *
 * ⚠ ONLY ACCOUNTS THIS BROWSER HOLDS A SECRET FOR. The API answers for the
 * devices presented and nothing else, so this is no way to ask whether an
 * address has an account. See `goneDevices` in the API.
 *
 * ⚠ ANY FAILURE KEEPS EVERY CARD: `{ gone: [] }`. An outage must never read
 * as "these accounts are gone".
 */
export async function POST(request: NextRequest) {
  if (!fromOwnPage(request)) return json({ gone: [] }, 403)

  const entries = readEntries(request)
  if (entries.length === 0) return json({ gone: [] })

  let gone: string[]
  try {
    const upstream = await callApi("/devices/check", {
      devices: entries.map((entry) => ({ id: entry.id, secret: entry.s })),
    })
    if (!upstream.ok) return json({ gone: [] })
    const answer = (await upstream.json()) as { gone?: unknown }
    gone = Array.isArray(answer.gone)
      ? answer.gone.filter((id): id is string => typeof id === "string")
      : []
  } catch {
    return json({ gone: [] })
  }

  const dead = entries.filter((entry) => gone.includes(entry.id))
  const response = json({ gone: dead.map((entry) => entry.e) })
  if (dead.length > 0) {
    writeEntries(
      response,
      entries.filter((entry) => !dead.includes(entry)),
    )
  }
  return response
}
