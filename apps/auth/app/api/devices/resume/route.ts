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
 * A saved account's card was pressed (#192). Answers what the page does next:
 *
 *   { outcome: "ticket", ticket, secondFactor }  sign in with the ticket
 *   { outcome: "passkey" }                       ask for this account's passkey
 *   { outcome: "signin" }                        the ordinary flow
 *
 * ⚠ THE NEW SECRET NEVER REACHES THE PAGE. The API rotates it on every ticket;
 * it goes straight into the httpOnly cookie, and the browser's script only
 * ever sees the single-use, sixty-second ticket.
 */
export async function POST(request: NextRequest) {
  if (!fromOwnPage(request)) return json({ outcome: "signin" }, 403)

  const body = (await request.json().catch(() => null)) as { email?: unknown } | null
  if (typeof body?.email !== "string") return json({ outcome: "signin" }, 400)

  const email = normalise(body.email)
  const entries = readEntries(request)
  const entry = entries.find((candidate) => candidate.e === email)
  if (!entry) return json({ outcome: "signin" })

  let answer:
    | { outcome: "ticket"; ticket: string; secret: string; secondFactor: boolean }
    | { outcome: "passkey" | "signin" | "forget" }
  try {
    const upstream = await callApi("/devices/resume", { id: entry.id, secret: entry.s })
    // ⚠ AN OUTAGE IS THE ORDINARY FLOW, AND THE ENTRY STAYS. See the API's note.
    if (!upstream.ok) return json({ outcome: "signin" })
    answer = (await upstream.json()) as typeof answer
  } catch {
    return json({ outcome: "signin" })
  }

  if (answer.outcome === "ticket") {
    const response = json({
      outcome: "ticket",
      ticket: answer.ticket,
      secondFactor: answer.secondFactor,
    })
    writeEntries(
      response,
      entries.map((candidate) =>
        candidate === entry ? { ...entry, s: answer.secret } : candidate,
      ),
    )
    return response
  }

  if (answer.outcome === "forget") {
    const response = json({ outcome: "signin" })
    writeEntries(
      response,
      entries.filter((candidate) => candidate !== entry),
    )
    return response
  }

  return json({ outcome: answer.outcome })
}
