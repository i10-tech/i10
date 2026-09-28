/*
 * The suppression list as a CSV download (#159).
 *
 * ⚠ A ROUTE HANDLER, NOT A LINK TO THE API. The API authenticates the console
 * with the Clerk session JWT in an `Authorization` header, which a plain link
 * cannot carry and a cookie never reaches - api.i10.tech is another origin. So
 * the browser downloads from here and this forwards the session, the same
 * shape as the checkout-status proxy.
 *
 * ⚠ THE BODY IS PASSED THROUGH, NOT PARSED. The API already quotes every field
 * and defuses spreadsheet formulas (see `suppressionsCsv`); re-serialising it
 * here would be a second place for that rule to be got wrong.
 */

import { auth } from "@clerk/nextjs/server"
import { PREVIEW } from "@/lib/preview"

const API = process.env.I10_BASE_URL ?? "https://api.i10.tech"

const HEADERS = {
  "Content-Type": "text/csv; charset=utf-8",
  "Content-Disposition": 'attachment; filename="suppressions.csv"',
  "Cache-Control": "no-store",
}

export async function GET() {
  // ⚠ FOLDED TO `false` IN A PRODUCTION BUILD - see lib/preview.ts.
  if (PREVIEW) {
    return new Response(
      '"address","reason","message_id","created_at"\r\n' +
        '"bounced+0@example.com","hard_bounce","","2026-09-20T12:00:00.000Z"\r\n',
      { headers: HEADERS },
    )
  }

  const token = await (await auth()).getToken()
  if (!token)
    return new Response("Your session has expired. Sign in again.", { status: 401 })

  const upstream = await fetch(`${API}/console/suppressions/export.csv`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  })
  if (!upstream.ok) {
    return new Response("Could not export the suppression list. Try again.", {
      status: upstream.status === 401 ? 401 : 502,
    })
  }
  return new Response(upstream.body, { headers: HEADERS })
}
