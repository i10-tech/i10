"use client"

import { useEffect } from "react"

declare global {
  interface Window {
    __internal_onBeforeSetActive?: (intent?: string) => Promise<void> | void
  }
}

/**
 * Stop Clerk re-rendering the page we are about to leave (#152).
 *
 * ⚠ THIS IS THE FLASH AFTER SIGNING IN. `@clerk/nextjs` installs
 * `window.__internal_onBeforeSetActive`, which clerk-js awaits inside every
 * `setActive` - and so inside every `finalize()` - BEFORE our navigation runs.
 * It calls `invalidateCacheAction`, a Server Action whose whole body is
 * `cookies().delete(...)`. Next treats any cookie change in a Server Action as
 * a revalidation (`isCookieRevalidated` in the action handler) and answers
 * with a fresh render of the CURRENT route. So in the gap between the session
 * existing and `leaveFor` replacing the location, /sign-in (or /mfa) was
 * rendered again on the server, its environment fetches re-run, and the new
 * tree was applied to a page that was meant to be standing still in its
 * success state.
 *
 * ⚠ AND, LIKE THE `router.refresh()` IN layout.tsx, IT BUYS THIS APP NOTHING.
 * The invalidation exists so a later soft navigation in the same app does not
 * reuse a page cached under the old auth state. Every flow here leaves for
 * another origin with `location.replace` once a session exists; there is no
 * later soft navigation to protect. apps/console is the opposite case and must
 * keep Clerk's default.
 *
 * ⚠ A PASSIVE EFFECT, ON PURPOSE. Clerk installs its hook in a LAYOUT effect
 * in the provider above us, with no dependencies. Layout effects all run
 * before any passive effect, so this one lands second and stays - in a layout
 * effect it would run first (children before parents) and be overwritten.
 * It is an `__internal_` name; if the flash comes back after a Clerk upgrade,
 * check that the hook is still called this.
 */
export function NoCacheInvalidation() {
  useEffect(() => {
    window.__internal_onBeforeSetActive = () => Promise.resolve()
  }, [])
  return null
}
