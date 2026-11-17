/*
 * A mailbox's finished export, as a download (U7).
 *
 * ⚠ A ROUTE HANDLER, NOT THE `download_url` THE STATUS ROUTE HANDS OUT. That
 * link points at the API's own origin, which the browser is never told (the
 * console reaches the API only from the server, in-cluster), and it would
 * go to a host that sends no CORS headers. So the browser downloads from here
 * and this forwards the session, as `suppressions/export` does. The API's route
 * accepts the signed-in session of anyone who may export the mailbox, so the
 * signed link is not needed and no token is ever put in a page.
 *
 * ⚠ THE BODY IS STREAMED, NEVER BUFFERED. An export is as big as the mailbox,
 * gigabytes at the top end, and the API already opens it one chunk at a time
 * (mailboxes/sealed-stream.ts); holding it here would put it in this pod's
 * memory (512 MiB). `content-length` and `content-disposition` are the API's:
 * the first is the plain archive's length, so the browser shows real progress,
 * and the second names the file after the mailbox.
 *
 * ⚠ WHO MAY IS THE API'S ANSWER, NOT THIS FILE'S. A person who may not export
 * this mailbox gets its 403 here, said in words, and nothing is downloaded.
 */

import { auth } from "@clerk/nextjs/server"
import { PREVIEW } from "@/lib/preview"

const API = process.env.I10_BASE_URL ?? "https://api.i10.tech"

const text = (message: string, status: number) =>
  new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  })

/** The address as the person's browser sent it, however the framework hands the segment over. */
function addressFrom(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ address: string }> },
) {
  const address = addressFrom((await params).address)

  // ⚠ AN ADDRESS HAS AN `@`. Checked before it goes into a path: `..` is an
  // address with no `@`, and `new URL` would walk it out of /mailboxes/.
  if (!address.includes("@") || /[\s/?#\\]/.test(address)) {
    return text("That is not a mailbox address.", 400)
  }

  // ⚠ FOLDED TO `false` IN A PRODUCTION BUILD - see lib/preview.ts.
  if (PREVIEW) {
    return new Response("preview export\n", {
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="${address.replace(/[^a-z0-9@._-]/gi, "_")}-export.tar.gz"`,
        "Cache-Control": "no-store",
      },
    })
  }

  const token = await (await auth()).getToken()
  if (!token) return text("Your session has expired. Sign in again.", 401)

  const upstream = await fetch(
    `${API}/mailboxes/${encodeURIComponent(address)}/export/download`,
    { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" },
  )

  if (!upstream.ok || !upstream.body) {
    switch (upstream.status) {
      case 401:
        return text("Your session has expired. Sign in again.", 401)
      case 403:
        return text(
          "Only the mailbox's owner or a workspace admin can download this.",
          403,
        )
      case 404:
        return text("There is no finished export of this mailbox.", 404)
      case 410:
        return text("That export has expired. Start a new one.", 410)
      default:
        return text("Could not download the export. Try again in a minute.", 502)
    }
  }

  const headers = new Headers({
    "Content-Type": "application/gzip",
    "Cache-Control": "no-store",
  })
  for (const name of ["content-length", "content-disposition"]) {
    const value = upstream.headers.get(name)
    if (value) headers.set(name, value)
  }
  return new Response(upstream.body, { headers })
}
