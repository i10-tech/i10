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
    if (request.method !== "POST" || url.pathname !== "/compile") {
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
