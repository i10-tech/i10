"use client"

import type { SignInFlow } from "./clerk-types"
import { confirmSignIn } from "./last-used"

/**
 * Leaving this app once a flow is done.
 *
 * ⚠ `replace`, NEVER `assign` OR `location.href` — HYGIENE, NOT THE PHONE BUG.
 * It was first written believing it was the fix for sign-up hanging on iOS; a
 * HAR from a real failing phone proved otherwise, and the actual cause is
 * documented on `finalizeAndLeave` below. It stays because it is still right:
 * assigning pushes a history entry, so the finished sign-up page sits one
 * gesture behind the dashboard — and iOS Safari's back-swipe is not a
 * deliberate act, it is what half a scroll near the left edge does. Restoring
 * that entry re-renders a sign-up form for somebody already signed in.
 * Replacing leaves nothing to go back to.
 */
export function leaveFor(url: string) {
  /*
   * ⚠ THE "LAST USED" MARKER IS PROMOTED HERE, BECAUSE THIS IS THE ONE PLACE
   * EVERY SUCCESSFUL FLOW PASSES THROUGH. Password, SSO callback, passkey, MFA
   * and an already-signed-in session all leave through this function — so
   * recording it here cannot be forgotten by the sixth flow somebody adds
   * later, and the failure of forgetting is silent: a missing badge looks
   * exactly like a first visit. See _lib/last-used.ts for why it is promoted on
   * success rather than written on click.
   */
  confirmSignIn()
  window.location.replace(url)
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
 * and then `router.refresh()` fired underneath it — its RSC fetch was cut off
 * by the navigation in progress, Next answered "Failed to fetch RSC payload,
 * falling back to browser navigation", and that fallback loaded /sign-up as a
 * full page. The pending redirect to the dashboard was cancelled, and the
 * person landed back on the sign-up form holding a perfectly good session.
 *
 * ⚠ IT IS A RACE, WHICH IS WHY IT LOOKED LIKE A PHONE-ONLY BUG. On a laptop the
 * redirect commits before the refresh can land, `isUnloading()` reports true,
 * and `setActive` returns early without ever calling `router.refresh()`. On a
 * phone the same redirect is slower — Safari's ITP workaround adds a hop
 * through FAPI's `/v1/client/touch` first — so the refresh wins. Same code,
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
 * session and no error — so an uncaptured destination falls back to the plain
 * URL rather than to nothing happening.
 */
export async function finalizeAndLeave<R extends { error: unknown }>(
  finalize: (params: { navigate: Navigate }) => Promise<R>,
  afterAuthUrl: string,
): Promise<R> {
  let target: string | null = null

  const result = await finalize({
    navigate: ({ decorateUrl }) => {
      // ⚠ CAPTURE ONLY. Navigating here is the bug described above.
      target = decorateUrl(afterAuthUrl)
    },
  })

  if (result.error) return result

  leaveFor(target ?? afterAuthUrl)

  return result
}

/**
 * Activate a session that a TRANSFER produced, then leave.
 *
 * ⚠ IT EXISTS BECAUSE A TRANSFER HAS NO `finalize()` TO CALL. `finalize` closes
 * the attempt you were already running; a transfer swaps one attempt for
 * another and hands back a session id directly, which is why clerk-js's own
 * redirect callback answers `case "complete"` with `setActive` rather than
 * with a finalize. Same ordering rule as `finalizeAndLeave` above, and for the
 * same reason: capture the decorated URL, let `setActive` finish its work —
 * including Clerk's Next.js hooks — and only then navigate.
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
