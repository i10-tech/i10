import "server-only"
import { headers } from "next/headers"
import { signedContext } from "./edge-context"

/**
 * The browser's address and country, for the API (#338's SSO rate limits).
 *
 * ⚠ THE API CANNOT SEE THEM ON ITS OWN. apps/auth calls it in-cluster, so the
 * API's socket is this pod. Cloudflare's headers on the BROWSER's request to
 * us carry the real address; we pass them on as `x-i10-client`, HMAC-signed
 * with `CLIENT_CONTEXT_SECRET` exactly as the console does
 * (apps/console/lib/client-context.ts), so a header anybody could set is never
 * believed.
 *
 * ⚠ ONLY AN ADDRESS WE CAN PROVE: Cloudflare's headers are believed only with
 * `x-i10-edge` equal to EDGE_SECRET (edge-context.ts); without it nothing is
 * signed.
 *
 * Never throws, and null without the secret or outside a request: the API
 * then simply cannot tell browsers apart and skips its per-address limit.
 */
export async function clientContextHeader(): Promise<string | null> {
  const secret = process.env.CLIENT_CONTEXT_SECRET?.trim()
  if (!secret) return null
  try {
    const h = await headers()
    return signedContext(h, { context: secret, edge: process.env.EDGE_SECRET })
  } catch {
    return null
  }
}
