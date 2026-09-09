"use client"

import type { SignInFlow } from "./clerk-types"

/**
 * Leaving this app once a flow is done.
 *
 * ⚠ `replace`, NEVER `assign` OR `location.href`, AND THE DIFFERENCE IS A BUG
 * THAT ONLY SHOWED UP ON PHONES. Assigning pushes a history entry, so the
 * finished sign-up page stays one gesture behind the dashboard — and iOS
 * Safari's back-swipe is not a deliberate act, it is what half a scroll near
 * the left edge does. Restoring that entry from the back/forward cache
 * re-renders a sign-up form for somebody who is already signed in, on the
 * `?redirect_url=` URL they started at, which reads exactly like "it never
 * redirected me". Replacing leaves nothing to go back to.
 */
export function leaveFor(url: string) {
  window.location.replace(url)
}

/** The shape both `signIn.finalize` and `signUp.finalize` accept. */
type FinalizeParams = NonNullable<Parameters<SignInFlow["finalize"]>[0]>
type Navigate = NonNullable<FinalizeParams["navigate"]>

/**
 * Finish a flow and go where the person was heading.
 *
 * ⚠ IT DOES NOT TRUST `navigate` TO BE CALLED, AND THAT FALLBACK IS THE POINT.
 * Clerk invokes the callback "just before the session is set" — but only on the
 * paths that navigate. A `finalize()` that resolves cleanly without ever
 * calling it leaves the browser sitting on the auth page with a live session
 * and no error to show, which is the failure people describe as "it signed me
 * in and then did nothing". Tracking whether the callback ran, and navigating
 * ourselves if it did not, turns that into an ordinary redirect.
 *
 * ⚠ `decorateUrl` IS STILL USED ON THE PATH WHERE THE CALLBACK DOES RUN, and
 * skipping it would be worse than not having this helper. On Safari it carries
 * the handshake that lets the session cookie survive ITP; the bare URL is only
 * the fallback, for the case where Clerk offered us no decorated one.
 */
export async function finalizeAndLeave<R extends { error: unknown }>(
  finalize: (params: { navigate: Navigate }) => Promise<R>,
  afterAuthUrl: string,
): Promise<R> {
  let navigated = false

  const result = await finalize({
    navigate: ({ decorateUrl }) => {
      navigated = true
      leaveFor(decorateUrl(afterAuthUrl))
    },
  })

  if (!result.error && !navigated) leaveFor(afterAuthUrl)

  return result
}
