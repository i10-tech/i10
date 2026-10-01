"use client"

import Lenis from "lenis"
import { MotionConfig } from "motion/react"
import { usePathname } from "next/navigation"
import { createContext, useContext, useEffect, useState, type ReactNode } from "react"
import { gsap, prefersReducedMotion, ScrollTrigger } from "@/lib/gsap"

const LenisContext = createContext<Lenis | null>(null)

export const useLenis = () => useContext(LenisContext)

/*
 * Smooth scroll, driven by GSAP's ticker so Lenis and every ScrollTrigger read
 * the same frame. Two clocks - Lenis on its own rAF and ScrollTrigger on
 * GSAP's - is the classic source of pinned sections that shiver by a pixel.
 *
 * Tuning, arrived at by feel against lenis.dev and Linear:
 *  - `lerp` 0.13: quicker than Lenis's 0.1 default. Still a glide, but the
 *    page catches up with the wheel fast enough never to feel late.
 *  - `wheelMultiplier` 1.15: a notch past native distance per wheel tick;
 *    at 0.95 the page read as slow to cover.
 *  - touch stays native (`syncTouch` off). Smoothed touch fights the OS's own
 *    momentum and feels wrong on every phone it has ever shipped on.
 *
 * ⚠ OFF UNDER prefers-reduced-motion. Smoothed scrolling is motion; someone
 * who asked the OS for less of it gets the browser's own scroll.
 */
export function SmoothScroll({ children }: { children: ReactNode }) {
  const [lenis, setLenis] = useState<Lenis | null>(null)
  const pathname = usePathname()

  useEffect(() => {
    if (prefersReducedMotion()) return

    const instance = new Lenis({
      lerp: 0.13,
      wheelMultiplier: 1.15,
      touchMultiplier: 1.4,
      smoothWheel: true,
      syncTouch: false,
      autoRaf: false,
      anchors: { offset: -88 },
    })

    instance.on("scroll", ScrollTrigger.update)
    const tick = (time: number) => instance.raf(time * 1000)
    gsap.ticker.add(tick)
    gsap.ticker.lagSmoothing(0)
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the instance only exists after mount, and consumers must re-render to receive it
    setLenis(instance)

    return () => {
      gsap.ticker.remove(tick)
      instance.destroy()
      setLenis(null)
    }
  }, [])

  // A new page starts at the top, immediately - not with a smooth glide back
  // up through the previous page's content.
  useEffect(() => {
    lenis?.scrollTo(0, { immediate: true, force: true })
    requestAnimationFrame(() => ScrollTrigger.refresh())
  }, [pathname, lenis])

  // `reducedMotion="user"` makes every motion/react animation on the site
  // honour the OS setting (transforms and layout moves drop, fades stay),
  // so no component has to remember to ask.
  return (
    <LenisContext.Provider value={lenis}>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LenisContext.Provider>
  )
}
