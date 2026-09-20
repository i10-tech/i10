/**
 * The one request the cluster is not allowed to make.
 *
 * ⚠ WHY THIS EXISTS, MEASURED RATHER THAN ASSUMED. `dash.cloudflare.com` is a
 * DASHBOARD host with Cloudflare's own bot management switched on, and it
 * answers our egress with a managed challenge instead of an OAuth error. From
 * psl-vps, on 2026-09-20:
 *
 *   curl, Bun, `i10/1.0`, no user agent  → 403, `cf-mitigated: challenge`
 *   forced HTTP/1.1 (not an h2 fingerprint) → 403, challenged
 *   forced IPv4 AND IPv6, two addresses      → 403, challenged
 *   the same request from a residential line → 200-shaped OAuth JSON
 *   `api.cloudflare.com` from the same host  → ordinary JSON, never challenged
 *
 * So it is the calling ADDRESS, and no header, client or HTTP version changes
 * it. The publish path is unaffected — `api.cloudflare.com` is an API host and
 * talks to us fine — which is why this brokers the token exchange ONLY.
 *
 * ⚠ AND A WORKER IS NOT AN ARBITRARY DODGE, IT IS THE SHORTEST HONEST ROUTE.
 * The request's destination is Cloudflare either way, so sending it from
 * Cloudflare's own network adds no third party to a call that carries a client
 * secret — which is the thing that would be wrong with a rented proxy. Measured
 * the same day from a Worker: `401 invalid_client`, `cf-mitigated: null`. The
 * endpoint answers; it simply will not answer Hetzner.
 *
 * ⚠ THE UPSTREAM IS HARD-CODED AND IS NOT A PARAMETER. A broker that posts
 * wherever the caller says is an SSRF relay with a bearer token in front of it,
 * and the token is shared with a service whose other job is holding DNS
 * credentials. One destination, decided here. A second provider needing this is
 * a deliberate edit in this file and in `BROKERED_HOSTS` on the API side.
 */

const UPSTREAM = "https://dash.cloudflare.com/oauth2/token"

/**
 * ⚠ BOUNDED WELL INSIDE THE API'S OWN 10s. The caller is a person watching a
 * callback page; if Cloudflare is slow we want OUR timeout to fire first so the
 * failure says the broker timed out rather than surfacing as a socket error
 * with no provenance.
 */
const UPSTREAM_TIMEOUT_MS = 8_000

interface Env {
  /** Shared with the API. See `DNS_OAUTH_BROKER_SECRET`. */
  BROKER_SECRET: string
}

/**
 * Its own failures, never confused with Cloudflare's.
 *
 * ⚠ THE HEADER IS THE WHOLE POINT. The API reads the upstream's status and body
 * to tell "your client secret is wrong" from "we were challenged" — see
 * `describeFailure` in apps/api/src/dns/oauth.ts. A broker that refused a
 * request and answered with a bare 401 would be indistinguishable from
 * Cloudflare rejecting the client, which is the single most misleading thing
 * this could do.
 */
const refuse = (status: number, reason: string) =>
  new Response(reason, {
    status,
    headers: { "x-broker-error": reason, "content-type": "text/plain" },
  })

/**
 * ⚠ CONSTANT TIME, AND THE LENGTH CHECK FIRST. `timingSafeEqual` throws on a
 * length mismatch rather than returning false, so comparing directly turns a
 * wrong-length token into a 500 — and a 500 that only happens for some tokens
 * is itself an oracle.
 */
function sameSecret(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given)
  const b = new TextEncoder().encode(expected)
  if (a.byteLength !== b.byteLength) return false
  return crypto.subtle.timingSafeEqual(a, b)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") return refuse(405, "method_not_allowed")

    /*
     * ⚠ AN UNCONFIGURED BROKER REFUSES EVERYTHING RATHER THAN WAVING IT
     * THROUGH. A missing secret means `wrangler secret put` has not been run,
     * and the failure mode of treating that as "no auth required" is an open
     * relay to an OAuth token endpoint.
     */
    if (!env.BROKER_SECRET) return refuse(503, "broker_not_configured")

    const offered = request.headers.get("authorization") ?? ""
    const bearer = offered.startsWith("Bearer ") ? offered.slice(7) : ""
    if (!bearer || !sameSecret(bearer, env.BROKER_SECRET)) {
      return refuse(401, "unauthorized")
    }

    const body = await request.text()
    if (!body) return refuse(400, "empty_body")

    let upstream: Response
    try {
      upstream = await fetch(UPSTREAM, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          /*
           * ⚠ FORWARDED VERBATIM FROM THE API RATHER THAN INVENTED HERE, so
           * there is one place that decides how we identify ourselves. See
           * apps/api/src/dns/user-agent.ts.
           */
          "User-Agent": request.headers.get("user-agent") ?? "i10/1.0",
        },
        body,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      })
    } catch (error) {
      return refuse(504, `upstream_unreachable: ${String(error)}`)
    }

    /*
     * ⚠ THE UPSTREAM'S ANSWER IS RETURNED UNTOUCHED — status, body, and the
     * headers that identify what served it. The API's diagnostics read exactly
     * these: `cf-ray` is what Cloudflare support asks for, and `cf-mitigated`
     * is the only unambiguous signal that a challenge rather than a firewall
     * rule stopped the request. Summarising here would throw away the evidence
     * that a988c74 exists to preserve — and if this broker ever starts being
     * challenged too, this is how we will find out.
     */
    const headers = new Headers({ "x-broker": "ok" })
    for (const name of ["content-type", "cf-ray", "cf-mitigated", "retry-after"]) {
      const value = upstream.headers.get(name)
      if (value) headers.set(name, value)
    }

    return new Response(upstream.body, { status: upstream.status, headers })
  },
}
