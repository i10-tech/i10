"use client"

import type * as React from "react"
import { cn } from "cn"

/**
 * A page's frame, remounted per page.
 *
 * ⚠ THE PAGE ARRIVES IN ONE FRAME, WITH NO FADE AND NO TRAVEL (2026-11-09).
 * It used to rise six pixels and fade up from 0 over 140ms. Since every click
 * now lands on the page's own skeleton (apps/console PageFrame), the arrival IS
 * the skeleton, and the reference motion (docs/decisions/skeletons.md, section
 * 5) puts content into loading in one frame: a fade from 0 painted a blank
 * frame first, and the rise moved the whole page. The resolve that follows is
 * the bones', in place.
 *
 * ⚠ IT IS KEYED ON THE PATHNAME, WHICH REMOUNTS THE PAGE ON EVERY NAVIGATION.
 * Page-level client state does not survive a route change, which is correct:
 * these are different screens, not tabs.
 */
export function PageTransition({
  pathname,
  children,
  className,
}: {
  /**
   * What counts as "a different page".
   *
   * ⚠ PASSED IN RATHER THAN READ FROM `usePathname` HERE, so a caller can
   * decide what a navigation means. A list page that puts its filters in the
   * query string does NOT want the whole screen to re-enter every time somebody
   * changes a filter - that is the same page with different rows, and animating
   * it would turn a refinement into a page load.
   */
  pathname: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div key={pathname} className={cn("flex min-h-0 flex-1 flex-col", className)}>
      {children}
    </div>
  )
}
