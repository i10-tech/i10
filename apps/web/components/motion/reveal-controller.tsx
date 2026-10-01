"use client"

import { usePathname } from "next/navigation"
import { useEffect } from "react"
import { gsap, prefersReducedMotion, ScrollTrigger } from "@/lib/gsap"

/*
 * One controller for every `[data-reveal]` on the page, mounted once in the
 * layout. Elements opt in with the attribute and nothing else; ScrollTrigger
 * batches the ones that enter together so a row of cards cascades instead of
 * popping as one block.
 *
 * `data-reveal-delay` (seconds) offsets a single element inside its batch.
 * The hidden start state lives in globals.css behind `.js`, so the first
 * paint already matches it.
 */
export function RevealController() {
  const pathname = usePathname()

  // Switches off the CSS fallback in globals.css: from here on, GSAP reveals.
  useEffect(() => {
    document.documentElement.dataset.hydrated = ""
  }, [])

  useEffect(() => {
    const els = gsap.utils.toArray<HTMLElement>("[data-reveal]")
    if (!els.length) return

    if (prefersReducedMotion()) {
      els.forEach((el) => (el.dataset.revealed = ""))
      return
    }

    const triggers = ScrollTrigger.batch(els, {
      start: "top 88%",
      once: true,
      interval: 0.08,
      batchMax: 8,
      onEnter: (batch) => {
        gsap.to(batch, {
          opacity: 1,
          y: 0,
          duration: 1,
          ease: "site.out",
          stagger: 0.07,
          delay: (_i: number, el: Element) =>
            Number((el as HTMLElement).dataset.revealDelay ?? 0),
          overwrite: true,
          // ⚠ MARK, DON'T clearProps. Clearing the inline transform hands the
          // element back to the CSS start state (translated 18px down) - the
          // attribute below is what switches that state off for good.
          onComplete() {
            for (const el of this.targets() as HTMLElement[]) {
              el.dataset.revealed = ""
              gsap.set(el, { clearProps: "opacity,transform" })
            }
          },
        })
      },
    })

    // Positions are known now; do not wait for window `load`, which a lazy
    // WebGL chunk can hold back for seconds.
    const frame = requestAnimationFrame(() => ScrollTrigger.refresh())

    return () => {
      cancelAnimationFrame(frame)
      triggers.forEach((t) => t.kill())
    }
  }, [pathname])

  return null
}
