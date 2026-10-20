/**
 * The Worker's settings, read once per request from its bindings.
 *
 * ⚠ CONFIGURATION, SO THE SAME CODE FRONTS EITHER INSTANCE. Production points
 * at `frontend-api.clerk.dev` with `PROXY_URL=https://clerk.i10.tech`; local
 * development points at the dev instance with the local hostname (see
 * wrangler.jsonc `env.local`). Nothing about an instance is hard-coded here.
 */

export interface Env {
  /** Secret: `wrangler secret put CLERK_SECRET_KEY`. Never in a file. */
  CLERK_SECRET_KEY?: string
  /** Where allowed requests go, e.g. `https://frontend-api.clerk.dev`. */
  UPSTREAM_ORIGIN?: string
  /** The public URL of this gateway, sent as `Clerk-Proxy-Url`. */
  PROXY_URL?: string
  /** `production` or `development`; development lets the dev-only routes pass. */
  INSTANCE?: string
  /** Comma-separated origins allowed to read the gateway's OWN answers (404, 503). */
  ALLOWED_ORIGINS?: string
  /** How long to wait for Clerk's response headers. */
  UPSTREAM_TIMEOUT_MS?: string
  /**
   * Our API, asked whether an identifier or a session is a managed account
   * (#337), e.g. `https://api.i10.tech`. Unset: those lookups fail, and the
   * sign-ins and account routes that need them answer 503.
   */
  I10_API_URL?: string
  /** Secret: the API's `IDENTITY_GATEWAY_SECRET`. `wrangler secret put I10_API_SECRET`. */
  I10_API_SECRET?: string
}

export interface Config {
  secretKey: string
  /** `https://host`, no trailing slash. */
  upstreamOrigin: string
  upstreamHost: string
  /** Sent verbatim as `Clerk-Proxy-Url`. */
  proxyUrl: string
  proxyHost: string
  proxyProto: "https" | "http"
  development: boolean
  allowedOrigins: ReadonlySet<string>
  timeoutMs: number
}

export type ConfigResult = { ok: true; config: Config } | { ok: false; problem: string }

const DEFAULT_TIMEOUT_MS = 10_000

function origin(
  raw: string | undefined,
  name: string,
  allowPath: boolean,
): { problem: string } | { url: URL } {
  if (!raw) return { problem: `${name} is not set` }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { problem: `${name} is not a URL` }
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { problem: `${name} must be http(s)` }
  }
  if (url.username || url.password || url.search || url.hash) {
    return { problem: `${name} must not carry credentials, a query or a hash` }
  }
  if (!allowPath && url.pathname !== "/")
    return { problem: `${name} must not have a path` }
  return { url }
}

export function readConfig(env: Env): ConfigResult {
  const instance = env.INSTANCE
  if (instance !== "production" && instance !== "development") {
    return { ok: false, problem: "INSTANCE must be production or development" }
  }
  const development = instance === "development"

  /*
   * ⚠ AN UNCONFIGURED GATEWAY REFUSES EVERYTHING WITH 503, like the DNS OAuth
   * broker. A missing secret means `wrangler secret put` has not been run;
   * forwarding without it would have Clerk refuse every proxied request, which
   * clerk-js could read as signed out.
   *
   * ⚠ AND A KEY FROM THE OTHER INSTANCE IS NOT CONFIGURED EITHER. A dev key on
   * the production gateway (or the reverse) is the mistake most likely to be
   * made by hand, and it fails in ways that look like Clerk being broken.
   */
  const secretKey = env.CLERK_SECRET_KEY ?? ""
  const prefix = development ? "sk_test_" : "sk_live_"
  if (!secretKey.startsWith(prefix)) {
    return { ok: false, problem: `CLERK_SECRET_KEY is missing or not an ${prefix} key` }
  }

  const upstream = origin(env.UPSTREAM_ORIGIN, "UPSTREAM_ORIGIN", false)
  if ("problem" in upstream) return { ok: false, problem: upstream.problem }
  const proxy = origin(env.PROXY_URL, "PROXY_URL", true)
  if ("problem" in proxy) return { ok: false, problem: proxy.problem }

  const timeout = env.UPSTREAM_TIMEOUT_MS
    ? Number(env.UPSTREAM_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 60_000) {
    return {
      ok: false,
      problem: "UPSTREAM_TIMEOUT_MS must be an integer from 100 to 60000",
    }
  }

  const allowedOrigins = new Set(
    (env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean),
  )

  return {
    ok: true,
    config: {
      secretKey,
      upstreamOrigin: upstream.url.origin,
      upstreamHost: upstream.url.host,
      // `https://clerk.i10.tech/` → `https://clerk.i10.tech`, as Clerk's docs write it.
      proxyUrl: proxy.url.href.replace(/\/+$/, ""),
      proxyHost: proxy.url.host,
      proxyProto: proxy.url.protocol === "http:" ? "http" : "https",
      development,
      allowedOrigins,
      timeoutMs: timeout,
    },
  }
}
