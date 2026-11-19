"use client"

import * as React from "react"
import { usePathname } from "next/navigation"
import { isWarm } from "@/lib/revisits"

/**
 * Where the person just asked to go, until Next commits it.
 *
 * ⚠ THIS IS WHAT SHOWS A PAGE'S SKELETON THE MOMENT IT IS CLICKED. A page's
 * loading.tsx belongs to the page's own segment, so the browser only has it
 * once the server has answered - or once a prefetch has, and Next prefetches
 * in production only. In dev every click sat on the old page for 200-600ms and
 * then showed the finished page: no skeleton at all (2026-11-05). The catch-all
 * (app)/loading.tsx used to cover that gap, as a second, generic skeleton before
 * the page's own. Knowing the destination at the click lets PageFrame draw the
 * destination's own skeleton instead, from the browser alone (components/
 * instant-skeleton.tsx).
 */
export interface PendingNavigation {
  pathname: string
  search: string
  /** The page the click came from, which decides who draws the skeleton. */
  from: string
  /** When it was asked for (`performance.now()`), for the hold below. */
  at: number
  /**
   * A page Next most likely still has (lib/revisits.ts): it appears whole, so no
   * skeleton is drawn over the page being left and none is held.
   */
  warm: boolean
}

/*
 * ⚠ A SKELETON WITH BARS STAYS UP AT LEAST THIS LONG FROM THE CLICK
 * (2026-11-17). Next commits in 200-600ms in dev and in about nothing in
 * production, where links are prefetched. The skeleton was on screen for a
 * frame or a few, its 1.8s pulse never moved, and the resolve played straight
 * out of it: the page read as a flicker, not as loading then arriving. Held,
 * the bars are seen standing before they resolve. The price, accepted: a page
 * in the router cache that is not known to be there waits the same 400ms. A
 * kept page known to be there (`warm`) draws no skeleton and waits for nothing.
 */
const MIN_SKELETON_MS = 400

let pending: PendingNavigation | null = null
let expiry: ReturnType<typeof setTimeout> | undefined
let hold: ReturnType<typeof setTimeout> | undefined
const listeners = new Set<() => void>()

function set(next: PendingNavigation | null) {
  if (next === pending) return
  pending = next
  clearTimeout(expiry)
  clearTimeout(hold)
  /*
   * ⚠ A SAFETY, NOT A TIMING. A navigation that never commits - an anchor whose
   * click some handler swallowed, a request that died - must not leave a
   * skeleton over a page that is still there. Ten seconds outlasts a cold dev
   * compile; anything slower has bigger problems than this.
   */
  if (next) expiry = setTimeout(() => set(null), 10_000)
  for (const listener of listeners) listener()
}

/** Call before `router.push` to a page: links are seen on their own. */
export function announceNavigation(href: string) {
  const url = new URL(href, window.location.href)
  if (url.origin !== window.location.origin) return
  // The same page with other filters is not a page load (see PageFrame).
  if (url.pathname === window.location.pathname) return
  set({
    pathname: url.pathname,
    search: url.search,
    from: window.location.pathname,
    at: performance.now(),
    warm: isWarm(url.pathname + url.search),
  })
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function usePendingNavigation(): PendingNavigation | null {
  return React.useSyncExternalStore(
    subscribe,
    () => pending,
    () => null,
  )
}

/**
 * The page the person is on or has just asked for.
 *
 * ⚠ FOR THE CHROME THAT NAMES THE PAGE (the rail's highlight, the breadcrumb).
 * `usePathname` moves when Next commits, which is the moment the server
 * answers: 150-300ms in dev, about nothing in production where links are
 * prefetched. Following the click instead makes the highlight land at the same
 * moment everywhere, together with the skeleton (2026-11-09).
 */
export function useDestinationPathname(): string {
  const pathname = usePathname()
  return usePendingNavigation()?.pathname ?? pathname
}

/**
 * Watches for navigations and settles them. Mount once, in the shell.
 *
 * ⚠ ANY PATHNAME CHANGE SETTLES, NOT ONLY THE ONE ANNOUNCED. A page that
 * redirects lands somewhere else, and back and forward never announce at all;
 * either way what was pending is over. Only the page that was asked for is
 * held (`MIN_SKELETON_MS`).
 *
 * ⚠ NO BARS, NO HOLD. An empty page's skeleton is its empty state, and a page
 * of static copy has nothing to resolve: holding those is a wait in which
 * nothing changes. The skeleton is what is in `main` right now, so its bars are
 * asked of the DOM.
 *
 * ⚠ A LAYOUT EFFECT, so a navigation that is not held swaps the page in before
 * the browser paints, as it did before there was a hold.
 */
export function useNavigationIntent() {
  const pathname = usePathname()
  React.useLayoutEffect(() => {
    const held = pending
    if (!held) return
    const left = MIN_SKELETON_MS - (performance.now() - held.at)
    const bars =
      held.pathname === pathname &&
      document.querySelector("main [data-bone-bar]") !== null
    if (left <= 0 || !bars || held.warm) return set(null)
    hold = setTimeout(() => {
      if (pending === held) set(null)
    }, left)
  }, [pathname])

  React.useEffect(() => {
    let armed: string | null = null
    function onClick(event: MouseEvent) {
      if (
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return
      const anchor = (event.target as Element | null)?.closest?.("a[href]")
      if (!(anchor instanceof HTMLAnchorElement)) return
      if (
        (anchor.target && anchor.target !== "_self") ||
        anchor.hasAttribute("download")
      )
        return
      // A link that does something else on this click says so (a template card
      // while picking ticks instead of opening).
      if (anchor.dataset.navigates === "false") return
      armed = anchor.href
      // A handler that stops propagation hides the click from `afterClick`.
      setTimeout(afterClick, 0)
    }
    function afterClick() {
      if (armed === null) return
      const href = armed
      armed = null
      announceNavigation(href)
    }
    const onPop = () => set(null)
    /*
     * ⚠ NOTED IN CAPTURE, ANNOUNCED AFTER REACT HAS HANDLED THE CLICK
     * (2026-11-17). Announcing re-renders at once, in the microtask after this
     * listener and before React dispatches the click: the skeleton replaced the
     * page body and the rail left settings, so the clicked <Link> was already
     * unmounted when React looked for its onClick. Nothing prevented the
     * default, and every link the skeleton covers - domain rows, settings tabs,
     * "Back to the dashboard" - reloaded the whole page. `window` in the bubble
     * phase runs after React's root listener, still within the click.
     */
    document.addEventListener("click", onClick, true)
    window.addEventListener("click", afterClick)
    window.addEventListener("popstate", onPop)
    return () => {
      document.removeEventListener("click", onClick, true)
      window.removeEventListener("click", afterClick)
      window.removeEventListener("popstate", onPop)
    }
  }, [])
}
