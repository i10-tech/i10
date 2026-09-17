import "server-only"
import { auth } from "@clerk/nextjs/server"
import {
  previewFor,
  PREVIEW,
  PREVIEW_NOT_FOUND,
  PREVIEW_UNAVAILABLE,
} from "@/lib/preview"

/**
 * How the console talks to the API.
 *
 * ⚠ SERVER-SIDE ONLY, AND `import "server-only"` IS WHAT ENFORCES IT. Every
 * call here carries a Clerk session token minted for this request; importing
 * this module from a client component would put that token in the browser
 * bundle's reach, and the error you get instead is a build failure naming the
 * file that did it. The browser reaches the API through the route handlers in
 * `app/api/*`, which call this on the server.
 *
 * ⚠ THE TOKEN IS A SESSION JWT, NOT AN API KEY, AND THE DISTINCTION IS THE
 * WHOLE SECURITY MODEL. `/console/*` on the API accepts a session and refuses a
 * key; `/emails` accepts a key and refuses a session. Nothing accepts both —
 * see apps/api/src/middleware/tenant.ts. If this file ever grew a fallback to
 * an API key, a leaked sending key would become an account takeover.
 *
 * ⚠ AND THE BASE URL IS READ AT REQUEST TIME FROM AN UNPREFIXED VARIABLE. Next
 * inlines `NEXT_PUBLIC_*` at BUILD time, even in server code, and the console
 * image is built once in CI with no access to any environment — so a prefixed
 * name would be compiled in as `undefined` and no amount of setting it in the
 * pod would bring it back. The same reasoning as the Clerk keys in
 * middleware.ts, and the same trap.
 */

/**
 * Where `apps/api` is.
 *
 * ⚠ THE LOCAL DEFAULT IS THE API'S DEV PORT, SO A FRESH CHECKOUT WORKS WITH NO
 * ENVIRONMENT AT ALL — and it must NOT apply in production. An earlier version
 * of this file defaulted unconditionally and carried a comment saying the
 * variable "is always set" in production and that the fallback "fails loudly
 * and immediately" if it were not. All of that was wrong, and it shipped:
 * `API_BASE_URL` was absent from the console's deployment, every server
 * component fetched `http://localhost:3001`, and bun answered `Unable to
 * connect. Is the computer able to access the url?` — which reaches the browser
 * as a minified React error and an error boundary. Nothing in that names a
 * missing variable. A default that is right for a laptop is a silent
 * misconfiguration in a pod.
 *
 * ⚠ IT IS RESOLVED PER CALL RATHER THAN AT MODULE SCOPE, WHICH IS THE WHOLE
 * REASON THIS IS A FUNCTION. `next build` evaluates module scope while
 * collecting page data, with `NODE_ENV=production` and no deployment
 * environment — exactly the state this refuses. Throwing at module scope would
 * fail every CI build to guard against a misconfiguration that can only exist
 * at runtime. The header note above makes the same point about `NEXT_PUBLIC_`.
 */
function baseUrl(): string {
  const configured = process.env.API_BASE_URL?.trim()
  if (configured) return configured.replace(/\/$/, "")

  if (process.env.NODE_ENV === "production") {
    throw new ApiRequestError(500, {
      statusCode: 500,
      name: "internal_server_error",
      message:
        "API_BASE_URL is not set. The console cannot reach the API. Set it on " +
        "the deployment to the in-cluster address of the api Service, e.g. " +
        "http://i10-api.i10-prod.svc.cluster.local — see " +
        "infra/k8s/i10/workloads/console.yaml.",
    })
  }

  return "http://localhost:3001"
}

export interface ApiError {
  statusCode: number
  name: string
  message: string
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError,
  ) {
    super(body.message)
    this.name = "ApiRequestError"
  }
}

interface RequestOptions {
  method?: string
  body?: unknown
  /** Sent as-is. Used for the CSV import, which is not JSON. */
  rawBody?: string
  contentType?: string
  /**
   * ⚠ `no-store` IS THE DEFAULT AND CHANGING IT PER CALL NEEDS A REASON. This
   * is a dashboard: every number on it is the answer to "what is happening
   * right now", and a cached delivery log is worse than a slow one. Next 16
   * does not cache `fetch` by default, but being explicit means a future
   * default flip cannot silently start serving somebody yesterday's mail.
   */
  cache?: RequestCache
  /** Additional query parameters. Undefined values are dropped. */
  query?: Record<string, string | number | undefined | null>
}

async function authorization(): Promise<string | null> {
  const session = await auth()
  /*
   * ⚠ `getToken()` WITH NO TEMPLATE RETURNS THE DEFAULT SESSION JWT, WHICH IS
   * WHAT `clerk.authenticateRequest` ON THE API VERIFIES. Passing a JWT
   * template name here would mint a token with a custom claim set that
   * `authenticateRequest` does not accept, and the failure is a 401 that looks
   * like the session being invalid.
   */
  const token = await session.getToken()
  return token ? `Bearer ${token}` : null
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  /*
   * ⚠ THE PREVIEW BRANCH IS DEAD CODE IN A PRODUCTION BUILD. `PREVIEW` folds to
   * a literal `false` — see lib/preview.ts — so the bundler deletes this block
   * outright: the compiled function goes from the path guard straight to
   * `fetch`. The fixture data itself is still emitted into the chunk, and is
   * unreachable because nothing left in the build reads it. There is no
   * variable anybody can set in a pod to change that.
   *
   * ⚠ AND A MUTATION IN PREVIEW IS A NO-OP THAT REPORTS SUCCESS, DELIBERATELY.
   * The point of the mode is reviewing the interface; a create dialog that
   * refused to close would make half the screens unreviewable. Nothing
   * persists, so a refresh puts the fixture back — which is the honest
   * behaviour for a mode with no database.
   */
  if (PREVIEW) {
    const fixture = previewFor(path, options.query)

    /*
     * ⚠ "THE ROW IS NOT HERE" IS A 404, NOT A MISSING FIXTURE. Without this the
     * detail routes fell back to the first row and rendered a convincing page
     * for an id that does not exist — and `not-found.tsx` was unreachable, so
     * the 404 nobody looks at until it matters could never be reviewed. The
     * status matters too: the pages branch on 404 to call `notFound()`, and
     * anything else there is an error boundary instead.
     */
    if (fixture === PREVIEW_NOT_FOUND) {
      throw new ApiRequestError(404, {
        statusCode: 404,
        name: "not_found",
        message: "Not found.",
      })
    }

    /*
     * ⚠ TAKING MONEY IS THE ONE THING PREVIEW MODE REFUSES OUTRIGHT. Every
     * other mutation is a no-op that reports success so the interface stays
     * reviewable; a checkout that reported success would hand the page a url
     * that does not exist, and the page's next act is to navigate to it.
     */
    if (fixture === PREVIEW_UNAVAILABLE) {
      throw new ApiRequestError(503, {
        statusCode: 503,
        name: "service_unavailable",
        message:
          "Preview mode has no payment provider, so this cannot be completed " +
          "here. Everything up to this point is real.",
      })
    }

    if (fixture !== undefined) return fixture as T
    if (options.method && options.method !== "GET") return undefined as T

    throw new ApiRequestError(501, {
      statusCode: 501,
      name: "preview_fixture_missing",
      message: `Preview mode has no fixture for ${path}. Add one in lib/preview.ts.`,
    })
  }

  const header = await authorization()

  if (!header) {
    /*
     * ⚠ THROWN AS A 401 RATHER THAN REDIRECTING FROM HERE. This runs inside
     * server components and route handlers; `redirect()` in the middle of a
     * data fetch produces a control-flow exception that any surrounding
     * try/catch swallows, and the page then renders an error state for
     * somebody who simply needs to sign in. The middleware already protects
     * every page, so reaching this means the session lapsed mid-request, and
     * the caller decides what to do about it.
     */
    throw new ApiRequestError(401, {
      statusCode: 401,
      name: "invalid_access",
      message: "Your session has expired. Sign in again.",
    })
  }

  /*
   * ⚠ THE PATH IS VALIDATED AT THIS ONE CHOKE POINT, BECAUSE A SERVER ACTION IS
   * A PUBLIC POST ENDPOINT AND ITS ARGUMENTS ARE THE CALLER'S, NOT THE UI'S.
   * Every action in lib/actions.ts interpolates an id into a template string;
   * nothing stops somebody invoking `deleteDomain("../../mailboxes/x")`
   * directly, and `new URL()` normalises `..` away — so that request would leave
   * here as `DELETE /mailboxes/x`, carrying this person's session token, at a
   * path the console was never meant to reach.
   *
   * ⚠ ENCODING EACH ID AT ITS CALL SITE WOULD ALSO WORK AND IS THE WEAKER FIX:
   * it is twenty-odd places, and the twenty-first is the one somebody adds next
   * year. A guard here is one place and it fails closed.
   *
   * ⚠ IT REFUSES `?` AND `#` FOR THE SAME REASON. Query and fragment are built
   * from `options.query` below; a path that smuggled its own would append
   * parameters this function never saw, past any validation the API does on the
   * ones it expects.
   */
  if (
    !path.startsWith("/console/") ||
    path.includes("..") ||
    path.includes("//") ||
    path.includes("?") ||
    path.includes("#") ||
    path.includes("\\")
  ) {
    throw new ApiRequestError(400, {
      statusCode: 400,
      name: "invalid_path",
      message: `Refused to request ${path}: the console may only call /console/*.`,
    })
  }

  const url = new URL(`${baseUrl()}${path}`)
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value === undefined || value === null || value === "") continue
    url.searchParams.set(key, String(value))
  }

  const headers: Record<string, string> = { Authorization: header }
  let body: string | undefined

  if (options.rawBody !== undefined) {
    body = options.rawBody
    headers["Content-Type"] = options.contentType ?? "text/plain"
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body)
    headers["Content-Type"] = "application/json"
  }

  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers,
    ...(body === undefined ? {} : { body }),
    cache: options.cache ?? "no-store",
  })

  if (!response.ok) {
    /*
     * ⚠ THE API'S ERROR ENVELOPE IS PRESERVED RATHER THAN FLATTENED TO A
     * STRING, because the console branches on `name`. `plan_limit_exceeded`
     * renders an upgrade prompt, `tenant_not_ready` renders a "still setting
     * up" spinner and retries, and everything else renders an error. A thrown
     * `Error("403")` would make all three identical.
     */
    const fallback: ApiError = {
      statusCode: response.status,
      name: "internal_server_error",
      message: `The API answered ${response.status}.`,
    }

    let parsed: ApiError = fallback
    try {
      const json = (await response.json()) as Partial<ApiError>
      if (json && typeof json.message === "string") {
        parsed = {
          statusCode: json.statusCode ?? response.status,
          name: json.name ?? fallback.name,
          message: json.message,
        }
      }
    } catch {
      // A non-JSON error body — an ingress 502 page, usually. The fallback
      // already says something true.
    }

    throw new ApiRequestError(response.status, parsed)
  }

  // 204 and friends. `response.json()` on an empty body throws.
  if (response.status === 204 || response.headers.get("content-length") === "0") {
    return undefined as T
  }

  return (await response.json()) as T
}

/**
 * The same call, but an expected failure comes back as a value.
 *
 * ⚠ FOR PAGES THAT MUST RENDER SOMETHING EVEN WHEN ONE PANEL FAILS. A
 * dashboard that throws because the usage endpoint is having a bad minute
 * shows nothing at all — including the five panels that were fine. Server
 * components have no error boundary granularity below a `error.tsx` for the
 * whole route, so the granularity has to be here.
 */
export async function tryApi<T>(
  path: string,
  options: RequestOptions = {},
): Promise<{ ok: true; data: T } | { ok: false; error: ApiError }> {
  try {
    return { ok: true, data: await api<T>(path, options) }
  } catch (error) {
    if (error instanceof ApiRequestError) return { ok: false, error: error.body }
    return {
      ok: false,
      error: {
        statusCode: 500,
        name: "internal_server_error",
        message: error instanceof Error ? error.message : "Something went wrong.",
      },
    }
  }
}
