"use client"

import { useRef, type CSSProperties, type PointerEvent } from "react"
import { MARK_ASPECT, markMaskUrl } from "@/components/brand/mark"

/*
 * The big mark in the footer corner, after Webflow's: a solid glyph bleeding
 * off the edge that turns out to be a window. On hover the fill gives way to a
 * stream of mail moving inside the letters, with a little parallax against the
 * pointer.
 *
 * The glyph is a CSS mask built from the same path as the logo, so the window
 * and the mark are one shape by construction.
 */
const SUBJECTS = [
  ["Welcome to Acme", "send"],
  ["Your receipt #4821", "domain"],
  ["Reset your password", "mail"],
  ["You have 3 new sign-ins", "hook"],
  ["Invoice for September", "template"],
  ["Verify your email", "deliver"],
  ["Order shipped", "send"],
  ["Weekly digest", "mail"],
  ["Payment received", "domain"],
  ["Your trial ends soon", "hook"],
  ["New comment on #212", "template"],
  ["Magic link for dash", "deliver"],
] as const

function Column({ offset, duration, reverse }: { offset: number; duration: number; reverse?: boolean }) {
  const items = [...SUBJECTS.slice(offset), ...SUBJECTS.slice(0, offset)]
  return (
    <div className="footer-mark__col" style={{ "--dur": `${duration}s`, animationDirection: reverse ? "reverse" : "normal" } as CSSProperties}>
      {[...items, ...items].map(([subject, hue], i) => (
        <div
          key={i}
          className="footer-mark__card"
          style={{ "--c": `var(--hue-${hue})` } as CSSProperties}
        >
          <span className="footer-mark__from" />
          <span className="footer-mark__subject">{subject}</span>
          <span className="footer-mark__line" />
          <span className="footer-mark__line footer-mark__line--short" />
        </div>
      ))}
    </div>
  )
}

export function FooterMark({ className }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null)

  const move = (e: PointerEvent<HTMLDivElement>) => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    el.style.setProperty("--px", `${(e.clientX - rect.left) / rect.width - 0.5}`)
    el.style.setProperty("--py", `${(e.clientY - rect.top) / rect.height - 0.5}`)
  }

  return (
    <div
      ref={ref}
      onPointerMove={move}
      aria-hidden
      className={`footer-mark group ${className ?? ""}`}
      style={{ aspectRatio: MARK_ASPECT, maskImage: markMaskUrl, WebkitMaskImage: markMaskUrl } as CSSProperties}
    >
      <div className="footer-mark__fill" />
      <div className="footer-mark__stream">
        <Column offset={0} duration={26} />
        <Column offset={4} duration={34} reverse />
        <Column offset={8} duration={29} />
        <Column offset={2} duration={38} reverse />
        <Column offset={6} duration={31} />
      </div>
    </div>
  )
}
