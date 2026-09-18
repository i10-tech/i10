import "server-only"
import type { ApiError } from "@/lib/api"

/**
 * What a failure is allowed to say to the person looking at the screen.
 *
 * ⚠ THIS EXISTS BECAUSE THE CONSOLE USED TO PUT `error.message` ON SCREEN
 * VERBATIM, AND MOST OF THOSE MESSAGES ARE NOT OURS TO SHOW. Two call sites —
 * `run()` in lib/actions.ts and `tryApi()` in lib/api.ts — both ended with
 * `error instanceof Error ? error.message : …`, which is correct for an error
 * the API wrote and wrong for every other kind. What actually reaches that
 * branch is the runtime's own wording:
 *
 *   getaddrinfo ENOTFOUND i10-api.i10-prod.svc.cluster.local
 *   Unable to connect. Is the computer able to access the url?
 *   Cannot read properties of undefined (reading 'plan')
 *
 * The first publishes our internal service naming and namespace to anybody who
 * can make the API unreachable for a moment. The third is a map of where the
 * code is fragile, offered to whoever can produce the input that breaks it.
 * Neither tells the customer a single thing they can act on.
 *
 * ⚠ THE REPLACEMENT IS VAGUE ABOUT THE CAUSE AND SPECIFIC ABOUT THE REMEDY,
 * which is the only split that is both safe and useful. "Something went wrong"
 * on its own is a dead end; "we could not reach the service, try again shortly"
 * names no internals and tells somebody whether waiting will help.
 *
 * ⚠ AND THE REAL ERROR IS NOT DISCARDED — IT IS LOGGED. Sanitising without
 * logging would trade a customer-facing leak for an operator-facing blind spot,
 * which is a worse deal: the leak is at least visible.
 */

/**
 * ⚠ THE API'S OWN MESSAGES PASS THROUGH UNTOUCHED, AND THAT IS DELIBERATE.
 * They are written for the customer — "You have used your sending allowance for
 * this period", "That domain is already verified on another workspace" — and
 * they are the only actionable thing on the screen. Replacing them with a
 * generic apology is the failure mode this function is trying to avoid, in the
 * opposite direction.
 */
export function isCustomerFacing(error: unknown): error is { body: ApiError } {
  return (
    typeof error === "object" &&
    error !== null &&
    "body" in error &&
    typeof (error as { body?: { message?: unknown } }).body?.message === "string"
  )
}

/**
 * ⚠ MATCHED ON THE WHOLE CAUSE CHAIN, NOT JUST THE TOP MESSAGE. `fetch failed`
 * is what bun and undici throw for every transport problem, with the useful
 * part — ECONNREFUSED, ENOTFOUND, the timeout — hidden one level down in
 * `cause`. Reading only the top would classify every network failure as
 * "unknown" and lose the one distinction worth drawing.
 */
function chain(error: unknown, depth = 4): string {
  if (depth <= 0 || error === null || error === undefined) return ""
  if (typeof error !== "object") return String(error)

  const e = error as { message?: unknown; code?: unknown; cause?: unknown }
  const here = [e.message, e.code].filter((v) => typeof v === "string").join(" ")
  return `${here} ${chain(e.cause, depth - 1)}`.trim()
}

const UNREACHABLE =
  /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|ETIMEDOUT|UND_ERR|fetch failed|Unable to connect|socket hang up/i

const TIMED_OUT = /AbortError|TimeoutError|timed out|ETIMEDOUT/i

/**
 * Turn any thrown thing into something this console is willing to display.
 *
 * `context` names the operation for the log line only — it is never shown.
 */
export function safeFailure(error: unknown, context: string): ApiError {
  if (isCustomerFacing(error)) return error.body

  const detail = chain(error)

  // ⚠ `console.error` RATHER THAN A LOGGER, BECAUSE THE CONSOLE HAS NONE. Next's
  // server output is collected by the pod's stdout the same way the API's pino
  // lines are; a real logger here would be a dependency and a configuration for
  // one call site. What matters is that the detail survives somewhere.
  console.error(
    `[console] ${context} failed:`,
    error instanceof Error ? (error.stack ?? error.message) : error,
  )

  if (TIMED_OUT.test(detail)) {
    return {
      statusCode: 504,
      name: "gateway_timeout",
      message: "That took too long to answer. Try again in a moment.",
    }
  }

  if (UNREACHABLE.test(detail)) {
    return {
      statusCode: 503,
      name: "service_unavailable",
      message:
        "We could not reach the service just now. This is on our side — try again shortly.",
    }
  }

  return {
    statusCode: 500,
    name: "internal_server_error",
    // ⚠ IT DOES NOT PROMISE THAT NOTHING CHANGED, AND THE TEMPTATION TO SAY SO
    // IS WORTH RESISTING. A mutation that throws on the way back has already
    // been applied; telling somebody their change did not land, when it did,
    // makes them do it twice.
    message: "Something went wrong on our side. Try again in a moment.",
  }
}
