import type { FlowError } from "./clerk-types"

/**
 * What to show somebody when a flow fails.
 *
 * ⚠ THE FLOW METHODS RETURN THEIR ERRORS, THEY DO NOT THROW THEM. Clerk's
 * custom-flow API answers `{ error: ClerkError | null }` from every call, so a
 * handler wrapped in try/catch and nothing else compiles, runs, and silently
 * treats every failure as a success — a wrong password would finalize a sign-in
 * that never happened and navigate to the dashboard. The `error` field has to
 * be read on every single call. try/catch is still worth having, but only for
 * the transport blowing up underneath.
 *
 * ⚠ `longMessage` FIRST. Clerk documents `message` as developer-facing and
 * explicitly unstable; `longMessage` is the sentence written for the person who
 * hit it. `code` is the only field safe to branch on.
 */
const FALLBACK = "Something went wrong. Try again."

export function messageFor(error: FlowError): string {
  if (!error) return FALLBACK
  return error.longMessage ?? error.message ?? FALLBACK
}

/**
 * For the `catch` arm: a transport failure, not a verdict from Clerk.
 *
 * ⚠ IT MUST NOT MENTION CREDENTIALS. A dropped connection reported as
 * "incorrect password" sends somebody to reset a password that was fine — the
 * same rule the API follows in answering 503 rather than 401 when Clerk cannot
 * be reached.
 */
export const TRANSPORT_FAILURE = "We could not reach the server. Try again."
