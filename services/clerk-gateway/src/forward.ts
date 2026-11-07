import type { Config } from "./config.js"

/**
 * Clerk's Frontend API proxy contract, applied to one allowed request.
 *
 * Confirmed against Clerk's own implementation, `clerkFrontendApiProxy` in
 * @clerk/backend 3.17.1 (dist/proxy.mjs), and the guide at
 * clerk.com/docs/guides/dashboard/dns-domains/proxy-fapi:
 *
 * - forward method, path, query and body to the FAPI origin, `redirect: manual`;
 * - add `Clerk-Proxy-Url` (the proxy's public URL) and `Clerk-Secret-Key`;
 * - `X-Forwarded-For` carries the end user's IP as its FIRST value, taken from
 *   the CDN's own header (`CF-Connecting-IP`), never from an incoming
 *   `X-Forwarded-For`, which the client controls;
 * - strip hop-by-hop headers both ways, append every `Set-Cookie`;
 * - a `Location` that points at the FAPI origin itself is rewritten onto the
 *   proxy (proxy.mjs lines 196-206), so a redirect can never leave the gateway.
 *   Every other `Location` - our apps, Google, GitHub - is passed untouched.
 */

/** RFC 9110 7.6.1, plus the ones Clerk's proxy strips (proxy.mjs line 15). */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

/**
 * ⚠ NOTHING THE CLIENT SENDS MAY SPEAK FOR THE GATEWAY. These are either ours
 * to set (the Clerk headers, the forwarding chain) or Cloudflare's view of the
 * client, which we restate in `X-Forwarded-For` rather than pass along.
 */
const NEVER_FORWARDED = new Set([
  "host",
  "content-length",
  "clerk-secret-key",
  "clerk-proxy-url",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "forwarded",
  "x-real-ip",
  "true-client-ip",
  // ⚠ OUR EDGE SECRET (#345). The Transform Rule is not meant to cover this host,
  // but if it ever does, Clerk must never be sent a credential of ours.
  "x-i10-edge",
  "cf-connecting-ip",
  "cf-connecting-ipv6",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cf-worker",
  "cf-ew-via",
])

function connectionListed(headers: Headers): Set<string> {
  return new Set(
    (headers.get("connection") ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  )
}

/**
 * The browser's address, from Cloudflare.
 *
 * ⚠ VALIDATED BEFORE IT GOES INTO A HEADER. It is Cloudflare's to set and the
 * edge overwrites any client copy, but a value with a comma or a space would
 * add hops to the chain Clerk reads, so anything that is not plainly one
 * address is dropped instead.
 */
export function clientIp(headers: Headers): string | null {
  const ip = headers.get("cf-connecting-ip")?.trim() ?? ""
  return /^[0-9A-Fa-f:.]{2,45}$/.test(ip) ? ip : null
}

export function upstreamHeaders(incoming: Headers, config: Config): Headers {
  const listed = connectionListed(incoming)
  const out = new Headers()
  incoming.forEach((value, key) => {
    const name = key.toLowerCase()
    if (HOP_BY_HOP.has(name) || listed.has(name) || NEVER_FORWARDED.has(name)) return
    out.set(key, value)
  })
  out.set("Clerk-Proxy-Url", config.proxyUrl)
  out.set("Clerk-Secret-Key", config.secretKey)
  out.set("X-Forwarded-Host", config.proxyHost)
  out.set("X-Forwarded-Proto", config.proxyProto)
  const ip = clientIp(incoming)
  if (ip) out.set("X-Forwarded-For", ip)
  return out
}

export function upstreamUrl(rawPath: string, search: string, config: Config): string {
  const query = search && !search.startsWith("?") ? `?${search}` : search
  return `${config.upstreamOrigin}${rawPath}${query}`
}

/** Does the client's `Accept-Encoding` admit this content coding? */
export function accepts(acceptEncoding: string | null, coding: string): boolean {
  for (const part of (acceptEncoding ?? "").split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";")
    if (name !== coding && name !== "*") continue
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="))
    if (!q || Number(q.slice(2)) > 0) return true
  }
  return false
}

/** Clerk's answer, as Clerk gave it, minus hop-by-hop headers. */
export function passThrough(
  upstream: Response,
  config: Config,
  acceptEncoding: string | null,
): Response {
  const listed = connectionListed(upstream.headers)
  const headers = new Headers()
  upstream.headers.forEach((value, key) => {
    const name = key.toLowerCase()
    if (name === "set-cookie" || HOP_BY_HOP.has(name) || listed.has(name)) return
    headers.set(key, value)
  })
  /*
   * ⚠ `getSetCookie()`, NOT `get("set-cookie")`. `get` joins several cookies
   * into one comma-separated string, which a browser reads as ONE cookie with
   * a mangled value - and sign-in sets `__client`, `__client_uat` and the
   * session cookies in the same response.
   */
  for (const cookie of upstream.headers.getSetCookie())
    headers.append("Set-Cookie", cookie)

  const location = upstream.headers.get("location")
  if (location) {
    try {
      const target = new URL(location, config.upstreamOrigin)
      if (target.host === config.upstreamHost) {
        headers.set(
          "Location",
          `${config.proxyUrl}${target.pathname}${target.search}${target.hash}`,
        )
      }
    } catch {
      // Not a URL we can parse: leave it exactly as Clerk sent it.
    }
  }

  /*
   * ⚠ THE BODY ARRIVES DECODED, AND THE HEADER DECIDES HOW IT LEAVES. The
   * Workers runtime decompresses an upstream body as it reads it, then
   * compresses our response according to its `Content-Encoding`. Clerk answers
   * brotli to the runtime's own `Accept-Encoding`, so passing that header on to
   * a client that never asked for brotli would hand it bytes it cannot read
   * (seen with plain curl through `wrangler dev`). Drop the coding when the
   * client did not accept it, and its length with it; the runtime then sends
   * the body as is. Clerk's own proxy always drops both (proxy.mjs line 34).
   */
  const coding = headers.get("content-encoding")?.trim().toLowerCase()
  if (coding && coding !== "identity" && !accepts(acceptEncoding, coding)) {
    headers.delete("content-encoding")
    headers.delete("content-length")
  }

  const empty =
    upstream.status === 204 || upstream.status === 205 || upstream.status === 304
  return new Response(empty ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  })
}
