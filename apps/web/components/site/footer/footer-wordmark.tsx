"use client"

import { useRef, type PointerEvent } from "react"

/*
 * The giant word at the top of the footer, after Resend and Bird - but the
 * word is "Integration", the name the numeronym stands for.
 *
 * Two layers of the same text: a faint base, and a glow layer whose fill is a
 * radial gradient centred on the pointer, clipped to the letters. The pointer
 * position goes straight into CSS variables on the element; nothing re-renders
 * while the cursor moves.
 */
export function FooterWordmark() {
  const ref = useRef<HTMLDivElement>(null)

  const move = (e: PointerEvent<HTMLDivElement>) => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    el.style.setProperty("--mx", `${e.clientX - rect.left}px`)
    el.style.setProperty("--my", `${e.clientY - rect.top}px`)
  }

  return (
    <div ref={ref} onPointerMove={move} className="footer-wordmark group relative select-none" aria-hidden>
      <span className="footer-wordmark__text footer-wordmark__base">Integration</span>
      <span className="footer-wordmark__text footer-wordmark__glow">Integration</span>
    </div>
  )
}
