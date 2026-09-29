import {
  CLIENT_HEADER,
  recordSighting,
  verifyClientContext,
  type SightingDeps,
} from "./identity.js"
import { markDirty, type RiskLockRedis } from "./runner.js"

/**
 * Turns a verified console request into a sighting of the person (#170).
 *
 * ⚠ TWO SOURCES, ONE TRUSTED EACH WAY. A console page's request arrives
 * in-cluster from the console's server, carrying the browser's view in the
 * signed `x-i10-client` header. A request that came through Cloudflare
 * directly (somebody calling `/console/*` with their own session) carries
 * Cloudflare's headers, which only Cloudflare can set on that path. Anything
 * else - an unsigned context, a stale one - is not a sighting.
 *
 * ⚠ CLOUDFLARE'S `T1` IS TOR. Its country header says `T1` for a Tor exit,
 * which is both a Tor signal and not a country; it is recorded as the first
 * and never as the second.
 */
export function sessionObserver(
  deps: SightingDeps & {
    secret?: string
    redis: SightingDeps["redis"] & Pick<RiskLockRedis, "sadd">
    log?: SightingDeps["log"]
  },
) {
  return ({
    userId,
    tenantId,
    request,
  }: {
    userId: string
    tenantId: string
    request: Request
  }) => {
    const signed = verifyClientContext(request.headers.get(CLIENT_HEADER), deps.secret)
    const direct = request.headers.get("cf-connecting-ip")
    const ip = signed?.ip ?? direct ?? null
    if (!ip) return
    let country =
      (signed?.country ?? request.headers.get("cf-ipcountry") ?? "").toUpperCase() ||
      null
    const tor = country === "T1"
    if (country === "T1" || country === "XX") country = null

    void recordSighting(
      {
        userId,
        tenantId,
        sessionId: sessionIdOf(request),
        ip,
        country,
        userAgent: signed?.ua ?? request.headers.get("user-agent"),
        deviceId: signed?.device ?? null,
        timezone: signed?.tz ?? null,
        language:
          signed?.lang ?? request.headers.get("accept-language")?.split(",")[0] ?? null,
        torHint: tor,
      },
      deps,
    )
      .then((outcome) => {
        if (outcome !== "duplicate") void markDirty(deps.redis, [tenantId])
      })
      .catch((error: unknown) =>
        deps.log?.warn?.({ err: error, userId }, "could not record a sighting"),
      )
  }
}

/**
 * The Clerk session id (`sid`) of an ALREADY VERIFIED bearer token.
 *
 * ⚠ DECODED, NOT VERIFIED, AND ONLY SAFE BECAUSE `requireTenant` RAN FIRST.
 * It is used to tell one session from another in a sighting, never to decide
 * anything about access.
 */
export function sessionIdOf(request: Request): string | null {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
  const payload = token?.split(".")[1]
  if (!payload) return null
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      sid?: unknown
    }
    return typeof claims.sid === "string" ? claims.sid.slice(0, 64) : null
  } catch {
    return null
  }
}
