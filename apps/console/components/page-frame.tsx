"use client"

import { usePathname } from "next/navigation"
import { PageTransition } from "@repo/ui/components/page-transition"

/**
 * The console's pages, arriving rather than appearing.
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
 */
export function PageFrame({ children }: { children: React.ReactNode }) {
  return <PageTransition pathname={usePathname()}>{children}</PageTransition>
}
