import "server-only"
import type { NextRequest } from "next/server"
import { SAVED_LIMIT } from "./remembered-cookie"

/**
 * The device secrets behind the saved-account cards (#192), server side.
 *
 * The cards themselves live in `localStorage` and hold no credential - see
 * ./remembered.ts. What lets a card sign somebody straight back in is this
 * cookie: one entry per saved account, each the id of a row in the API's
 * `core.remembered_devices` and that row's current secret.
 *
 * ⚠ httpOnly, `__Host-`, SameSite=Strict. No script on this origin can read
 * it, no other subdomain can set or overwrite it, and no other site can make
 * the browser send it. It is worth a password, so it gets every restriction a
 * cookie can carry.
 *
 * ⚠ KEYED BY ADDRESS, BECAUSE THE CARD ONLY KNOWS ITS ADDRESS. The address is
 * how a press finds its entry; it proves nothing. The secret does, and the API
 * checks it against the row, so a hand-edited address only mislabels the
 * editor's own browser.
 */

export const DEVICES_COOKIE = "__Host-i10_devices"

/** A little longer than the API's 30-day idle lifetime; the row is the authority. */
const COOKIE_MAX_AGE = 60 * 60 * 24 * 45

export interface DeviceEntry {
  /** Lower-cased address, matching the card. */
  e: string
  id: string
  s: string
}

export function readEntries(request: NextRequest): DeviceEntry[] {
  const raw = request.cookies.get(DEVICES_COOKIE)?.value
  if (!raw) return []
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"))
    if (!Array.isArray(value)) return []
    return value
      .filter(
        (item): item is DeviceEntry =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as DeviceEntry).e === "string" &&
          typeof (item as DeviceEntry).id === "string" &&
          typeof (item as DeviceEntry).s === "string",
      )
      .slice(0, SAVED_LIMIT)
  } catch {
    return []
  }
}

export function writeEntries(response: Response, entries: DeviceEntry[]): void {
  const kept = entries.slice(0, SAVED_LIMIT)
  const value = kept.length
    ? Buffer.from(JSON.stringify(kept), "utf8").toString("base64url")
    : ""
  const age = kept.length ? COOKIE_MAX_AGE : 0
  response.headers.append(
    "Set-Cookie",
    `${DEVICES_COOKIE}=${value}; Path=/; Max-Age=${age}; HttpOnly; Secure; SameSite=Strict`,
  )
}

export const normalise = (email: string) => email.trim().toLowerCase()

/**
 * Only this origin's own pages may call these routes.
 *
 * ⚠ SameSite=Strict ALREADY KEEPS THE COOKIE OFF CROSS-SITE REQUESTS; this
 * also refuses a same-site neighbour (another i10.tech subdomain), which
 * SameSite counts as the same site. `Sec-Fetch-Site` is set by the browser and
 * cannot be written by page script.
 */
export function fromOwnPage(request: NextRequest): boolean {
  return request.headers.get("sec-fetch-site") === "same-origin"
}

/** See apps/console/lib/api.ts for why this is read per call and has no prod default. */
function apiBase(): string {
  const configured = process.env.API_BASE_URL?.trim()
  if (configured) return configured.replace(/\/$/, "")
  if (process.env.NODE_ENV === "production") throw new Error("API_BASE_URL is not set")
  return "http://localhost:3001"
}

export async function callApi(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${apiBase()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(5000),
  })
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } })
}
