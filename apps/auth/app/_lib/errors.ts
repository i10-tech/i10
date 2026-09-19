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
  return error?.code === "form_identifier_not_found"
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
