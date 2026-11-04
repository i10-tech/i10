import type { MiddlewareHandler } from "hono"
import { verifyClientContext, CLIENT_HEADER } from "../risk/identity.js"
import { edgeHeader } from "./edge.js"

/**
 * Rate limits on the public SSO routes (#338): every `/sso/*` step a browser
 * drives - starting a sign-in, a test IdP's assertion, an OIDC callback, the
 * handoff swap, the bind.
 *
 * ⚠ PER BROWSER IP, AND THE IP IS ONLY EVER ONE WE CAN TRUST. apps/auth calls
 * these in-cluster, so the API's socket is never the browser: apps/auth sends
 * the browser's address as the signed `x-i10-client` context (risk/
 * identity.ts), and a caller reaching api.i10.tech directly comes through
 * Cloudflare, whose `cf-connecting-ip` is believed ONLY with the `x-i10-edge`
 * proof (identity/edge.ts). When neither is there
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
/**
 * Back-channel logouts (#345) come from an IdP's servers, not a browser: one
 * address may send a company's whole morning of sign-outs, so it gets a wider
 * window than a person does, and the connection's total is capped as well.
 */
export const LOGOUT_PER_IP: Limit = { max: 300, windowSeconds: 60 }
export const LOGOUT_PER_CONNECTION: Limit = { max: 600, windowSeconds: 60 }

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

/**
 * The browser's address, from the signed context or from Cloudflare WITH the
 * edge proof; null when neither (a forged `cf-connecting-ip` is unknown).
 */
export function trustedClientIp(
  headers: Headers,
  contextSecret: string | undefined,
  edgeSecret: string | undefined,
): string | null {
  const signed = verifyClientContext(headers.get(CLIENT_HEADER), contextSecret)
  return signed?.ip ?? edgeHeader(headers, "cf-connecting-ip", edgeSecret)
}

export function ssoRateLimit(deps: {
  take: ReturnType<typeof fixedWindow>
  contextSecret: string | undefined
  /** `EDGE_SECRET`: what makes a `cf-connecting-ip` believable. */
  edgeSecret: string | undefined
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
    const ip = trustedClientIp(c.req.raw.headers, deps.contextSecret, deps.edgeSecret)
    const logoutOf = backchannelConnection(c.req.path)
    if (ip) {
      const verdict = await deps.take(
        logoutOf ? `logout-ip:${ip}` : `ip:${ip}`,
        logoutOf ? LOGOUT_PER_IP : PER_IP,
      )
      if (!verdict.ok) return tooMany(verdict.retryAfter)
    }
    if (logoutOf) {
      const verdict = await deps.take(`logout-conn:${logoutOf}`, LOGOUT_PER_CONNECTION)
      if (!verdict.ok) return tooMany(verdict.retryAfter)
    }
    /*
     * ⚠ A SAML ACS POST AND AN INTERSTITIAL LOOKUP COUNT AS STARTS TOO (#339):
     * an IdP-initiated response makes its own attempt row, and `/sso/connection`
     * writes an audit event, so both are capped per connection like `/attempts`.
     */
    if (
      c.req.method === "POST" &&
      (c.req.path.endsWith("/attempts") ||
        c.req.path.endsWith("/connection") ||
        c.req.path.endsWith("/saml/acs")) &&
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

/** The connection a back-channel logout URL names, or null for any other path. */
export function backchannelConnection(path: string): string | null {
  const match = /\/(?:oidc\/backchannel|universal-logout)\/([0-9a-f-]{36})$/i.exec(path)
  return match ? match[1]!.toLowerCase() : null
}

/** `connection` from a start's JSON body, bounded, for the per-connection count. */
export function connectionIn(body: unknown): string | null {
  const id = (body as { connection?: unknown } | null)?.connection
  return typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id) ? id.toLowerCase() : null
}
