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

/**
 * The per-field failures Clerk actually reported, when there are any.
 *
 * ⚠ THE TOP-LEVEL `code` ON AN API FAILURE IS ALWAYS THE LITERAL STRING
 * `"api_response_error"`, AND READING IT IS THE BUG THIS FUNCTION EXISTS TO
 * FIX. `ClerkAPIResponseError` extends `ClerkError` and hard-codes that code in
 * its constructor; every real code — `form_identifier_not_found`,
 * `form_password_incorrect`, `session_exists` — lives in the `errors` array it
 * builds beside it. So a branch on `error.code` does not merely fail to match,
 * it CANNOT match, on any failure that came back from Clerk's API.
 *
 * ⚠ IT COST US THE ENTIRE IDENTIFIER-FIRST FLOW. An unknown address is how
 * somebody tells us they are new, and the branch that starts their sign-up was
 * gated on a comparison that was always false — so the one page that exists to
 * send them onward showed Clerk's "Couldn't find your account." in a red toast
 * and sat there.
 *
 * ⚠ AND IT IS READ DEFENSIVELY, because `FlowError` is the union of everything
 * the flow methods can hand back. A runtime error, an offline error and a
 * plain `Error` all reach here with no `errors` at all.
 */
interface FieldFailure {
  code: string
  message: string
  longMessage?: string
}

function fieldFailures(error: FlowError): FieldFailure[] {
  const errors = (error as { errors?: unknown } | null)?.errors
  if (!Array.isArray(errors)) return []
  return errors.filter(
    (entry): entry is FieldFailure => typeof (entry as FieldFailure)?.code === "string",
  )
}

/**
 * Whether Clerk reported a particular failure, wherever it put it.
 *
 * ⚠ BOTH PLACES ARE CHECKED. A `ClerkRuntimeError` carries its code at the top
 * level and has no `errors`; an API failure is the other way round. One helper
 * so no caller has to remember which kind it is holding.
 */
function hasCode(error: FlowError, code: string): boolean {
  if (!error) return false
  if (error.code === code) return true
  return fieldFailures(error).some((entry) => entry.code === code)
}

export function messageFor(error: FlowError): string {
  if (!error) return FALLBACK
  const [first] = fieldFailures(error)
  return (
    first?.longMessage ??
    first?.message ??
    error.longMessage ??
    error.message ??
    FALLBACK
  )
}

/**
 * Clerk saying "there is no account with that identifier".
 *
 * ⚠ THIS IS NOT A FAILURE ON AN IDENTIFIER-FIRST PAGE, IT IS THE OTHER ANSWER.
 * One box asks for an email and the reply decides which flow the person is in:
 * a known address goes on to a password, an unknown one starts a sign-up. Only
 * `code` is safe to branch on — `message` is developer-facing and Clerk
 * documents it as unstable.
 *
 * ⚠ AND IT DOES NOT MAKE ACCOUNT ENUMERATION POSSIBLE WHERE IT WAS NOT. Two
 * separate pages already answered the same question from either side: sign-up
 * refused a taken address and sign-in refused an unknown one. Identifier-first
 * asks it once and out loud rather than twice by implication.
 */
export function isUnknownIdentifier(error: FlowError): boolean {
  return hasCode(error, "form_identifier_not_found")
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

/**
 * What to say when an OAuth round trip comes back without a session.
 *
 * ⚠ "That sign-in did not complete" WAS THE ONLY THING THIS PAGE EVER SAID, AND
 * IT IS THE ONE SENTENCE THAT HELPS NOBODY. Every one of these outcomes has a
 * different next step — sign up, sign in, use a different provider, contact
 * support — and a person told only that it "did not complete" has no way to
 * pick. The codes below are the ones clerk-js itself branches on, taken from
 * the shipped bundle rather than guessed.
 *
 * ⚠ THE PROVIDER IS NOT NAMED, DELIBERATELY. By the time the browser is back
 * here the attempt that knew which provider was used may already have been
 * replaced by the transfer, and a message that says "Google" when it was GitHub
 * is worse than one that says neither.
 */
const SSO_FAILURES: Record<string, string> = {
  // No i10 account is linked to that provider account. Normally invisible,
  // because the callback transfers this into a sign-up — it is reachable when
  // the instance refuses to create the account, e.g. sign-ups are restricted.
  external_account_not_found:
    "There is no i10 account for that yet, and we could not create one. Try signing up, or use a different provider.",
  // Already linked, on a page that was trying to create something new.
  external_account_exists:
    "That account is already connected to an i10 account. Sign in with it instead.",
  // The email is known, but it was registered a different way.
  external_account_strategy:
    "That email already has an i10 account created a different way. Sign in using the method you first signed up with.",
  user_locked: "That account is locked. Contact support to unlock it.",
  identifier_already_signed_in: "You are already signed in with that account.",
}

export const SSO_FALLBACK = "That sign-in did not complete. Try again."

export function ssoFailureMessage(code: string | null | undefined): string {
  return (code && SSO_FAILURES[code]) ?? SSO_FALLBACK
}
