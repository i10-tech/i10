/*
 * Where the link in our invitation email lands (#327).
 *
 * ⚠ THE CLOCK IS CHECKED BEFORE CLERK SEES THE PERSON. The API answers with
 * Clerk's own accept link while the invitation is in time; past the admin's
 * expiry it revokes the invitation there and then, and the person is told it
 * ended instead of being let in by Clerk's whole-day bound.
 *
 * ⚠ PUBLIC, LIKE `/api/checkout-status`: the person opening it may have no
 * account yet. It carries no credential and the API answers only about the
 * one invitation the id names.
 */

const API = process.env.I10_BASE_URL ?? "https://api.i10.tech"

/** Our invitation ids are UUIDs; checked before they reach a path. */
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const ended = (reason: string) =>
    Response.redirect(new URL(`/invite/ended?reason=${reason}`, request.url), 303)
  if (!ID.test(id)) return ended("missing")
  try {
    const upstream = await fetch(`${API}/invitation-links/${id}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    })
    const body = (await upstream.json()) as { outcome?: string; url?: string }
    // ⚠ ONLY AN HTTPS LINK, which is all Clerk ever hands out.
    if (body.outcome === "open" && body.url?.startsWith("https://"))
      return Response.redirect(body.url, 303)
    return ended(
      body.outcome === "expired" || body.outcome === "full" ? body.outcome : "ended",
    )
  } catch {
    return ended("unavailable")
  }
}
