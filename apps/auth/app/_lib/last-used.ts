"use client"

import { useSyncExternalStore } from "react"

/**
 * Which way this browser signed in last.
 *
 * ⚠ IT EXISTS TO STOP PEOPLE CREATING A SECOND ACCOUNT. Somebody who signed up
 * with Google six months ago comes back, does not remember, types their email
 * and a password, and is told the password is wrong — or worse, signs up again
 * and now has two accounts with the same address and none of their data in the
 * one they are looking at. A badge on the button they used last is the whole
 * intervention, and it is why every product that offers more than one method
 * eventually adds one.
 *
 * ⚠ IT IS RECORDED ON SUCCESS, NOT ON CLICK, AND THE DIFFERENCE IS THE POINT OF
 * THE TWO-STAGE STORAGE BELOW. A click is an intention; it is not evidence.
 * Somebody who clicks Google, thinks better of it on the consent screen, comes
 * back and signs in with a password would otherwise be shown "Last used" over
 * Google for ever — advice that is not merely useless but actively wrong, on
 * the one screen where being wrong sends people to create a duplicate account.
 * So a click writes a PENDING marker, and only reaching the session writes the
 * real one.
 *
 * ⚠ THE PENDING MARKER IS `sessionStorage` BECAUSE IT HAS TO SURVIVE A ROUND
 * TRIP THROUGH GOOGLE. The tab leaves this origin and comes back to it, which
 * `sessionStorage` survives and an in-memory variable does not. It is also
 * per-tab, so two tabs mid-flow with different providers do not overwrite each
 * other's attempt.
 *
 * ⚠ AND IT IS NOT AN IDENTITY OR A CREDENTIAL. It is the NAME of a method —
 * "oauth_google", "password" — on the person's own device. It says nothing
 * about who they are, which is why it can live in storage a script on this
 * origin can read at all. Nothing here may ever hold an address or a token.
 *
 * ⚠ EVERY ACCESS IS WRAPPED. `localStorage` throws outright in a Safari private
 * window and in any browser configured to block site data, and a sign-in page
 * that throws before it renders is a sign-in page nobody can use. A badge is
 * worth exactly zero risk to the form under it.
 */

const CONFIRMED = "i10_last_sign_in_method"
const PENDING = "i10_pending_sign_in_method"

/** The ids this records. Matches an SSO strategy, or one of our own flows. */
export type SignInMethod = string

/** Somebody started a flow. Not yet evidence of anything. */
export function markSignInAttempt(method: SignInMethod): void {
  try {
    window.sessionStorage.setItem(PENDING, method)
  } catch {
    // Storage is blocked. The badge is a convenience; the flow is not.
  }
}

/**
 * A session exists. Promote whatever was attempted.
 *
 * ⚠ CALLED FROM `_lib/finish.ts`, WHICH IS THE ONE PLACE EVERY SUCCESSFUL FLOW
 * PASSES THROUGH. Calling it from each form instead would be five call sites
 * and a sixth flow added later that nobody remembers to update — and the
 * failure of that omission is silent, because a missing badge looks exactly
 * like a first visit.
 */
export function confirmSignIn(): void {
  try {
    const pending = window.sessionStorage.getItem(PENDING)
    if (!pending) return
    window.localStorage.setItem(CONFIRMED, pending)
    window.sessionStorage.removeItem(PENDING)
  } catch {
    // As above.
  }
}

/** What to badge, or `null` on a browser that has never finished a sign-in. */
export function lastSignInMethod(): SignInMethod | null {
  try {
    return window.localStorage.getItem(CONFIRMED)
  } catch {
    return null
  }
}

/**
 * The confirmed method, as a hook that does not trip hydration.
 *
 * ⚠ `useSyncExternalStore` RATHER THAN `useState` PLUS AN EFFECT, and the
 * reason is not style. Reading `localStorage` during render produces one result
 * on the server (there is no storage) and another in the browser, which React
 * reports as a hydration mismatch and resolves by discarding the server markup.
 * Setting it from an effect avoids that and is what the React Compiler's
 * `set-state-in-effect` rule exists to reject — correctly, because it renders
 * once with the wrong value and immediately again with the right one. This hook
 * is the API designed for exactly this shape: a server snapshot of `null`, a
 * client snapshot read on demand.
 *
 * ⚠ THE SNAPSHOT RETURNS A STRING OR `null`, NEVER AN OBJECT. React calls
 * `getSnapshot` on every render and bails out only when the result is `===` to
 * the last one; a fresh object each time is an infinite render loop.
 *
 * ⚠ AND IT SUBSCRIBES TO `storage`, so signing in in another tab updates this
 * one. That event does not fire in the tab that made the change, which is
 * exactly right here — the tab that just signed in has already left.
 */
export function useLastSignInMethod(): SignInMethod | null {
  return useSyncExternalStore(subscribe, lastSignInMethod, serverSnapshot)
}

const subscribe = (onChange: () => void) => {
  window.addEventListener("storage", onChange)
  return () => window.removeEventListener("storage", onChange)
}

// ⚠ ALWAYS `null` ON THE SERVER. There is no storage there, and pretending
// otherwise is the hydration mismatch this hook exists to avoid.
const serverSnapshot = () => null
