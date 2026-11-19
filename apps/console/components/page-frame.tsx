"use client"

import { usePathname } from "next/navigation"
import { useEffect, useRef } from "react"
import { cn } from "cn"
import { PageTransition } from "@repo/ui/components/i10/page-transition"
import { frameKey, SkeletonFor, usePendingSkeleton } from "@/components/section-frame"
import { forgetDraft } from "@/lib/add-domain-draft"
import { useNavigationIntent } from "@/lib/pending-navigation"
import { useWorkspaceSwitch } from "@/lib/workspace-switch"

/**
 * The console's pages, arriving rather than appearing - and the only thing on
 * the screen that scrolls.
 *
 * ⚠ A CLIENT COMPONENT WRAPPING SERVER-RENDERED CHILDREN, WHICH COSTS NOTHING.
 * `children` arrives as an already-rendered prop, so the pages themselves stay
 * server components and nothing about them enters the client bundle - only this
 * file and `usePathname` do. Same arrangement as `MotionProvider`.
 *
 * ⚠ `usePathname` EXCLUDES THE QUERY STRING, AND THAT IS EXACTLY THE BEHAVIOUR
 * WANTED. Half the list pages in this console keep their filters and their date
 * range in the URL - `?days=7`, `?status=bounced` - and every one of those is
 * the same screen showing different rows. Re-entering the whole page on a filter
 * change would turn a refinement into something that looks like a page load,
 * which is the opposite of the point.
 *
 * ⚠ THE SCROLLBAR IS HERE RATHER THAN ON THE DOCUMENT, and that is what keeps
 * the rail still - see the shell in app/(app)/layout.tsx. Everything that
 * follows is the price of moving it, paid once, here.
 */
export function PageFrame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const pane = useRef<HTMLElement>(null)
  const { pending } = useWorkspaceSwitch()
  const stale = pending !== null
  useNavigationIntent()
  /*
   * ⚠ THE DESTINATION'S OWN SKELETON FROM THE CLICK, KEYED AS THAT PAGE. The
   * transition enters it as the new page, so when Next commits, the same frame
   * keeps standing and only its contents change: skeleton to content, the swap
   * the bones resolve across (lib/pending-navigation.ts says why).
   */
  const going = usePendingSkeleton("frame")

  /*
   * ⚠ NAVIGATION HAS TO PUT US BACK AT THE TOP BY HAND NOW. Next resets
   * `window.scrollTo(0, 0)` on a route change, and the window no longer
   * scrolls - so without this, opening a domain from row 200 of the log lands
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
  // From the skeleton at the click, when there is one: that is the new page arriving.
  const shown = going?.pathname ?? pathname
  useEffect(() => {
    pane.current?.scrollTo({ top: 0, behavior: "instant" })
  }, [shown])

  /*
   * ⚠ ARRIVING ANYWHERE BUT THE ADD-DOMAIN FLOW ENDS IT. Its draft survives a
   * reload and nothing else - see lib/add-domain-draft.ts. Here rather than in
   * the form because this runs the moment the route changes, not when the
   * leaving page's exit animation finally lets it unmount.
   */
  useEffect(() => {
    if (pathname !== "/domains/new") forgetDraft()
  }, [pathname])

  return (
    /*
     * ⚠ `min-h-0` IS LOAD-BEARING. A flex child defaults to `min-height: auto`,
     * which refuses to shrink below its content - so `overflow-y-auto` would
     * never have anything to do and the shell would overflow instead.
     *
     * ⚠ `overscroll-contain` STOPS THE SCROLL CHAINING OUT of the pane at the
     * ends. There is nothing behind it to scroll, but on macOS and iOS the
     * chain turns into the document's rubber-band, which drags the rail with
     * it - the exact movement the fixed shell exists to remove.
     */
    <main
      ref={pane}
      className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain"
    >
      {/*
       * ⚠ VISIBLY STALE WHILE SWITCHING WORKSPACES.
       * Dims to 0.5 opacity, marks inert so old rows cannot be clicked, and
       * sets aria-busy. Returns to full opacity when the fresh tree commits.
       */}
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col transition-opacity duration-(--duration-fast) ease-(--ease-standard) motion-reduce:transition-none",
          stale && "opacity-50",
        )}
        aria-busy={stale ? true : undefined}
        inert={stale ? true : undefined}
      >
        <PageTransition pathname={frameKey(shown)}>
          {going ? <SkeletonFor pending={going} framed /> : children}
        </PageTransition>
      </div>
    </main>
  )
}
