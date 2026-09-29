import "server-only"
import { createHmac } from "node:crypto"
import { cookies, headers } from "next/headers"

/**
 * What the console tells the API about the person behind a request (#170).
 *
 * ⚠ THE API CANNOT SEE IT ON ITS OWN. The console calls the API in-cluster, so
 * the API's socket is the console's pod, never the browser. Cloudflare's
 * headers on the BROWSER's request to the console carry the real IP and
 * country; the page itself contributes a timezone and a device id through the
 * `i10_ctx` cookie (components/client-context.tsx).
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
    const ip = h.get("cf-connecting-ip")
    if (!ip) return null
    let device: { tz?: string; device?: string; lang?: string } = {}
    const raw = c.get("i10_ctx")?.value
    if (raw) {
      try {
        device = JSON.parse(decodeURIComponent(raw)) as typeof device
      } catch {
        device = {}
      }
    }
    const ctx = {
      ip,
      country: h.get("cf-ipcountry") ?? undefined,
      ua: h.get("user-agent")?.slice(0, 200) ?? undefined,
      lang: device.lang ?? h.get("accept-language")?.split(",")[0] ?? undefined,
      tz: typeof device.tz === "string" ? device.tz.slice(0, 64) : undefined,
      device:
        typeof device.device === "string" ? device.device.slice(0, 64) : undefined,
      ts: Date.now(),
    }
    const payload = Buffer.from(JSON.stringify(ctx)).toString("base64url")
    const sig = createHmac("sha256", secret).update(payload).digest("base64url")
    return `${payload}.${sig}`
  } catch {
    return null
  }
}
