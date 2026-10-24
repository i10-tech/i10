import type { NextRequest } from "next/server"

export const dynamic = "force-dynamic"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * `GET /sso/<connection id>` (#340): the link an admin gives their team, which
 * starts that connection's sign-in directly. It hands over to `/sso/start`,
 * which holds the checks (a fresh binding every time, and nothing started from
 * another site); this only turns a tidy URL into that one.
 *
 * ⚠ THE STATIC ROUTES UNDER /sso (start, test, callback...) WIN OVER THIS
 * DYNAMIC ONE, so it can only ever be reached with something shaped like an id.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ connection: string }> },
) {
  const { connection } = await params
  if (!UUID.test(connection)) return new Response("Not found.", { status: 404 })
  const url = new URL("/sso/start", request.url)
  url.searchParams.set("connection", connection)
  const redirect = request.nextUrl.searchParams.get("redirect_url")
  if (redirect) url.searchParams.set("redirect_url", redirect)
  return Response.redirect(url, 303)
}
