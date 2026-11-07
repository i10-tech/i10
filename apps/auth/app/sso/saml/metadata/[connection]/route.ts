import type { NextRequest } from "next/server"
import { getApi } from "../../../../_lib/devices-server"
import { connectionOf } from "../../../../_lib/saml-server"

export const dynamic = "force-dynamic"

/**
 * `GET /sso/saml/metadata/<connection id>` (#339): our SP metadata, which is
 * also our SP entity id. Served here so everything an IdP is told about us is
 * on the auth origin; the API decides what is in it (public certificates only).
 *
 * ⚠ PUBLIC AND READ-ONLY, like `/sso/jwks/<id>`: an IdP's metadata fetcher is
 * the caller, and it starts nothing.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ connection: string }> },
) {
  const connection = connectionOf((await params).connection)
  if (!connection) return Response.json({ message: "Not found." }, { status: 404 })
  try {
    const upstream = await getApi(`/sso/saml/metadata/${connection}`)
    if (!upstream.ok)
      return Response.json(
        { message: upstream.status === 404 ? "Not found." : "Try again in a moment." },
        { status: upstream.status === 404 ? 404 : 503 },
      )
    return new Response(await upstream.text(), {
      headers: {
        "content-type": "application/samlmetadata+xml; charset=utf-8",
        "cache-control": "public, max-age=300",
      },
    })
  } catch {
    return Response.json({ message: "Try again in a moment." }, { status: 503 })
  }
}
