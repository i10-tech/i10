/**
 * The envelope every failure in this console is rendered from.
 *
 * ⚠ IT LIVES HERE RATHER THAN IN `api.ts` BECAUSE `api.ts` IS `server-only`.
 * This is a pure fact about a wire format — no session, no fetch, nothing that
 * must not reach a browser bundle — and keeping it behind that import meant it
 * could not be tested without pulling a server module into the test runner.
 */
export interface ApiError {
  statusCode: number
  name: string
  message: string
}

/**
 * The API's error body, with the three fields every surface renders guaranteed.
 *
 * ⚠ THE WHOLE BODY IS KEPT, AND REBUILDING IT FIELD BY FIELD WAS A REAL BUG
 * RATHER THAN A TIDINESS QUESTION. This used to construct a fresh object from
 * `statusCode`, `name` and `message` and discard everything else — which
 * silently defeated three features that had already shipped:
 *
 *   - `publish-records` reads `body.conflicts`, the records standing in the
 *     way of a publish. That list IS the remedy, and it never arrived.
 *   - the DNS callback reads `body.detail`, which is the difference between
 *     "Cloudflare served a bot challenge" and four other failures that share
 *     one sentence.
 *   - the step-up prompt reads `body.clerk_error`, without which Clerk never
 *     opens its verification dialog and the button appears to just fail.
 *
 * Each of those was written, correct on the API, and inert in the browser.
 * Each failed by showing a slightly less useful message, which is the failure
 * nobody reports.
 *
 * ⚠ EXPORTED SO THE TEST EXERCISES THIS FUNCTION RATHER THAN A COPY OF IT. A
 * test that re-implements the thing it is checking passes for ever, including
 * after somebody changes the original.
 */
export function normaliseError(
  json: Record<string, unknown>,
  status: number,
): ApiError {
  const fallback: ApiError = {
    statusCode: status,
    name: "internal_server_error",
    message: `The API answered ${status}.`,
  }

  // ⚠ A BODY WITH NO MESSAGE IS NOT AN API ERROR ENVELOPE — it is an ingress
  // page or a proxy's JSON. Spreading it would produce an object with no
  // sentence to render.
  if (!json || typeof json.message !== "string") return fallback

  return {
    ...json,
    statusCode: typeof json.statusCode === "number" ? json.statusCode : status,
    name: typeof json.name === "string" ? json.name : fallback.name,
    message: json.message,
  }
}
