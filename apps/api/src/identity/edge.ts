import { timingSafeEqual } from "node:crypto"

/**
 * Whether a request provably came through OUR Cloudflare zone (#345).
 *
 * ⚠ `cf-connecting-ip` AND EVERY OTHER `cf-*` HEADER ARE ONLY AS TRUE AS THE
 * PATH THEY ARRIVED BY. The origin answers on the internet directly (grey-cloud
 * hosts such as mail.i10.tech point at the same box), so anybody can connect
 * to it with `Host: api.i10.tech` and a `cf-connecting-ip` of their choosing.
 * A Cloudflare Transform Rule stamps `x-i10-edge: <EDGE_SECRET>` on proxied
 * requests; only a request carrying it may have its `cf-*` headers believed.
 *
 * ⚠ NO SECRET CONFIGURED MEANS NOTHING IS PROVEN, not everything: the
 * Cloudflare headers are then ignored and the address is unknown.
 *
 * ⚠ NEVER LOG THE HEADER OR THE SECRET.
 */
export const EDGE_HEADER = "x-i10-edge"

/** Constant-time compare; a different length is a mismatch, never a throw. */
export function viaEdge(headers: Headers, edgeSecret: string | undefined): boolean {
  const secret = edgeSecret?.trim()
  const got = headers.get(EDGE_HEADER)?.trim()
  if (!secret || !got) return false
  const a = Buffer.from(got)
  const b = Buffer.from(secret)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** A `cf-*` header's value, or null unless the request came through the edge. */
export function edgeHeader(
  headers: Headers,
  name: string,
  edgeSecret: string | undefined,
): string | null {
  if (!viaEdge(headers, edgeSecret)) return null
  return headers.get(name)?.trim() || null
}
