import "server-only"
import { ApiRequestError } from "@/lib/api"
import { safeFailure } from "@/lib/failure"
import type { ActionResult } from "@/lib/actions"

/**
 * Runs one API call and returns its outcome as a value, for the server actions
 * of the SSO screens (lib/sso-actions.ts, lib/sso-policy-actions.ts): a
 * refusal comes back carrying the API's own words, never as a thrown error
 * whose message a production build strips.
 */
export async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (error) {
    if (error instanceof ApiRequestError) {
      return {
        ok: false,
        error: error.body.message,
        name: error.body.name,
        status: error.status,
        body: error.body as unknown as Record<string, unknown>,
      }
    }
    const safe = safeFailure(error, "server action")
    return { ok: false, error: safe.message, name: safe.name, status: safe.statusCode }
  }
}
