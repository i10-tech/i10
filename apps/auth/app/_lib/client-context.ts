import "server-only"
import { createHmac } from "node:crypto"
import { headers } from "next/headers"

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
 * Never throws, and null without the secret or outside a request: the API
 * then simply cannot tell browsers apart and skips its per-address limit.
 */
export async function clientContextHeader(): Promise<string | null> {
  const secret = process.env.CLIENT_CONTEXT_SECRET?.trim()
  if (!secret) return null
  try {
    const h = await headers()
    const ip = h.get("cf-connecting-ip")
    if (!ip) return null
    const ctx = {
      ip,
      country: h.get("cf-ipcountry") ?? undefined,
      ua: h.get("user-agent")?.slice(0, 200) ?? undefined,
      ts: Date.now(),
    }
    const payload = Buffer.from(JSON.stringify(ctx)).toString("base64url")
    const sig = createHmac("sha256", secret).update(payload).digest("base64url")
    return `${payload}.${sig}`
  } catch {
    return null
  }
}
