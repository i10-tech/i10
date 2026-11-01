import { createHmac, timingSafeEqual } from "node:crypto"

/**
 * The proof a request came through OUR Cloudflare zone, and the signed client
 * context built only on top of it (#345).
 *
 * ⚠ THE SAME CHECK AS apps/api/src/identity/edge.ts AND apps/auth/app/_lib/
 * edge-context.ts. Keep the three identical. `cf-connecting-ip` is only as true
 * as the path it arrived by, and the origin answers the internet directly, so
 * it is believed only alongside `x-i10-edge` equal to EDGE_SECRET. A context
 * the API will trust is never signed for an address that was not proven.
 *
 * ⚠ NEVER LOG THE HEADER OR THE SECRET.
 */
export const EDGE_HEADER = "x-i10-edge"

type Reader = { get(name: string): string | null }

/** Constant-time compare; a different length is a mismatch, never a throw. */
export function viaEdge(h: Reader, edgeSecret: string | undefined): boolean {
  const secret = edgeSecret?.trim()
  const got = h.get(EDGE_HEADER)?.trim()
  if (!secret || !got) return false
  const a = Buffer.from(got)
  const b = Buffer.from(secret)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** A `cf-*` header's value, or null unless the request came through the edge. */
export function edgeHeader(
  h: Reader,
  name: string,
  edgeSecret: string | undefined,
): string | null {
  return viaEdge(h, edgeSecret) ? h.get(name)?.trim() || null : null
}

/**
 * `payload.signature` for the API's `x-i10-client` header, or null when the
 * address cannot be proven. `extra` is what the caller adds (timezone, device).
 */
export function signedContext(
  h: Reader,
  secrets: { context: string; edge: string | undefined },
  extra: { lang?: string; tz?: string; device?: string } = {},
): string | null {
  const ip = edgeHeader(h, "cf-connecting-ip", secrets.edge)
  if (!ip) return null
  const ctx = {
    ip,
    country: edgeHeader(h, "cf-ipcountry", secrets.edge) ?? undefined,
    ua: h.get("user-agent")?.slice(0, 200) ?? undefined,
    lang: extra.lang ?? h.get("accept-language")?.split(",")[0] ?? undefined,
    tz: extra.tz,
    device: extra.device,
    ts: Date.now(),
  }
  const payload = Buffer.from(JSON.stringify(ctx)).toString("base64url")
  const sig = createHmac("sha256", secrets.context).update(payload).digest("base64url")
  return `${payload}.${sig}`
}
