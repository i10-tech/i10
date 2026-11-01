import "server-only"
import { cookies, headers } from "next/headers"
import { signedContext } from "./edge-context"

/**
 * What the console tells the API about the person behind a request (#170).
 *
 * ⚠ THE API CANNOT SEE IT ON ITS OWN. The console calls the API in-cluster, so
 * the API's socket is the console's pod, never the browser. Cloudflare's
 * headers on the BROWSER's request to the console carry the real IP and
 * country; the page itself contributes a timezone and a device id through the
 * `i10_ctx` cookie (components/client-context.tsx).
 *
 * ⚠ ONLY AN ADDRESS WE CAN PROVE. The origin answers the internet directly, so
 * Cloudflare's headers are believed only with `x-i10-edge` equal to EDGE_SECRET
 * (edge-context.ts); without it nothing is signed.
 *
 * ⚠ SIGNED, OR NOT SENT. The payload is HMAC-signed with
 * `CLIENT_CONTEXT_SECRET`, shared with the API, which refuses an unsigned or
 * stale header rather than trusting one anybody could set. Without the secret
 * this returns null and the risk engine simply sees less.
 *
 * ⚠ IT NEVER THROWS. Outside a request (a build, a static render) `headers()`
 * is unavailable; that is not a reason to fail an API call.
 */
export async function clientContextHeader(): Promise<string | null> {
  const secret = process.env.CLIENT_CONTEXT_SECRET?.trim()
  if (!secret) return null
  try {
    const h = await headers()
    const c = await cookies()
    let device: { tz?: string; device?: string; lang?: string } = {}
    const raw = c.get("i10_ctx")?.value
    if (raw) {
      try {
        device = JSON.parse(decodeURIComponent(raw)) as typeof device
      } catch {
        device = {}
      }
    }
    return signedContext(
      h,
      { context: secret, edge: process.env.EDGE_SECRET },
      {
        ...(typeof device.lang === "string" ? { lang: device.lang } : {}),
        ...(typeof device.tz === "string" ? { tz: device.tz.slice(0, 64) } : {}),
        ...(typeof device.device === "string"
          ? { device: device.device.slice(0, 64) }
          : {}),
      },
    )
  } catch {
    return null
  }
}
