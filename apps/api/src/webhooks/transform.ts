import type { WebhookTransformed } from "@repo/contracts"
import { checkCustomHeaders } from "./headers.js"

/**
 * Webhook transformations (#302): a customer's function that reshapes a
 * webhook before it is signed and sent.
 *
 * ⚠ THE CODE NEVER RUNS IN THIS PROCESS. This process holds the key that
 * opens every endpoint's signing secret; customer code runs in the template
 * renderer's sandbox (services/template-renderer, `/transform`) - its own pod,
 * no egress, an isolate per function with no network and 50ms of CPU - and
 * what comes back is data.
 *
 * ⚠ AND NOTHING IT RETURNS IS BELIEVED. `applyTransformation` decides what is
 * sent: the method from a short list, a URL on the endpoint's own origin, the
 * customer's own headers under the same reserved-name rule as on write, and a
 * body under a cap. A function that tries to send somewhere else, or to set
 * `webhook-signature`, fails the attempt with a sentence saying so.
 *
 * ⚠ SIGNED AFTER. The signature covers the bytes that leave, so a receiver
 * verifies exactly what the transformation produced.
 */

export type Transformed = WebhookTransformed

/** What a function is handed, and what it hands back. */
export interface TransformInput {
  payload: unknown
  method: "POST"
  url: string
  headers: Record<string, string>
}

export type TransformCall =
  | { status: "ok"; value: unknown }
  /** The function failed: it threw, timed out, ran out of CPU, or did not compile. */
  | { status: "error"; error: string }
  /** Our sandbox did not answer. Never the customer's fault; see deliver.ts. */
  | { status: "unavailable"; error: string }

export interface Transformer {
  run: (code: string, input: TransformInput) => Promise<TransformCall>
}

/** The most a transformed body may be. */
export const MAX_TRANSFORMED_BODY_BYTES = 256 * 1024
const METHODS = new Set(["POST", "PUT", "PATCH"])

/** The renderer's `/transform`, over the same bearer secret as `/compile`. */
export function transformer(opts: {
  url: string
  secret: string
  fetch?: typeof fetch
  timeoutMs?: number
}): Transformer {
  const doFetch = opts.fetch ?? fetch
  return {
    async run(code, input) {
      let response: Response
      try {
        response = await doFetch(new URL("/transform", opts.url), {
          method: "POST",
          headers: {
            authorization: `Bearer ${opts.secret}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ code, input }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
        })
      } catch (error) {
        return { status: "unavailable", error: String(error) }
      }
      // ⚠ ONLY 200 AND 422 ARE THE FUNCTION'S ANSWER. A 401, a 503, a 5xx is
      // our sandbox or our configuration, and must never be recorded as the
      // customer's code failing - or count against their endpoint.
      if (response.status !== 200 && response.status !== 422) {
        return {
          status: "unavailable",
          error: `transformer answered ${response.status}`,
        }
      }
      const body = (await response.json().catch(() => null)) as {
        ok?: unknown
        value?: unknown
        error?: unknown
      } | null
      if (!body)
        return { status: "unavailable", error: "transformer answered nonsense" }
      return body.ok === true
        ? { status: "ok", value: body.value }
        : { status: "error", error: String(body.error ?? "The transformation failed.") }
    },
  }
}

export type Applied = { ok: true; request: Transformed } | { ok: false; reason: string }

/**
 * Turns what a function returned into exactly what will be sent, or says why
 * it cannot be.
 */
export function applyTransformation(endpointUrl: string, value: unknown): Applied {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "The transformation must return the webhook object." }
  }
  const v = value as Record<string, unknown>

  const method = v.method ?? "POST"
  if (typeof method !== "string" || !METHODS.has(method)) {
    return { ok: false, reason: "`method` must be POST, PUT or PATCH." }
  }

  // ⚠ THE ORIGIN IS THE ONE THE CUSTOMER REGISTERED AND WE VETTED. A function
  // that could pick the host would be an SSRF with extra steps, and a way to
  // have us sign a payload for somebody else's server.
  const origin = new URL(endpointUrl)
  let url: URL
  try {
    url = new URL(typeof v.url === "string" ? v.url : endpointUrl, origin)
  } catch {
    return { ok: false, reason: "`url` is not a URL." }
  }
  if (url.origin !== origin.origin || url.username || url.password) {
    return {
      ok: false,
      reason: `\`url\` may change the path and query, not where it goes: it must stay on ${origin.origin}.`,
    }
  }
  url.hash = ""

  const headers = v.headers ?? {}
  if (
    typeof headers !== "object" ||
    headers === null ||
    Array.isArray(headers) ||
    Object.values(headers).some((h) => typeof h !== "string")
  ) {
    return { ok: false, reason: "`headers` must map names to strings." }
  }
  const checked = checkCustomHeaders(headers as Record<string, string>)
  if (!checked.ok) return { ok: false, reason: checked.reason }

  let body: string
  try {
    body = JSON.stringify(v.payload ?? null)
  } catch {
    return { ok: false, reason: "`payload` cannot be turned into JSON." }
  }
  if (new TextEncoder().encode(body).byteLength > MAX_TRANSFORMED_BODY_BYTES) {
    return {
      ok: false,
      reason: `The transformed payload is over ${MAX_TRANSFORMED_BODY_BYTES / 1024}KB.`,
    }
  }

  return {
    ok: true,
    request: {
      method: method as Transformed["method"],
      // ⚠ THE PATH AND QUERY ONLY, resolved against the endpoint's URL at
      // every send. A frozen absolute URL would keep retrying the old host
      // after the customer moved their endpoint.
      url: url.pathname + url.search,
      headers: checked.headers,
      body,
    },
  }
}
