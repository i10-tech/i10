"use client"

import { usePathname } from "next/navigation"
import { useEffect, useRef } from "react"
import { PageTransition } from "@repo/ui/components/page-transition"

/**
 * The console's pages, arriving rather than appearing — and the only thing on
 * the screen that scrolls.
 *
 * ⚠ A CLIENT COMPONENT WRAPPING SERVER-RENDERED CHILDREN, WHICH COSTS NOTHING.
 * `children` arrives as an already-rendered prop, so the pages themselves stay
 * server components and nothing about them enters the client bundle — only this
 * file and `usePathname` do. Same arrangement as `MotionProvider`.
 *
 * ⚠ `usePathname` EXCLUDES THE QUERY STRING, AND THAT IS EXACTLY THE BEHAVIOUR
 * WANTED. Half the list pages in this console keep their filters and their date
 * range in the URL — `?days=7`, `?status=bounced` — and every one of those is
 * the same screen showing different rows. Re-entering the whole page on a filter
 * change would turn a refinement into something that looks like a page load,
 * which is the opposite of the point.
 *
 * ⚠ THE SCROLLBAR IS HERE RATHER THAN ON THE DOCUMENT, and that is what keeps
 * the rail still — see the shell in app/(app)/layout.tsx. Everything that
 * follows is the price of moving it, paid once, here.
 */
export function PageFrame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const pane = useRef<HTMLElement>(null)

  /*
   * ⚠ NAVIGATION HAS TO PUT US BACK AT THE TOP BY HAND NOW. Next resets
   * `window.scrollTo(0, 0)` on a route change, and the window no longer
   * scrolls — so without this, opening a domain from row 200 of the log lands
   * on the new page already scrolled 4,000 pixels down, showing whatever
   * happens to be at that offset. It looks like the page failed to load.
   *
   * ⚠ AND IT IS KEYED ON THE PATHNAME, NOT ON EVERY RENDER, for the same
   * reason the transition is: changing a filter keeps you where you were
   * reading, which is the whole point of putting filters in the query string.
   *
   * ⚠ `behavior: "instant"`, NEVER SMOOTH. A smooth scroll here would race the
   * page's own enter animation, and it animates the OUTGOING scroll position
   * across content that has already been replaced.
   */
  useEffect(() => {
    pane.current?.scrollTo({ top: 0, behavior: "instant" })
  }, [pathname])

  return (
    /*
     * ⚠ `min-h-0` IS LOAD-BEARING. A flex child defaults to `min-height: auto`,
     * which refuses to shrink below its content — so `overflow-y-auto` would
     * never have anything to do and the shell would overflow instead.
     *
     * ⚠ `overscroll-contain` STOPS THE SCROLL CHAINING OUT of the pane at the
     * ends. There is nothing behind it to scroll, but on macOS and iOS the
     * chain turns into the document's rubber-band, which drags the rail with
     * it — the exact movement the fixed shell exists to remove.
     */
    <main
      ref={pane}
      className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain"
    >
      <PageTransition pathname={pathname}>{children}</PageTransition>
    </main>
  )
}
