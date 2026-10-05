/**
 * Renders an uploaded React Email template ONCE, in a sandbox, when a version
 * is created - never when mail is sent.
 *
 * ⚠ THIS IS THE ONLY PLACE CUSTOMER TEMPLATE CODE EVER RUNS (#160, #189). Each
 * template gets its own Dynamic Worker: no network (`globalOutbound: null`), no
 * bindings, no secrets, a CPU ceiling. It is asked for three renders with
 * marker variables, and what comes back becomes the version's skeleton; a send
 * fills that skeleton by substitution in the API. See
 * docs/decisions/templates.md for why nothing here is on the send path.
 *
 * ⚠ THE API CALLS THIS AND NOTHING ELSE DOES. `workers_dev` only, a bearer
 * secret shared with the API, the same arrangement as the DNS OAuth broker.
 */
import runtime from "../dist/runtime.txt"
import runtimeInfo from "../dist/runtime.json" with { type: "json" }
import { canonicalFileSet } from "@repo/templates"
import { compileTemplate } from "./compile.js"
import { prepare } from "./request.js"
import { messageOf, sandboxModules } from "./sandbox.js"
import { prepareTransform, transformModules } from "./transform.js"

interface Env {
  LOADER: WorkerLoader
  /** Shared with the API. See `TEMPLATE_RENDERER_SECRET`. */
  RENDERER_SECRET: string
}

/**
 * ⚠ A CEILING PER CALL, NOT PER TEMPLATE. A React Email render is a few
 * milliseconds of CPU; a template that needs a second is looping, and the
 * isolate is stopped rather than billed.
 */
const LIMITS = { cpuMs: 1_000, subRequests: 0 }
/** Wall time for one question, covering isolate start-up. */
const ASK_TIMEOUT_MS = 15_000
const COMPATIBILITY_DATE = "2026-09-01"

const json = (status: number, body: unknown) => Response.json(body, { status })

/** Constant time, and the length check first; see the DNS broker for why. */
function sameSecret(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given)
  const b = new TextEncoder().encode(expected)
  if (a.byteLength !== b.byteLength) return false
  return crypto.subtle.timingSafeEqual(a, b)
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (
      request.method !== "POST" ||
      (url.pathname !== "/compile" && url.pathname !== "/transform")
    ) {
      return json(404, { error: "not_found" })
    }

    // ⚠ UNCONFIGURED REFUSES EVERYTHING. A missing secret is a missed
    // `wrangler secret put`, not permission to run anybody's code.
    if (!env.RENDERER_SECRET) return json(503, { error: "renderer_not_configured" })
    const offered = request.headers.get("authorization") ?? ""
    const bearer = offered.startsWith("Bearer ") ? offered.slice(7) : ""
    if (!bearer || !sameSecret(bearer, env.RENDERER_SECRET)) {
      return json(401, { error: "unauthorized" })
    }

    if (url.pathname === "/transform") return runTransform(request, env)

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return json(400, { error: "invalid_json" })
    }
    const prepared = prepare(body)
    if (!prepared.ok) {
      return prepared.status === 400
        ? json(400, { error: prepared.error })
        : json(422, { ok: false, problems: prepared.problems })
    }

    /*
     * ⚠ CACHED BY THE TEMPLATE'S FILES AND THE RUNTIME, so the two questions
     * below reuse one warm isolate, and the same template uploaded twice is one
     * Dynamic Worker for the day rather than two. The runtime id is in the key
     * so a deploy with new library versions never answers from an isolate
     * built on the old ones.
     */
    const id = `tpl:${await sha256(canonicalFileSet(prepared.entry, prepared.files))}:${runtimeInfo.id}`
    const worker = env.LOADER.get(id, () => ({
      compatibilityDate: COMPATIBILITY_DATE,
      mainModule: "main.js",
      modules: sandboxModules({
        entry: prepared.entry,
        code: prepared.code,
        links: prepared.links,
        runtime,
      }),
      globalOutbound: null,
      env: {},
      limits: LIMITS,
    }))
    const entry = worker.getEntrypoint(undefined, { limits: LIMITS })

    const sandbox = {
      async ask(question: unknown): Promise<unknown> {
        try {
          const answer = await entry.fetch("https://sandbox/", {
            method: "POST",
            body: JSON.stringify(question),
            signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
          })
          return await answer.json()
        } catch (error) {
          // A throw at load time, a CPU limit, a timeout: all of them are the
          // template failing, and the uploader is the one who can fix it.
          return { ok: false, error: messageOf(error) }
        }
      },
    }

    const compiled = await compileTemplate(sandbox, (n) =>
      crypto.getRandomValues(new Uint8Array(n)),
    )
    return compiled.ok
      ? json(200, {
          ok: true,
          skeleton: compiled.skeleton,
          subject: compiled.subject,
          runtime: runtimeInfo.id,
        })
      : json(422, compiled)
  },
}

/**
 * ⚠ A TWENTIETH OF A TEMPLATE'S CPU (#302). A transformation reshapes one JSON
 * object; one that needs more than 50ms is looping, and it runs on every
 * delivery, so a slow one would be paid for on every webhook the workspace
 * sends.
 */
const TRANSFORM_LIMITS = { cpuMs: 50, subRequests: 0 }
const TRANSFORM_TIMEOUT_MS = 5_000
/** What a transformation may hand back: a little over the body it may send. */
const MAX_TRANSFORM_OUTPUT_BYTES = 512 * 1024

async function runTransform(request: Request, env: Env): Promise<Response> {
  const raw = await request.text()
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return json(400, { error: "invalid_json" })
  }
  const prepared = prepareTransform(body, new TextEncoder().encode(raw).byteLength)
  if (!prepared.ok) {
    return prepared.status === 400
      ? json(400, { error: prepared.error })
      : json(422, { ok: false, error: prepared.error })
  }

  // ⚠ ONE ISOLATE PER FUNCTION, KEYED BY ITS CODE, so a workspace's every
  // delivery reuses one warm isolate and no two workspaces ever share one
  // unless they wrote the same bytes.
  const id = `tfm:${await sha256(prepared.code)}`
  const worker = env.LOADER.get(id, () => ({
    compatibilityDate: COMPATIBILITY_DATE,
    mainModule: "main.js",
    modules: transformModules(prepared.code),
    globalOutbound: null,
    env: {},
    limits: TRANSFORM_LIMITS,
  }))
  const entry = worker.getEntrypoint(undefined, { limits: TRANSFORM_LIMITS })
  try {
    const answer = await entry.fetch("https://sandbox/", {
      method: "POST",
      body: JSON.stringify(prepared.input),
      signal: AbortSignal.timeout(TRANSFORM_TIMEOUT_MS),
    })
    const text = await answer.text()
    if (new TextEncoder().encode(text).byteLength > MAX_TRANSFORM_OUTPUT_BYTES) {
      return json(422, {
        ok: false,
        error: `The transformation returned more than ${MAX_TRANSFORM_OUTPUT_BYTES / 1024}KB.`,
      })
    }
    const parsed = JSON.parse(text) as {
      ok?: unknown
      value?: unknown
      error?: unknown
    }
    return parsed.ok === true
      ? json(200, { ok: true, value: parsed.value })
      : json(422, {
          ok: false,
          error: messageOf(parsed.error ?? "The transformation failed."),
        })
  } catch (error) {
    // A throw at load, the CPU limit, the deadline: the function failing, and
    // its author is the one who can fix it.
    return json(422, { ok: false, error: messageOf(error) })
  }
}
