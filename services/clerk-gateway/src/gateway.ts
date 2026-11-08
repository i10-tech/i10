import { readConfig, type Config, type Env } from "./config.js"
import { clientIp, passThrough, upstreamHeaders, upstreamUrl } from "./forward.js"
import { formatLine, printablePath, type LogLine } from "./log.js"
import type { ManagedAccounts } from "./managed.js"
import { decide, type Body, type Decision } from "./policy.js"

/**
 * One request through the gateway: read, decide, forward or refuse, log.
 * Everything with a side effect is handed in, so the tests drive the whole
 * path with a fake Clerk and a captured log.
 */
export interface GatewayDeps {
  env: Env
  /** The upstream fetch. */
  fetch: (url: string, init: RequestInit) => Promise<Response>
  managed: ManagedAccounts
  log: (line: string) => void
  now: () => number
}

/**
 * ⚠ BUFFERED SO THE POLICY CAN READ IT, AND CAPPED SO THAT IS SAFE. Form
 * bodies are small: the largest our UI sends is a passkey attestation, a few
 * kilobytes. Uploads (the profile photo) are never buffered; they stream.
 */
const MAX_FORM_BYTES = 64 * 1024

/** Seconds a client should wait after our 503. */
const RETRY_AFTER_SECONDS = 5

const UPLOAD_TYPES = new Set(["multipart/form-data", "application/octet-stream"])

/** `https://host/a/b?c#d` → `/a/b` and `?c`, as received. */
export function splitUrl(url: string): { rawPath: string; search: string } {
  const match = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*([^?#]*)(\?[^#]*)?/.exec(url)
  return { rawPath: match?.[1] || "/", search: match?.[2] ?? "" }
}

type ReadBody = { body: Body; bytes: Uint8Array | null; stream: boolean }

async function readBody(request: Request, method: string): Promise<ReadBody> {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS" || !request.body) {
    return { body: { kind: "none" }, bytes: null, stream: false }
  }
  const media = (request.headers.get("content-type") ?? "")
    .split(";")[0]
    ?.trim()
    .toLowerCase()
  if (media && UPLOAD_TYPES.has(media)) {
    return { body: { kind: "upload" }, bytes: null, stream: true }
  }

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_FORM_BYTES) {
      await reader.cancel().catch(() => {})
      return { body: { kind: "too_large" }, bytes: null, stream: false }
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  if (size === 0) return { body: { kind: "none" }, bytes, stream: false }
  if (media === "application/x-www-form-urlencoded") {
    const form = new URLSearchParams(new TextDecoder().decode(bytes))
    return { body: { kind: "form", form }, bytes, stream: false }
  }
  return { body: { kind: "other" }, bytes, stream: false }
}

/**
 * Clerk's error envelope, so clerk-js parses our answers like its own.
 *
 * ⚠ `X-Clerk-Gateway` IS HOW A 404 OR 503 FROM US IS TOLD FROM CLERK'S, as
 * `x-broker-error` is for the DNS OAuth broker. It names the outcome only; the
 * reason is in the log, not in the response.
 */
function clerkError(
  status: number,
  error: { code: string; message: string; long_message: string; meta?: object },
  extra: Record<string, string> = {},
): Response {
  const outcome = status === 503 ? "unavailable" : status === 404 ? "denied" : "managed"
  return new Response(JSON.stringify({ errors: [error] }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Clerk-Gateway": outcome,
      ...extra,
    },
  })
}

const NOT_FOUND = {
  code: "resource_not_found",
  message: "Not found",
  long_message: "This request is not available.",
}

/**
 * ⚠ 503, NEVER 401, AND NEVER ANYTHING THAT READS AS "SIGNED OUT". clerk-js
 * ends the session when a token request is refused as unauthenticated; an
 * outage on our side or Clerk's must look like an outage, so the person keeps
 * their session and the next refresh, a minute later, simply succeeds.
 */
const UNAVAILABLE = {
  code: "service_unavailable",
  message: "Sign-in is temporarily unavailable",
  long_message: "We could not reach the sign-in service. Try again in a moment.",
}

function unavailable(): Response {
  return clerkError(503, UNAVAILABLE, { "Retry-After": String(RETRY_AFTER_SECONDS) })
}

function refusal(decision: Decision): Response {
  if (decision.outcome === "managed") {
    return decision.reason === "sso_required"
      ? clerkError(422, {
          code: "sso_required",
          message: "Continue with your company's SSO",
          long_message: "This account signs in through its company's single sign-on.",
          meta: { param_name: "identifier" },
        })
      : clerkError(403, {
          code: "managed_account",
          message: "Your company manages this account",
          long_message:
            "Changes to this account are made by your company's identity provider.",
        })
  }
  if (decision.outcome === "unavailable") return unavailable()
  return clerkError(404, NOT_FOUND)
}

/**
 * ⚠ OUR OWN ANSWERS CARRY CORS FOR OUR OWN ORIGINS. Clerk's answers carry
 * Clerk's CORS headers; ours would otherwise carry none, and a browser would
 * report a 404 or 503 to clerk-js as a network error - which it retries up to
 * eleven times for a GET, and which hides the status we chose so carefully.
 */
function withCors(
  response: Response,
  request: Request,
  config: Config | null,
): Response {
  const origin = request.headers.get("origin")
  if (!origin || !config?.allowedOrigins.has(origin)) return response
  response.headers.set("Access-Control-Allow-Origin", origin)
  response.headers.set("Access-Control-Allow-Credentials", "true")
  response.headers.append("Vary", "Origin")
  return response
}

export async function handle(request: Request, deps: GatewayDeps): Promise<Response> {
  const started = deps.now()
  const { rawPath, search } = splitUrl(request.url)
  const httpMethod = request.method.toUpperCase()
  const line: LogLine = {
    method: httpMethod,
    route: null,
    decision: "deny",
    reason: null,
    status: 0,
    upstream_status: null,
    duration_ms: 0,
    ip: clientIp(request.headers),
    ray: request.headers.get("cf-ray"),
  }
  const finish = (response: Response, config: Config | null): Response => {
    const out =
      line.decision === "pass" ? response : withCors(response, request, config)
    line.status = out.status
    line.duration_ms = Math.max(0, Math.round(deps.now() - started))
    deps.log(formatLine(line))
    return out
  }

  const configured = readConfig(deps.env)
  if (!configured.ok) {
    line.decision = "unavailable"
    line.reason = "not_configured"
    return finish(unavailable(), null)
  }
  const config = configured.config

  const read = await readBody(request, httpMethod)
  const decision = await decide(
    {
      method: httpMethod,
      rawPath,
      search,
      preflightMethod: request.headers.get("access-control-request-method"),
      body: read.body,
    },
    { development: config.development, managed: deps.managed },
  )
  line.method = decision.method
  line.route = decision.route
  line.decision = decision.outcome

  if (decision.outcome !== "pass") {
    line.reason = decision.reason
    if (decision.outcome === "deny") line.path = printablePath(rawPath)
    return finish(refusal(decision), config)
  }

  /*
   * ⚠ THE TIMER COVERS THE WAIT FOR CLERK'S HEADERS, NOT THE BODY. A token
   * refresh is the hot path; if Clerk has not started answering inside the
   * budget, a 503 now is better than a browser spinner.
   */
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, config.timeoutMs)

  let upstream: Response
  try {
    const init: RequestInit & { duplex?: "half" } = {
      method: httpMethod,
      headers: upstreamHeaders(request.headers, config),
      redirect: "manual",
      signal: controller.signal,
    }
    if (read.stream) {
      init.body = request.body
      init.duplex = "half"
    } else if (read.bytes) {
      init.body = read.bytes
    }
    upstream = await deps.fetch(upstreamUrl(rawPath, search, config), init)
  } catch {
    line.decision = "unavailable"
    line.reason = timedOut ? "upstream_timeout" : "upstream_unreachable"
    return finish(unavailable(), config)
  } finally {
    clearTimeout(timer)
  }

  line.upstream_status = upstream.status
  return finish(
    passThrough(upstream, config, request.headers.get("accept-encoding")),
    config,
  )
}
