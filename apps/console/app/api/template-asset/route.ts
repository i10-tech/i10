/*
 * A remote image, web font or stylesheet an email names, fetched by the API on
 * the console's behalf, for the template thumbnails' snapshots (#248).
 *
 * ⚠ A ROUTE HANDLER FOR THE SAME REASON AS THE CSV EXPORT: the API wants the
 * Clerk session JWT in a header, which an `fetch` from the page cannot carry
 * across origins. This forwards the session and streams the answer back; the
 * API decides everything (what may be fetched, what the bytes are, the headers).
 *
 * ⚠ PREVIEW MODE ANSWERS 404. Its fixtures name no remote assets, and a 404 is
 * what the snapshot builder treats as "keep the box, drop the font".
 */

import { auth } from "@clerk/nextjs/server"
import { PREVIEW } from "@/lib/preview"

const API = process.env.I10_BASE_URL ?? "https://api.i10.tech"

const NOT_FOUND = () => new Response(null, { status: 404 })

/** What the API sets on a served asset, passed on as it is. */
const PASSED = [
  "content-type",
  "x-content-type-options",
  "content-security-policy",
  "cache-control",
]

export async function GET(request: Request) {
  if (PREVIEW) return NOT_FOUND()

  const { searchParams } = new URL(request.url)
  const u = searchParams.get("u")
  if (!u) return new Response(null, { status: 400 })

  const token = await (await auth()).getToken()
  if (!token) return new Response(null, { status: 401 })

  const query = new URLSearchParams({ u })
  if (searchParams.get("as") === "css") query.set("as", "css")

  let upstream: Response
  try {
    upstream = await fetch(`${API}/console/template-assets/proxy?${query}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  } catch {
    return new Response(null, { status: 502 })
  }
  if (!upstream.ok) {
    // The API's reason is a sentence for a person; the builder wants a status.
    void upstream.body?.cancel().catch(() => {})
    const headers = new Headers()
    if (upstream.status === 429) {
      // The client waits this long before asking again.
      const retryAfter = upstream.headers.get("retry-after")
      if (retryAfter) headers.set("Retry-After", retryAfter)
      headers.set("Cache-Control", "no-store")
    }
    return new Response(null, { status: upstream.status, headers })
  }

  const headers = new Headers()
  for (const name of PASSED) {
    const value = upstream.headers.get(name)
    if (value) headers.set(name, value)
  }
  return new Response(upstream.body, { headers })
}
