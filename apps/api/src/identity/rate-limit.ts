import type { MiddlewareHandler } from "hono"
import { verifyClientContext, CLIENT_HEADER } from "../risk/identity.js"

/**
 * Rate limits on the public SSO routes (#338): every `/sso/*` step a browser
 * drives - starting a sign-in, a test IdP's assertion, an OIDC callback, the
 * handoff swap, the bind.
 *
 * ⚠ PER BROWSER IP, AND THE IP IS ONLY EVER ONE WE CAN TRUST. apps/auth calls
 * these in-cluster, so the API's socket is never the browser: apps/auth sends
 * the browser's address as the signed `x-i10-client` context (risk/
 * identity.ts), and a caller reaching api.i10.tech directly comes through
 * Cloudflare, whose `cf-connecting-ip` the edge sets. When neither is there
 * (local development, or apps/auth without `CLIENT_CONTEXT_SECRET`) the
 * per-IP limit is skipped rather than putting every person into one bucket.
 *
 * ⚠ AND PER CONNECTION FOR STARTS. A sign-in start writes an attempt row; a
 * crowd of addresses starting sign-ins on one connection is capped as a whole,
 * generously enough that a company's Monday morning never meets it.
 *
 * ⚠ REDIS FIRST, THIS PROCESS IF REDIS FAILS - never "no limit", never "no
 * sign-in". The same fallback as the console's code cooldown.
 */

export interface Counter {
  incr(key: string): Promise<number>
  expire(key: string, seconds: number): Promise<number>
}

export interface Limit {
  /** Requests allowed per window. */
  max: number
  windowSeconds: number
}

/** A sign-in is about four calls; this is a dozen sign-ins a minute from one address. */
export const PER_IP: Limit = { max: 60, windowSeconds: 60 }
/** Sign-in starts on one connection, from everybody together. */
export const PER_CONNECTION_STARTS: Limit = { max: 1200, windowSeconds: 60 }

export type Verdict = { ok: true } | { ok: false; retryAfter: number }

export function fixedWindow(redis: Counter | null, now: () => number = Date.now) {
  const local = new Map<string, { count: number; until: number }>()
  return async (key: string, limit: Limit): Promise<Verdict> => {
    const t = now()
    const window = Math.floor(t / (limit.windowSeconds * 1000))
    const full = `sso:rate:${key}:${window}`
    const retryAfter = Math.max(
      1,
      Math.ceil(((window + 1) * limit.windowSeconds * 1000 - t) / 1000),
    )
    if (redis) {
      try {
        const count = await redis.incr(full)
        if (count === 1) await redis.expire(full, limit.windowSeconds + 1)
        return count > limit.max ? { ok: false, retryAfter } : { ok: true }
      } catch {
        /* falls through to this process */
      }
    }
    const entry = local.get(full)
    const count = entry && entry.until > t ? entry.count + 1 : 1
    // Oldest first, never all at once: a flood of new keys must not reset the
    // count of the one address being limited.
    if (local.size > 50_000) local.delete(local.keys().next().value!)
    local.set(full, { count, until: (window + 1) * limit.windowSeconds * 1000 })
    return count > limit.max ? { ok: false, retryAfter } : { ok: true }
  }
}

/** The browser's address, from the signed context or Cloudflare; null when neither. */
export function trustedClientIp(
  headers: Headers,
  contextSecret: string | undefined,
): string | null {
  const signed = verifyClientContext(headers.get(CLIENT_HEADER), contextSecret)
  return signed?.ip ?? headers.get("cf-connecting-ip")?.trim() ?? null
}

export function ssoRateLimit(deps: {
  take: ReturnType<typeof fixedWindow>
  contextSecret: string | undefined
  /**
   * Count starts per connection too. The body is read through Hono's
   * `c.req.json()`, which keeps it for the route to read again.
   */
  perConnectionStarts?: boolean
}): MiddlewareHandler {
  return async (c, next) => {
    const tooMany = (retryAfter: number) => {
      c.header("Retry-After", String(retryAfter))
      return c.json(
        {
          statusCode: 429,
          name: "rate_limit_exceeded",
          message: "Too many sign-in attempts. Wait a minute and try again.",
        },
        429,
      )
    }
    const ip = trustedClientIp(c.req.raw.headers, deps.contextSecret)
    if (ip) {
      const verdict = await deps.take(`ip:${ip}`, PER_IP)
      if (!verdict.ok) return tooMany(verdict.retryAfter)
    }
    if (
      c.req.method === "POST" &&
      c.req.path.endsWith("/attempts") &&
      deps.perConnectionStarts
    ) {
      const connection = connectionIn(await c.req.json().catch(() => null))
      if (connection) {
        const verdict = await deps.take(`conn:${connection}`, PER_CONNECTION_STARTS)
        if (!verdict.ok) return tooMany(verdict.retryAfter)
      }
    }
    await next()
  }
}

/** `connection` from a start's JSON body, bounded, for the per-connection count. */
export function connectionIn(body: unknown): string | null {
  const id = (body as { connection?: unknown } | null)?.connection
  return typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id) ? id.toLowerCase() : null
}
