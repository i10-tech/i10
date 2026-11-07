import type { NextRequest } from "next/server"
import { getApi } from "../../../_lib/devices-server"

export const dynamic = "force-dynamic"

/**
 * `GET /sso/jwks/<connection id>` (#338): the public keys an IdP fetches to
 * check a private_key_jwt connection's client assertions. Served here so that
 * everything an IdP is told about us (this, and `/sso/callback`) is on the
 * auth origin; the API decides what is in it.
 *
 * ⚠ PUBLIC AND READ-ONLY, so no `startedByUs` or `fromOwnPage`: an IdP's
 * server is the caller, and it starts nothing.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ connection: string }> },
) {
  const { connection } = await params
  if (!/^[0-9a-f-]{36}$/i.test(connection))
    return Response.json({ message: "Not found." }, { status: 404 })
  try {
    const upstream = await getApi(`/sso/oidc/jwks/${connection}`)
    if (!upstream.ok)
      return Response.json(
        { message: upstream.status === 404 ? "Not found." : "Try again in a moment." },
        { status: upstream.status === 404 ? 404 : 503 },
      )
    return Response.json(await upstream.json(), {
      headers: { "cache-control": "public, max-age=300" },
    })
  } catch {
    return Response.json({ message: "Try again in a moment." }, { status: 503 })
  }
}
