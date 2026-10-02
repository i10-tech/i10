"use client"

import { ACCEPTED_HOLD_MS } from "@repo/ui/components/otp-field"
import type { SignInFlow } from "./clerk-types"
import { rememberDevice } from "./devices"
import { confirmSignIn } from "./last-used"
import { rememberSignedInAccount } from "./remembered"
import { forgetFlow } from "./resume"

/**
 * Leaving this app once a flow is done.
 *
 * ⚠ `replace`, NEVER `assign` OR `location.href` - HYGIENE, NOT THE PHONE BUG.
 * It was first written believing it was the fix for sign-up hanging on iOS; a
 * HAR from a real failing phone proved otherwise, and the actual cause is
 * documented on `finalizeAndLeave` below. It stays because it is still right:
 * assigning pushes a history entry, so the finished sign-up page sits one
 * gesture behind the dashboard - and iOS Safari's back-swipe is not a
 * deliberate act, it is what half a scroll near the left edge does. Restoring
 * that entry re-renders a sign-up form for somebody already signed in.
 * Replacing leaves nothing to go back to.
 */
/**
 * Whether this document is already on its way out to the destination.
 *
 * ⚠ MODULE STATE, NOT REACT STATE, ON PURPOSE. It has to survive a component
 * being re-created mid-exit: the MFA page's "go back to sign-in" fallback was
 * guarded by component state, a remount reset it, and its soft navigation to
 * /sign-in cancelled the `location.replace` to the dashboard - so a correct
 * code sometimes ended on the sign-in page. Nothing that navigates within
 * this app may run once this is true.
 */
let leaving = false
export const isLeaving = () => leaving

export function leaveFor(url: string) {
  if (leaving) return
  leaving = true
  /*
   * ⚠ THE "LAST USED" MARKER IS PROMOTED HERE, BECAUSE THIS IS THE ONE PLACE
   * EVERY SUCCESSFUL FLOW PASSES THROUGH. Password, SSO callback, passkey, MFA
   * and an already-signed-in session all leave through this function - so
   * recording it here cannot be forgotten by the sixth flow somebody adds
   * later, and the failure of forgetting is silent: a missing badge looks
   * exactly like a first visit. See _lib/last-used.ts for why it is promoted on
   * success rather than written on click.
   */
  const method = confirmSignIn()
  // The card on the sign-in page for next time - see _lib/remembered.ts.
  rememberSignedInAccount(method)
  // ⚠ AND THE STORED STEPS GO WITH IT - a finished flow must not come back as
  // a half-finished one the next time this tab opens the auth app.
  forgetFlow()
  /*
   * ⚠ THE DEVICE IS REMEMBERED BEFORE LEAVING, NOT AFTER (#192). It needs this
   * page's Clerk session to prove who signed in, and the cookie it sets lives
   * on this origin - neither exists once the browser is on the dashboard. It
   * is bounded, so a slow API delays leaving by at most a second and a half.
   */
  void rememberDevice().then(() => window.location.replace(carrySession(url)))
}

/**
 * Make sure the destination can find the session we just made.
 *
 * ⚠ THIS IS THE "CORRECT CODE, BACK AT SIGN-IN, WORKS THE SECOND TIME" BUG.
 * On a development instance every origin has its own Clerk "dev browser",
 * and a session only crosses to another subdomain inside the URL, as
 * `__clerk_db_jwt`. We relied on `decorateUrl` for that - but read clerk-js
 * 6.36: `decorateUrl` only rewrites the URL when
 * `client.isEligibleForTouch()`, which is Safari's ITP workaround. In Chrome
 * it hands the URL back untouched. So the dashboard checked ITS OWN dev
 * browser, found no session, and bounced to sign-in with its id - the auth
 * app adopted that id, and the second sign-in landed on the shared one and
 * worked. Proved on auth.i10.localhost 2026-10-01: touch-eligible false,
 * `buildUrlWithAuth` adds the token.
 *
 * ⚠ `buildUrlWithAuth` IS A NO-OP IN PRODUCTION (it returns the URL as is),
 * where the session is a cookie on the shared parent domain. A URL that
 * already carries the token (Safari's touch URL) is left alone.
 */
function carrySession(url: string): string {
  if (url.includes("__clerk_db_jwt")) return url
  const clerk = (window as { Clerk?: { buildUrlWithAuth?: (to: string) => string } })
    .Clerk
  try {
    return clerk?.buildUrlWithAuth?.(url) ?? url
  } catch {
    // "Missing dev browser": nothing to carry, so go as we are.
    return url
  }
}

/** The shape both `signIn.finalize` and `signUp.finalize` accept. */
type FinalizeParams = NonNullable<Parameters<SignInFlow["finalize"]>[0]>
type Navigate = NonNullable<FinalizeParams["navigate"]>

/**
 * Finish a flow and go where the person was heading.
 *
 * ⚠ THE NAVIGATION HAPPENS *AFTER* `finalize` RESOLVES, NOT INSIDE THE
 * `navigate` CALLBACK, AND THAT ORDERING IS THE WHOLE FIX FOR SIGN-UP HANGING
 * ON PHONES. Navigating from inside the callback loses a race with Clerk's own
 * Next.js integration. `@clerk/nextjs` installs two hooks that clerk-js calls
 * around `setActive`:
 *
 *     window.__internal_onBeforeSetActive = () => invalidateCacheAction()  // a Server Action
 *     window.__internal_onAfterSetActive  = () => router.refresh()
 *
 * and `setActive` awaits the second one after running our callback. So the old
 * code assigned `window.location`, the browser began a cross-origin navigation,
 * and then `router.refresh()` fired underneath it - its RSC fetch was cut off
 * by the navigation in progress, Next answered "Failed to fetch RSC payload,
 * falling back to browser navigation", and that fallback loaded /sign-up as a
 * full page. The pending redirect to the dashboard was cancelled, and the
 * person landed back on the sign-up form holding a perfectly good session.
 *
 * ⚠ IT IS A RACE, WHICH IS WHY IT LOOKED LIKE A PHONE-ONLY BUG. On a laptop the
 * redirect commits before the refresh can land, `isUnloading()` reports true,
 * and `setActive` returns early without ever calling `router.refresh()`. On a
 * phone the same redirect is slower - Safari's ITP workaround adds a hop
 * through FAPI's `/v1/client/touch` first - so the refresh wins. Same code,
 * opposite outcome, entirely down to which finished first.
 *
 * ⚠ `decorateUrl` IS STILL CALLED INSIDE THE CALLBACK, and it has to be. It is
 * only offered there, it is what produces the `/v1/client/touch` URL that lets
 * the session cookie survive ITP, and clerk-js warns in development when a
 * `navigate` callback fails to call it. We capture what it returns and act on
 * it a moment later; what changes is when we navigate, not what we navigate to.
 *
 * ⚠ AND `navigate` IS NOT ASSUMED TO RUN. A `finalize()` that resolves cleanly
 * without invoking it leaves the browser sitting on the auth page with a live
 * session and no error - so an uncaptured destination falls back to the plain
 * URL rather than to nothing happening.
 */
export async function finalizeAndLeave<R extends { error: unknown }>(
  finalize: (params: { navigate: Navigate }) => Promise<R>,
  afterAuthUrl: string,
  { holdAccepted = false }: { holdAccepted?: boolean } = {},
): Promise<R> {
  const shown = Date.now()
  const { result, leave } = await finalizeWithoutLeaving(finalize, afterAuthUrl)
  if (result.error) return result

  // A code screen showing its green check waits for it to land first.
  if (holdAccepted) await holdSince(shown)
  leave()
  return result
}

/**
 * Wait until the code field's accepted state has been on screen for
 * `ACCEPTED_HOLD_MS`, counting from when it appeared.
 *
 * ⚠ FROM WHEN IT APPEARED, NOT A FIXED PAUSE AFTER THE NETWORK. `finalize` is
 * usually most of the hold already; adding a full pause on top would make a
 * slow connection slower for no reason.
 */
export function holdSince(shown: number): Promise<void> {
  const left = ACCEPTED_HOLD_MS - (Date.now() - shown)
  return left > 0
    ? new Promise((resolve) => setTimeout(resolve, left))
    : Promise.resolve()
}

/**
 * Create the session, but stay on the page.
 *
 * ⚠ THIS EXISTS FOR THE STEPPED SIGN-UP, WHERE THREE STEPS COME *AFTER* THE
 * ACCOUNT IS REAL. Adding a passkey, enrolling an authenticator app and linking
 * a Google account are all things `UserResource` does, and `UserResource` does
 * not exist until a session does - which is what `finalize` creates. So the
 * flow has to finalize in the middle rather than at the end, and then leave
 * under its own steam once the person is done being offered things.
 *
 * ⚠ THE DECORATED URL IS CAPTURED NOW AND USED A MINUTE LATER, WHICH IS SAFE
 * AND WORTH SAYING WHY. `decorateUrl` is only offered inside this callback, so
 * there is no second chance to ask for it - `clerk.buildUrlWithAuth()` is NOT
 * an equivalent, its own type says "for development instances" and it does not
 * produce the production ITP hop. What it hands back is either a
 * `__clerk_db_jwt` query parameter (development, and that token long outlives a
 * sign-up) or a `/v1/client/touch?redirect_url=…` endpoint (production Safari),
 * and the touch endpoint acts on whatever cookies exist AT THE MOMENT IT IS
 * HIT. Neither is a short-lived credential, so holding it across the optional
 * steps costs nothing.
 *
 * ⚠ AND THE ORDERING RULE FROM `finalizeAndLeave` STILL APPLIES: nothing
 * navigates from inside the callback. See the note above it for the phone-shaped
 * bug that caused.
 */
export async function finalizeWithoutLeaving<R extends { error: unknown }>(
  finalize: (params: { navigate: Navigate }) => Promise<R>,
  afterAuthUrl: string,
): Promise<{ result: R; leave: () => void }> {
  let target: string | null = null
  const attempt = async (): Promise<R> => {
    try {
      return await finalize({
        navigate: ({ decorateUrl }) => {
          target = decorateUrl(afterAuthUrl)
        },
      })
    } catch (error) {
      // A throw is the same outcome as a returned error to every caller.
      return { error } as R
    }
  }

  /*
   * ⚠ ONE RETRY, BECAUSE THE CODE IS ALREADY SPENT. By here the person has
   * proved everything; what failed is turning the finished attempt into a
   * session, which is a single request to Clerk and is safe to repeat. A
   * one-off failure used to undo the whole sign-in and send them back to the
   * password, with no session behind them.
   *
   * ⚠ AND IT IS LOGGED. The dev servers forward the browser console, so the
   * next flaky failure arrives with Clerk's own reason attached.
   */
  let result = await attempt()
  if (result.error) {
    console.error("[auth] finalize failed, retrying once", result.error)
    await new Promise((resolve) => setTimeout(resolve, 400))
    result = await attempt()
    if (result.error) console.error("[auth] finalize failed again", result.error)
  }

  return { result, leave: () => leaveFor(target ?? afterAuthUrl) }
}

/**
 * Activate a session that a TRANSFER produced, then leave.
 *
 * ⚠ IT EXISTS BECAUSE A TRANSFER HAS NO `finalize()` TO CALL. `finalize` closes
 * the attempt you were already running; a transfer swaps one attempt for
 * another and hands back a session id directly, which is why clerk-js's own
 * redirect callback answers `case "complete"` with `setActive` rather than
 * with a finalize. Same ordering rule as `finalizeAndLeave` above, and for the
 * same reason: capture the decorated URL, let `setActive` finish its work -
 * including Clerk's Next.js hooks - and only then navigate.
 */
export async function setActiveAndLeave(
  setActive: (params: { session: string; navigate: Navigate }) => Promise<unknown>,
  sessionId: string,
  afterAuthUrl: string,
): Promise<void> {
  let target: string | null = null

  await setActive({
    session: sessionId,
    navigate: ({ decorateUrl }) => {
      target = decorateUrl(afterAuthUrl)
    },
  })

  leaveFor(target ?? afterAuthUrl)
}
