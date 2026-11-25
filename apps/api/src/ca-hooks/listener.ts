import { existsSync, readFileSync } from "node:fs"
import { timingSafeEqual } from "node:crypto"
import { sha256, type HookDecision } from "../mail-devices/permits.js"
import { bodyTimestamp } from "./body.js"
import { CA_HOOK_KINDS, type CaHookKind } from "./config.js"
import type { HookHandler } from "./handlers.js"

/**
 * The device CA's webhook listener (#383 PR 3, docs/research/mail-device-binding.md
 * section 11, "The CA" and "Revision 5 rules"): a second `Bun.serve`, on its own
 * port, that only step-ca's relay sidecar (`services/authd/cmd/cahookrelay`) calls.
 *
 * ⚠ ITS OWN `fetch`, NEVER `app.fetch`. No route of the main API is reachable
 * here, and the main request logger never sees a hook.
 *
 * ⚠ EVERY AUTHENTICATION FAILURE IS THE SAME BARE 404, checked before a byte of
 * the body is read: a wrong path or method, a missing or wrong bearer token, a
 * webhook id that is not this path's, a body past 64 KiB, a body that is not
 * JSON, or a `timestamp` more than 60 seconds from now. Nothing says which.
 *
 * ⚠ IT LOGS THE HOOK KIND AND THE OUTCOME, NEVER A HEADER, THE BODY OR THE TOKEN.
 */

export const MAX_BODY_BYTES = 64 * 1024
export const TIMESTAMP_WINDOW_MS = 60 * 1000
export const HANDLER_TIMEOUT_MS = 5 * 1000
/** A bearer token is one header-safe word; anything longer is not ours. */
const BEARER = /^Bearer ([\x21-\x7e]{16,512})$/

export interface HookLog {
  info(fields: Record<string, unknown>, message: string): void
  warn(fields: Record<string, unknown>, message: string): void
  error(fields: Record<string, unknown>, message: string): void
}

export interface CaHooksDeps {
  tokenHashes: readonly Buffer[]
  webhookIds: Readonly<Record<CaHookKind, string>>
  handlers: Readonly<Record<CaHookKind, HookHandler>>
  log: HookLog
  now?: () => Date
  timeoutMs?: number
}

const notFound = () => new Response(null, { status: 404 })

/**
 * True when one of the token hashes matches. Compares against EVERY hash, so
 * the time taken does not say which one matched, or how many there are before it.
 */
function tokenMatches(header: string | null, hashes: readonly Buffer[]): boolean {
  const token = header ? BEARER.exec(header)?.[1] : undefined
  const presented = sha256(token ?? "")
  let matched = false
  for (const hash of hashes) {
    matched = timingSafeEqual(presented, hash) || matched
  }
  return matched && token !== undefined
}

/** Constant-time equality of two strings of any length (through their hashes). */
function sameText(a: string | null, b: string): boolean {
  return a !== null && timingSafeEqual(sha256(a), sha256(b))
}

/** The body, or null past `MAX_BODY_BYTES`, read without ever holding more. */
async function readCapped(request: Request): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length") ?? "0")
  if (!Number.isFinite(declared) || declared > MAX_BODY_BYTES) return null
  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    return undefined
  }
}

class HookTimeout extends Error {}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HookTimeout()), ms)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

const KIND_BY_PATH = new Map<string, CaHookKind>(
  CA_HOOK_KINDS.map((kind) => [`/${kind}`, kind]),
)

/** The listener's whole request handler. Exported for tests; never mounted on the main app. */
export function createCaHooksFetch(
  deps: CaHooksDeps,
): (request: Request) => Promise<Response> {
  const now = deps.now ?? (() => new Date())
  const timeoutMs = deps.timeoutMs ?? HANDLER_TIMEOUT_MS

  return async (request) => {
    const url = new URL(request.url)
    const kind = url.search === "" ? KIND_BY_PATH.get(url.pathname) : undefined
    if (!kind || request.method !== "POST") {
      deps.log.warn({ hook: "unknown", outcome: "not_found" }, "ca hook")
      return notFound()
    }
    // ⚠ BOTH CHECKS RUN, so a right token with a wrong id costs the same as neither.
    const tokenOk = tokenMatches(request.headers.get("authorization"), deps.tokenHashes)
    const idOk = sameText(
      request.headers.get("x-smallstep-webhook-id"),
      deps.webhookIds[kind],
    )
    if (!tokenOk || !idOk) {
      deps.log.warn({ hook: kind, outcome: "unauthenticated" }, "ca hook")
      return notFound()
    }

    const bytes = await readCapped(request)
    const body = bytes ? parseJson(bytes) : undefined
    const at = bodyTimestamp(body)
    const started = now()
    if (!at || Math.abs(started.getTime() - at.getTime()) > TIMESTAMP_WINDOW_MS) {
      deps.log.warn({ hook: kind, outcome: "stale_or_unreadable" }, "ca hook")
      return notFound()
    }

    let decision: HookDecision
    try {
      decision = await withTimeout(deps.handlers[kind](body, started), timeoutMs)
    } catch (error) {
      // ⚠ NEVER THE ERROR OBJECT. A driver error can carry the query's
      // parameters (key hashes, a serial); its SQLSTATE is all a reader needs.
      const code = error as { code?: unknown; cause?: { code?: unknown } } | null
      const sqlstate = typeof code?.code === "string" ? code.code : code?.cause?.code
      const outcome = error instanceof HookTimeout ? "timeout" : "error"
      deps.log.error({ hook: kind, outcome, sqlstate }, "ca hook failed")
      // A 5xx, which step-ca retries once and then refuses: it never issues on one.
      return new Response(null, { status: error instanceof HookTimeout ? 503 : 500 })
    }

    if (
      decision.outcome === "key_conflict" ||
      decision.outcome === "key_conflict_cleared"
    ) {
      // A second key for an authorized permit: someone else knew the nonce, or
      // the same profile ran twice. The permit id is ours, not the caller's.
      deps.log.error(
        { hook: kind, outcome: decision.outcome, permitId: decision.permitId },
        "ca hook saw a second key for an authorized permit",
      )
    } else {
      deps.log.info({ hook: kind, outcome: decision.outcome }, "ca hook")
    }
    // step-ca's `webhook.ResponseBody`: `allow`, and nothing a refused device
    // could read (an `error` would reach its ACME or SCEP client).
    return Response.json({ allow: decision.allow })
  }
}

export interface CaHooksListenerConfig {
  port: number
  certFile: string
  keyFile: string
  tokenHashes: readonly Buffer[] | undefined
  webhookIds: Readonly<Record<CaHookKind, string>> | undefined
  intermediateNotAfter: Date | undefined
}

export interface CaHooksListener {
  port: number
  stop(): Promise<void>
}

/**
 * Starts the listener, or returns null and says why once: it is OFF until the
 * hook settings are set and both TLS files are mounted, so the code ships inert.
 *
 * ⚠ THE CERTIFICATE IS READ ONCE. `Bun.serve` cannot reload `tls`, which is why
 * the leaf is long-lived (section 11); a new one needs a restart.
 */
export function startCaHooksListener(
  config: CaHooksListenerConfig,
  makeHandlers: (intermediateNotAfter: Date) => Record<CaHookKind, HookHandler>,
  log: HookLog,
): CaHooksListener | null {
  const { tokenHashes, webhookIds, intermediateNotAfter } = config
  if (!tokenHashes || !webhookIds || !intermediateNotAfter) {
    log.info({ hooks: "off", reason: "not_configured" }, "ca hooks listener off")
    return null
  }
  if (!existsSync(config.certFile) || !existsSync(config.keyFile)) {
    log.info({ hooks: "off", reason: "no_certificate" }, "ca hooks listener off")
    return null
  }
  const fetch = createCaHooksFetch({
    tokenHashes,
    webhookIds,
    handlers: makeHandlers(intermediateNotAfter),
    log,
  })
  // ⚠ A LISTENER THAT CANNOT START NEVER TAKES THE API DOWN WITH IT. A bad
  // certificate or a taken port leaves the hooks off, which step-ca meets as a
  // transport error and refuses on: the CA fails closed, the main API stays up.
  let server: ReturnType<typeof Bun.serve>
  try {
    server = Bun.serve({
      port: config.port,
      tls: { cert: readFileSync(config.certFile), key: readFileSync(config.keyFile) },
      maxRequestBodySize: MAX_BODY_BYTES,
      fetch,
      // Never Bun's default error page, which prints the error.
      error: () => new Response(null, { status: 500 }),
    })
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    log.error(
      {
        hooks: "off",
        reason: "start_failed",
        code: typeof code === "string" ? code : undefined,
      },
      "ca hooks listener could not start",
    )
    return null
  }
  log.info({ hooks: "on", port: server.port }, "ca hooks listening")
  return { port: server.port ?? config.port, stop: () => server.stop() }
}
