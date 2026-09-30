"use client"

import Link from "next/link"
import { useEffect, useRef } from "react"
import { Mark } from "@/components/brand/mark"

/*
 * Cloudflare's hand-off: the nav's logo does not sit on screen beside the
 * footer's. When this mark scrolls into view it sets `data-footer-logo` on
 * <html>; the nav logo drops down and out, and this one drops in from above,
 * so the i10 reads as having moved from the bar into the footer. Scrolling
 * back up plays it in reverse.
 *
 * The CSS lives in globals.css (.nav-logo / .footer-logo) and is gated on
 * `.js`, so without JavaScript both marks simply stay visible.
 */
export function FooterLogo() {
  const ref = useRef<HTMLAnchorElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const root = document.documentElement
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) root.dataset.footerLogo = ""
        else delete root.dataset.footerLogo
      },
      // In once the mark is clear of the bottom edge by a little.
      { rootMargin: "0px 0px -12% 0px" },
    )
    io.observe(el)
    return () => {
      io.disconnect()
      delete root.dataset.footerLogo
    }
  }, [])

  return (
    <Link ref={ref} href="/" aria-label="i10 home" className="footer-logo w-fit text-brand">
      <Mark className="h-5 w-auto" shapeRendering="geometricPrecision" />
    </Link>
  )
}
