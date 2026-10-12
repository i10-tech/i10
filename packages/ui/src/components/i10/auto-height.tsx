"use client"

import * as React from "react"
import { motion, type Transition } from "motion/react"
import { cn } from "cn"
import { motionTokens } from "../lib/motion-tokens"

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
 * ⚠ A CHILD THAT ANIMATES ITS OWN HEIGHT IS FOLLOWED, NOT CHASED. A `Reveal`
 * opening inside a step resizes the content on every frame; springing to each
 * new number left the box a spring behind its content the whole way, clipping
 * the bottom of it (the Continue button under Advanced options, cut in half
 * mid-animation). Resizes that arrive within a few frames of each other are a
 * child's own motion, so the box takes them as they come, unclipped.
 *
 * ⚠ THE FIRST MEASUREMENT DOES NOT ANIMATE. The box starts at `auto`, and the
 * first number it is given is the height it already has.
 */

/** The spring `Reveal` and `StepStage` use, so a step's height moves like its content. */
/** Arc's panel spring: height that reports a state never overshoots. */
const SPRING: Transition = motionTokens.spring.smooth

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
  const [following, setFollowing] = React.useState(false)
  const [moving, setMoving] = React.useState(false)

  React.useEffect(() => {
    const element = inner.current
    if (!element) return

    // The last height this observer reported, so each change knows its
    // direction without reading state from inside an updater.
    let last: number | null = null
    let lastAt = 0
    let pending = 0

    const apply = (size: number, grew: boolean, quick: boolean) => {
      setGrowing(grew)
      setFollowing(quick)
      setHeight(size)
    }

    const observer = new ResizeObserver(([entry]) => {
      const size = entry?.borderBoxSize?.[0]?.blockSize ?? element.offsetHeight
      const now = performance.now()
      const grew = last !== null && size > last
      // Within ~3 frames of the last resize: a child is animating itself.
      const quick = now - lastAt < 50
      last = size
      lastAt = now
      window.clearTimeout(pending)
      if (grew && !quick && grow === "animate") {
        // The first frame of a child's own animation looks like a one-off
        // change. Wait two frames: if another resize follows, it was a child
        // moving and the box follows it unclipped; if not, spring as usual.
        pending = window.setTimeout(() => apply(size, true, false), 40)
        return
      }
      apply(size, grew, quick)
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
      window.clearTimeout(pending)
    }
  }, [grow])

  return (
    <motion.div
      initial={false}
      animate={{ height }}
      transition={
        following || (growing && grow === "instant") ? { duration: 0 } : SPRING
      }
      onAnimationStart={() => setMoving(true)}
      onAnimationComplete={() => setMoving(false)}
      className={cn(
        // ⚠ VERTICALLY ONLY: a pane sliding in from the side, a focus ring or
        // a field's side border is never cut by a box that is growing.
        moving && growing && !following && grow === "animate" && "[overflow-y:clip]",
        className,
      )}
    >
      <div ref={inner}>{children}</div>
    </motion.div>
  )
}
