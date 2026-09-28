"use client"

import * as React from "react"
import { motion, type Transition } from "motion/react"
import { cn } from "cn"

/**
 * A box whose height follows its content on a spring, so everything below it
 * slides instead of jumping.
 *
 * ⚠ THIS EXISTS BECAUSE `layout` DOES NOT MOVE SIBLINGS. `StepStage` morphs its
 * own box with Motion's layout animation, which is a TRANSFORM - the box looks
 * like it is growing while its real height has already changed. Anything after
 * it in the flow (a footer, a Back button) therefore lands in its final place in
 * the first frame, and the only thing that animates is the box the eye is not
 * on. Animating the real `height` is what carries the rest of the page with it.
 *
 * ⚠ MEASURED WITH A `ResizeObserver` ON AN INNER ELEMENT, not read at render.
 * The content changes height for reasons React never hears about - a font
 * arriving, a textarea wrapping, a step's own `Reveal` opening - and every one
 * of those should glide the same way a step change does.
 *
 * ⚠ IT NEVER CLIPS, AND GROWING IS THEREFORE INSTANT BY DEFAULT. The first
 * version animated both ways and clipped while moving, and that was visible:
 * going from Send to Plan in onboarding, the taller plan step arrived inside a
 * box still springing up to meet it, so the bottom of the Free card - its
 * border - was cut off for a moment and then appeared. Reported as "a border
 * update"; it was the clip. A box that SHRINKS is always taller than its
 * content, so it has nothing to clip and can animate freely. A box that GROWS
 * either clips (the bug) or lets its content spill over whatever follows (a
 * collision), so by default it simply takes the new height at once - in the
 * same frame the new content appears, which is where the eye already is.
 *
 * ⚠ `grow="animate"` KEEPS THE SPRING ON THE WAY UP, for an in-place morph
 * where the growth is small and the content is fading in anyway - a row
 * becoming a slightly taller panel. It clips only while moving, and only then.
 *
 * ⚠ THE FIRST MEASUREMENT DOES NOT ANIMATE. The box starts at `auto`, and the
 * first number it is given is the height it already has.
 */

/** The spring `Reveal` and `StepStage` use, so a step's height moves like its content. */
const SPRING: Transition = { type: "spring", stiffness: 420, damping: 38, mass: 1 }

export function AutoHeight({
  children,
  className,
  grow = "instant",
}: {
  children: React.ReactNode
  className?: string
  /** See the note above. `instant` never clips; `animate` clips while moving. */
  grow?: "instant" | "animate"
}) {
  const inner = React.useRef<HTMLDivElement>(null)
  const [height, setHeight] = React.useState<number | "auto">("auto")
  const [growing, setGrowing] = React.useState(false)
  const [moving, setMoving] = React.useState(false)

  React.useEffect(() => {
    const element = inner.current
    if (!element) return

    // The last height this observer reported, so each change knows its
    // direction without reading state from inside an updater.
    let last: number | null = null

    const observer = new ResizeObserver(([entry]) => {
      const size = entry?.borderBoxSize?.[0]?.blockSize ?? element.offsetHeight
      setGrowing(last !== null && size > last)
      last = size
      setHeight(size)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return (
    <motion.div
      initial={false}
      animate={{ height }}
      transition={growing && grow === "instant" ? { duration: 0 } : SPRING}
      onAnimationStart={() => setMoving(true)}
      onAnimationComplete={() => setMoving(false)}
      className={cn(
        moving && growing && grow === "animate" && "overflow-hidden",
        className,
      )}
    >
      <div ref={inner}>{children}</div>
    </motion.div>
  )
}
