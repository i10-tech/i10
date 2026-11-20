import type { Config } from "./config.js"

/**
 * The three Clerk answers worth keeping at our edge, and the rules for each.
 * Everything else, and everything per user, goes to Clerk every time.
 *
 * | kind          | what                                  | fresh            | stale if Clerk fails |
 * | ------------- | ------------------------------------- | ---------------- | -------------------- |
 * | `redirect`    | `/npm/<pkg>@<tag or range>/...` → 307 | 5 minutes        | never                |
 * | `bundle`      | `/npm/<pkg>@<x.y.z>/...`, immutable   | Clerk's max-age  | never                |
 * | `environment` | `GET /v1/environment`                 | 60 seconds       | up to 10 minutes     |
 *
 * ⚠ WE STORE CLERK'S ANSWER, NOT OURS. The stored copy is the upstream
 * response with its caching headers parked under `x-gateway-orig-*`; a hit
 * restores them and goes through the same `passThrough` as a miss. So the
 * `Location` rewrite, the content-coding rule and the `Cache-Control` the
 * browser sees are the same for both, by construction.
 *
 * ⚠ NO `Set-Cookie` IS EVER STORED. The environment answer sets
 * `__client_uat` to the REQUESTING browser's session timestamp (checked with a
 * real session on 2026-11-20; the body was identical with and without one).
 * Replaying it would hand one person's cookie to the next. A hit carries no
 * `Set-Cookie` at all; `/v1/client`, never cached, sets the same cookies on
 * every page load.
 */

export interface EdgeCache {
  match(key: string): Promise<Response | undefined>
  put(key: string, response: Response): Promise<void>
}

export type CacheKind = "redirect" | "bundle" | "environment"

export interface CacheRule {
  kind: CacheKind
  key: string
  /** How much longer than fresh a copy may stand in for Clerk when Clerk fails. */
  staleMs: number
}

/**
 * ⚠ BUMP TO DROP EVERY STORED COPY. A deploy does not empty `caches.default`;
 * a new version here makes every old key unreachable, and they age out.
 */
const CACHE_VERSION = "v1"

/**
 * ⚠ FIVE MINUTES: how late a browser may be to a new clerk-js release. The
 * target of a stale redirect is an exact version, which stays valid forever,
 * so being late never breaks a page; it only delays an upgrade.
 */
const REDIRECT_FRESH_MS = 5 * 60_000

/**
 * ⚠ SIXTY SECONDS: how late a dashboard change (a new sign-in strategy,
 * maintenance mode) may reach a browser. The apps' own server-side reads of the
 * same document already keep it for five minutes (`apps/auth/app/_lib/
 * environment.ts`, `apps/console/lib/clerk-environment.ts`).
 */
const ENVIRONMENT_FRESH_MS = 60_000

/**
 * ⚠ TEN MINUTES, AND ONLY WHEN CLERK FAILS. Instance config ten minutes old is
 * still right; a page that cannot load clerk-js at all is not. Past this, the
 * outage rule (503) applies again.
 */
const ENVIRONMENT_STALE_MS = 10 * 60_000

/** `6.46.2`, `1.40.3-canary.v20261019212020`: an exact version, never a tag or a range. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

const SCRIPT_ROUTES = new Set(["script.clerk_js", "script.clerk_ui"])

/**
 * Headers that describe how to cache, parked while stored, restored on a hit.
 *
 * ⚠ `vary` TOO. The key already holds everything the answer varies on, and a
 * lookup by URL carries no request headers for a stored `Vary` to match.
 */
const PARKED = [
  "cache-control",
  "expires",
  "pragma",
  "content-encoding",
  "vary",
] as const
const PARK_PREFIX = "x-gateway-orig-"
const STORED_AT = "x-gateway-stored-at"
const FRESH_MS = "x-gateway-fresh-ms"

/**
 * ⚠ NEVER STORED: cookies, and the country Clerk derived from the requesting
 * browser's address (`x-country`, which clerk-js reads for phone defaults;
 * `/v1/client` carries the right one for each browser).
 */
const NOT_STORED = new Set(["set-cookie", "x-country", "content-length"])

/**
 * Which rule, if any, covers an allowed request.
 *
 * ⚠ THE KEY IS THE PATH CLERK IS ASKED FOR, NOT THE ONE WE RECEIVED, so
 * `clerk.i10.tech/v1/environment` and `i10.tech/__clerk/v1/environment` share
 * one entry. It hangs under the proxy URL, on the zone's own host, at a path
 * no allowlist entry matches: a browser asking for it directly gets a 404.
 */
export function cacheRule(
  route: string,
  rawPath: string,
  search: string,
  request: Headers,
  config: Config,
): CacheRule | null {
  const base = `${config.proxyUrl}/__gateway_cache/${CACHE_VERSION}`
  if (SCRIPT_ROUTES.has(route)) {
    const version = /@([^/]+)\/dist\//.exec(rawPath)?.[1] ?? ""
    return EXACT_VERSION.test(version)
      ? { kind: "bundle", key: `${base}/bundle${rawPath}`, staleMs: 0 }
      : { kind: "redirect", key: `${base}/redirect${rawPath}`, staleMs: 0 }
  }
  if (route === "environment.read") {
    /*
     * ⚠ KEYED BY ORIGIN, BECAUSE CLERK'S CORS IS (`Vary: Origin`), and only for
     * our own origins or none (the apps' server-side reads). Any other origin
     * goes to Clerk every time rather than filling the cache.
     *
     * ⚠ NOT WITH `Authorization`: that is a native or cookieless client, whose
     * answer we have not checked.
     */
    const origin = request.get("origin")
    if (origin !== null && !config.allowedOrigins.has(origin)) return null
    if (request.has("authorization")) return null
    return {
      kind: "environment",
      key: `${base}/environment/${encodeURIComponent(origin ?? "-")}${rawPath}${search}`,
      staleMs: ENVIRONMENT_STALE_MS,
    }
  }
  return null
}

function directives(cacheControl: string | null): Map<string, string> {
  const out = new Map<string, string>()
  for (const part of (cacheControl ?? "").split(",")) {
    const [name, value = ""] = part.trim().toLowerCase().split("=")
    if (name) out.set(name, value.replace(/^"|"$/g, ""))
  }
  return out
}

/** Clerk's `s-maxage`, else `max-age`, in ms; null when it gives neither. */
function upstreamMaxAgeMs(cacheControl: string | null): number | null {
  const d = directives(cacheControl)
  const seconds = Number(d.get("s-maxage") ?? d.get("max-age"))
  return Number.isInteger(seconds) && seconds > 0 ? seconds * 1000 : null
}

/** How long a copy stays fresh; null when this response must not be stored. */
export function storableFor(rule: CacheRule, upstream: Response): number | null {
  const cacheControl = upstream.headers.get("cache-control")
  switch (rule.kind) {
    case "redirect":
      return upstream.status >= 300 &&
        upstream.status < 400 &&
        upstream.headers.has("location")
        ? REDIRECT_FRESH_MS
        : null
    case "bundle": {
      // ⚠ ONLY WHAT CLERK ITSELF CALLS PUBLIC AND IMMUTABLE, for as long as it says.
      const d = directives(cacheControl)
      if (upstream.status !== 200 || !d.has("public") || !d.has("immutable"))
        return null
      if (d.has("private") || d.has("no-store")) return null
      return upstreamMaxAgeMs(cacheControl)
    }
    case "environment":
      return upstream.status === 200 ? ENVIRONMENT_FRESH_MS : null
  }
}

/**
 * The copy to store: Clerk's response minus cookies and country, caching
 * headers parked, held by the cache for the fresh plus stale window.
 *
 * ⚠ ONE DECODED COPY. The runtime has already decoded Clerk's body; the
 * coding is parked with the other headers, so the stored bytes are plain and a
 * hit is encoded again (or not) for the browser that asked, exactly as a miss.
 */
export function toStored(
  upstream: Response,
  freshMs: number,
  staleMs: number,
  now: number,
): Response {
  const headers = new Headers()
  upstream.headers.forEach((value, key) => {
    const name = key.toLowerCase()
    if (NOT_STORED.has(name) || (PARKED as readonly string[]).includes(name)) return
    if (name.startsWith("x-gateway-")) return
    headers.set(key, value)
  })
  for (const name of PARKED) {
    const value = upstream.headers.get(name)
    if (value !== null) headers.set(`${PARK_PREFIX}${name}`, value)
  }
  headers.set(STORED_AT, String(now))
  headers.set(FRESH_MS, String(freshMs))
  headers.set(
    "cache-control",
    `public, s-maxage=${Math.max(1, Math.ceil((freshMs + staleMs) / 1000))}`,
  )
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  })
}

export type Lookup =
  { state: "none" } | { state: "fresh" | "stale" | "expired"; stored: Response }

/** Where a stored copy stands now. */
export function assess(
  stored: Response | undefined,
  rule: CacheRule,
  now: number,
): Lookup {
  if (!stored) return { state: "none" }
  // A copy without our bookkeeping (missing header: NaN) is never served.
  const storedAt = Number(stored.headers.get(STORED_AT) ?? NaN)
  const freshMs = Number(stored.headers.get(FRESH_MS) ?? NaN)
  if (!Number.isFinite(storedAt) || !Number.isFinite(freshMs)) {
    return { state: "expired", stored }
  }
  const age = now - storedAt
  if (age >= 0 && age < freshMs) return { state: "fresh", stored }
  if (age >= 0 && age < freshMs + rule.staleMs) return { state: "stale", stored }
  return { state: "expired", stored }
}

/** A stored copy as Clerk sent it: caching headers back, our bookkeeping gone. */
export function revive(stored: Response): Response {
  const headers = new Headers()
  stored.headers.forEach((value, key) => {
    const name = key.toLowerCase()
    if (name.startsWith("x-gateway-") || name === "cache-control") return
    if (name === "set-cookie" || name === "content-length") return
    headers.set(key, value)
  })
  for (const name of PARKED) {
    const value = stored.headers.get(`${PARK_PREFIX}${name}`)
    if (value !== null) headers.set(name, value)
  }
  return new Response(stored.body, {
    status: stored.status,
    statusText: stored.statusText,
    headers,
  })
}
