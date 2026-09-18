"use client"

import * as React from "react"
import { cn } from "cn"

/**
 * A surface that knows where the pointer is.
 *
 * ⚠ IT IS SUPPOSED TO BE ALMOST IMPERCEPTIBLE, AND THE NUMBERS BELOW ARE CHOSEN
 * TO KEEP IT THERE. The brief is movement that somebody feels rather than
 * notices: a 4%-opacity wash, 240px across, following the cursor over a strip of
 * statistics. Turned up even slightly this becomes the "spotlight card" effect
 * that every AI-generated landing page has had since 2023, and at that point it
 * is decoration pretending to be feedback.
 *
 * ⚠ IT WRITES CSS VARIABLES AND NEVER SETS STATE, WHICH IS THE ONLY REASON IT
 * IS AFFORDABLE. A `pointermove` handler that called `setState` would re-render
 * this subtree on every mouse position — sixty times a second, through React,
 * for a background gradient. Writing two custom properties straight onto the
 * node skips React entirely and leaves the work to the compositor, which is what
 * it is for.
 *
 * ⚠ AND IT IS ONE WRAPPER AROUND A GROUP RATHER THAN ONE PER TILE. Six stat
 * tiles each tracking their own pointer is six listeners, six client components
 * and six gradients that stop at their own edges — so the wash would visibly
 * break at every divider. One listener over the whole strip means the highlight
 * crosses them.
 *
 * ⚠ AND IT IS INERT ON A TOUCH SCREEN. There is no pointer to follow there, so
 * the wash would appear wherever a finger last landed and stay put — a
 * rendering artefact rather than a hover state. Tailwind emits `group-hover:`
 * inside `@media (hover: hover)` already, so the layer simply never leaves
 * opacity 0 on a phone.
 */
export function PointerGlow({
  children,
  className,
  /** How wide the wash is, in pixels. */
  radius = 240,
}: {
  children: React.ReactNode
  className?: string
  radius?: number
}) {
  const ref = React.useRef<HTMLDivElement>(null)

  /*
   * ⚠ THE COORDINATES ARE RELATIVE TO THE ELEMENT, NOT THE VIEWPORT, so the
   * gradient does not need to know where on the page it has been placed. Read
   * from `getBoundingClientRect` on each move rather than cached, because this
   * strip reflows from six columns to two and a cached rect would put the
   * highlight somewhere else entirely after a resize.
   */
  function track(event: React.PointerEvent<HTMLDivElement>) {
    const node = ref.current
    if (!node) return

    const rect = node.getBoundingClientRect()
    node.style.setProperty("--glow-x", `${event.clientX - rect.left}px`)
    node.style.setProperty("--glow-y", `${event.clientY - rect.top}px`)
  }

  return (
    <div
      ref={ref}
      onPointerMove={track}
      /*
       * ⚠ `group` AND `isolate`, BOTH LOAD-BEARING. `group` is what lets the
       * glow layer below fade in on hover of the WHOLE strip rather than of
       * itself. `isolate` gives it a stacking context so the layer's `-z-10`
       * sits under the tiles' text and over the strip's own background instead
       * of disappearing behind the page.
       */
      className={cn("group relative isolate", className)}
      style={
        {
          "--glow-x": "50%",
          "--glow-y": "50%",
        } as React.CSSProperties
      }
    >
      {/*
       * ⚠ A SIBLING LAYER, NOT A BACKGROUND ON THE WRAPPER. The wrapper is the
       * bordered, rounded, divided container; painting a gradient on it directly
       * would put the wash over the dividers as well as between them, and its
       * corners would have to re-state the radius. An inset layer inherits the
       * radius and is clipped by it.
       *
       * ⚠ AND `pointer-events-none`, or this layer eats every click on the
       * tiles it is sitting on top of.
       */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 -z-10 rounded-[inherit]",
          "opacity-0 transition-opacity duration-(--duration-dismiss) ease-(--ease-linear)",
          // ⚠ NOTHING GATES THIS FOR TOUCH BECAUSE TAILWIND ALREADY DOES.
          // `group-hover:` is emitted inside `@media (hover: hover)` by default
          // in v4 — checked by compiling it rather than assumed — so a device
          // with no pointer never runs the rule and the wash cannot end up
          // frozen wherever a finger last landed. An explicit
          // `[@media(hover:hover)]:` wrapper was written here first and
          // compiled to the same query nested inside itself.
          "group-hover:opacity-100",
        )}
        style={{
          background: `radial-gradient(${radius}px circle at var(--glow-x) var(--glow-y), color-mix(in oklch, var(--foreground) 4%, transparent), transparent 70%)`,
        }}
      />
      {children}
    </div>
  )
}
