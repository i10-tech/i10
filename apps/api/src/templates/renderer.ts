import type { FileSet, Skeleton } from "@repo/templates"

/**
 * The client for services/template-renderer: where an uploaded `.tsx` is run,
 * once, when its version is created.
 *
 * ⚠ CALLED WHEN A VERSION IS CREATED AND AT NO OTHER TIME. Not on a send, not
 * on a preview, not on a promote: those all read the stored skeleton. If this
 * Worker is down, uploads fail and mail keeps going out.
 */

export interface Renderer {
  compile(input: CompileInput): Promise<Compiled>
}

/** One file, or an entry and the files it imports (#234). */
export type CompileInput = { source: string } | { entry: string; files: FileSet }

export type Compiled =
  | {
      ok: true
      skeleton: Skeleton
      runtime: string
      /** The template's exported `subject`, when it has one. */
      subject: string | null
    }
  /** The template itself is the problem; the uploader can fix it. */
  | { ok: false; problems: string[] }
  /** We are the problem; the uploader can only retry. */
  | { ok: false; unavailable: string }

/**
 * ⚠ LONGER THAN A SEND'S BUDGET BECAUSE NOBODY IS WAITING ON MAIL. A person is
 * waiting on an upload, and a cold isolate plus three renders is seconds, not
 * milliseconds.
 */
const TIMEOUT_MS = 30_000

export function templateRenderer(opts: {
  url: string
  secret: string
  fetch?: typeof fetch
}): Renderer {
  const doFetch = opts.fetch ?? fetch
  const endpoint = new URL("/compile", opts.url).toString()

  return {
    async compile(input) {
      let response: Response
      try {
        response = await doFetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${opts.secret}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })
      } catch (error) {
        return { ok: false, unavailable: `renderer unreachable: ${String(error)}` }
      }

      const body = (await response.json().catch(() => null)) as Record<
        string,
        unknown
      > | null
      if (response.status === 422 && body && Array.isArray(body.problems)) {
        return {
          ok: false,
          problems: body.problems.filter((p): p is string => typeof p === "string"),
        }
      }
      if (!response.ok || !body || body.ok !== true || !isSkeleton(body.skeleton)) {
        return { ok: false, unavailable: `renderer answered ${response.status}` }
      }
      return {
        ok: true,
        skeleton: body.skeleton,
        runtime: typeof body.runtime === "string" ? body.runtime : "unknown",
        subject:
          typeof body.subject === "string" && body.subject.length <= 998
            ? body.subject
            : null,
      }
    },
  }
}

/**
 * ⚠ CHECKED, THOUGH THE RENDERER IS OURS. Its answer is built from what a
 * customer's code rendered, and a skeleton with the wrong shape would be
 * stored as a version and fail on every send that names it.
 */
function isSkeleton(v: unknown): v is Skeleton {
  if (typeof v !== "object" || v === null) return false
  const s = v as Record<string, unknown>
  return (
    typeof s.html === "string" &&
    typeof s.text === "string" &&
    typeof s.nonce === "string" &&
    /^[a-z]{12}$/.test(s.nonce) &&
    Array.isArray(s.variables) &&
    s.variables.every(
      (x) =>
        typeof x === "object" &&
        x !== null &&
        typeof (x as Record<string, unknown>).path === "string" &&
        typeof (x as Record<string, unknown>).preview === "string",
    )
  )
}
