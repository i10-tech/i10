import { pinnedRequest, type EgressVerdict } from "../webhooks/egress.js"

/**
 * Every request the OIDC engine makes - discovery, JWKS, the token endpoint -
 * goes through this (#338). It is the webhook egress guard (webhooks/
 * egress.ts) applied to openid-client's `customFetch`: https only, the host
 * resolved and every address vetted as public, the connection pinned to the
 * vetted address, no redirects followed, a deadline and a size cap.
 *
 * ⚠ AN ISSUER URL IS CUSTOMER INPUT, AND THE API SITS INSIDE THE CLUSTER. An
 * admin who types `https://idp.acme.test` controls what it resolves to; without
 * this, discovery would be our API reading our own network on their behalf.
 * Every hop is vetted on its own: the discovery document names the JWKS and
 * token endpoints, and each of those is resolved and vetted again.
 */

/** Discovery, JWKS and token responses are small; anything bigger is refused. */
export const OIDC_RESPONSE_CAP = 256 * 1024
/** One deadline for the resolution and the request together, as for webhooks. */
export const OIDC_TIMEOUT_MS = 5_000

/**
 * The IdP could not be asked: DNS, a refused address, a timeout, a body too
 * big. The caller answers 503 and never "no".
 */
export class IdpUnreachable extends Error {
  constructor(
    message: string,
    readonly kind: "blocked" | "unresolved" | "timeout" | "network" | "too_large",
  ) {
    super(message)
    this.name = "IdpUnreachable"
  }
}

export interface GuardedFetchDeps {
  /** `vetHost` with the deployment's allow list (index.ts). */
  vet: (host: string, signal: AbortSignal) => Promise<EgressVerdict>
  fetch?: typeof fetch
  timeoutMs?: number
  maxBytes?: number
}

/** The shape openid-client calls (`CustomFetch`), without importing its types here. */
export type OidcFetch = (
  url: string,
  options: {
    body?: unknown
    headers: Record<string, string>
    method: string
    redirect?: "manual"
    signal?: AbortSignal
  },
) => Promise<Response>

export function guardedFetch(deps: GuardedFetchDeps): OidcFetch {
  const doFetch = deps.fetch ?? fetch
  const cap = deps.maxBytes ?? OIDC_RESPONSE_CAP
  return async (raw, options) => {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      throw new IdpUnreachable("not a URL", "blocked")
    }
    // ⚠ HTTPS ONLY, HERE AS WELL AS IN openid-client: this file is the guard,
    // and a guard that trusts its caller's settings is not one.
    if (url.protocol !== "https:" || url.username || url.password)
      throw new IdpUnreachable(`${url.origin} is not an https URL`, "blocked")
    const signal = options.signal
      ? AbortSignal.any([
          options.signal,
          AbortSignal.timeout(deps.timeoutMs ?? OIDC_TIMEOUT_MS),
        ])
      : AbortSignal.timeout(deps.timeoutMs ?? OIDC_TIMEOUT_MS)

    const verdict = await deps.vet(url.hostname, signal)
    if (!verdict.ok) throw new IdpUnreachable(verdict.reason, verdict.kind)
    const pinned = pinnedRequest(url, verdict)

    let response: Response
    try {
      response = await doFetch(pinned.url, {
        method: options.method,
        headers: { ...options.headers, host: pinned.host },
        ...(options.body !== undefined && options.body !== null
          ? { body: options.body as RequestInit["body"] }
          : {}),
        signal,
        // ⚠ NEVER FOLLOWED. A redirect is a second destination nobody vetted;
        // openid-client treats the 3xx as the error it is.
        redirect: "manual",
        ...(pinned.serverName ? { tls: { serverName: pinned.serverName } } : {}),
      })
    } catch (error) {
      const name = error instanceof Error ? error.name : ""
      throw new IdpUnreachable(
        `${url.host} did not answer`,
        name === "TimeoutError" || name === "AbortError" ? "timeout" : "network",
      )
    }
    const body = await readCapped(response, cap, url.host)
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
}

/**
 * The whole body, or a refusal when it passes `cap`. Unlike a webhook's
 * response log, a truncated discovery document or JWKS is not "what arrived",
 * it is garbage, so it is never handed on.
 */
async function readCapped(
  response: Response,
  cap: number,
  host: string,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!response.body) return null
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > cap) throw new IdpUnreachable(`${host} answered too much`, "too_large")
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof IdpUnreachable) throw error
    throw new IdpUnreachable(`${host} stopped answering`, "timeout")
  } finally {
    void reader.cancel().catch(() => {})
  }
  const all = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    all.set(c, at)
    at += c.byteLength
  }
  return all
}
