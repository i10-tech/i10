"use client"

import * as React from "react"
import { AnimatePresence, motion, type Transition } from "motion/react"
import { cn } from "cn"

/**
 * A block that grows into a form rather than appearing in it.
 *
 * ⚠ CONDITIONAL JSX IS A JUMP CUT, AND IT IS THE MOST COMMON ONE WE SHIP.
 * `{detected && <Panel/>}` puts ninety pixels on screen in a single frame and
 * shoves everything under it down by ninety pixels in the same frame. Nothing
 * about that reads as the form answering a question — it reads as the page
 * reloading, which is why it gets described as a jump rather than as a panel.
 *
 * ⚠ IT IS THE SAME SPRING `StepStage` USES, AND THAT MATTERS MORE THAN THE
 * CURVE ITSELF. A screen where a panel eases in over 200ms, a step slides on a
 * spring and a disclosure uses a CSS keyframe has three different physics in
 * one card, and a person reads that as three different components stapled
 * together rather than as one product. One transition object, imported by
 * everything that moves, is what makes them feel like the same surface.
 *
 * ⚠ THE SPACING LIVES INSIDE THE ANIMATED BOX, WHICH IS THE WHOLE REASON FOR
 * `spacing`. Tailwind v4 writes `space-y-6` as `margin-bottom: 24px` on every
 * child but the last, so a revealed block owns the gap BELOW it. Left alone,
 * that 24px snaps in and out at full size while the height springs — the
 * movement is smooth and is bracketed by a lurch, which is the bug in
 * miniature. Cancelling the margin and re-adding it as padding INSIDE puts it
 * under the height animation, where it belongs.
 *
 * ⚠ THE GAP ABOVE IS NOT THIS COMPONENT'S TO OWN, AND DOES NOT NEED TO BE. It
 * belongs to the previous sibling, which is not last either way — so it is
 * present at the same 24px whether this block is open or shut, and never
 * moves.
 *
 * ⚠ AND `overflow-hidden` IS LOAD-BEARING, NOT TIDINESS. Height is animated on
 * the wrapper while the content inside keeps its natural size; without it the
 * content spills out of a box that is pretending to be shorter than it is, and
 * the collapse looks like the panel sliding under the one below it.
 */

/** Shared with `StepStage`. See its note: a spring, not a duration. */
const SPRING: Transition = { type: "spring", stiffness: 420, damping: 38, mass: 1 }

export function Reveal({
  show,
  children,
  spacing = "pb-6",
  className,
}: {
  show: boolean
  children: React.ReactNode
  /**
   * The gap this block owes its neighbours, re-expressed as padding.
   *
   * ⚠ IT HAS TO MATCH THE PARENT AND IT HAS TO BE ON THE RIGHT SIDE, which is
   * why it is a class rather than a number. In a `space-y-6` stack the gap a
   * block owns is the one BELOW it, so `pb-6`; under a disclosure trigger it is
   * the one above, so `pt-3`. This component cannot see what it is inside, and
   * getting it wrong shows up immediately as uneven spacing — the right failure
   * mode for something no compiler can check.
   */
  spacing?: string
  className?: string
}) {
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          /*
           * ⚠ THE STACK'S OWN MARGIN IS CANCELLED IN BOTH DIRECTIONS. Tailwind
           * v4 expresses `space-y` as a margin on one side of every child but
           * one, and which side depends on the version — neutralising both is
           * one utility and removes the question.
           */
          className={cn("mt-0! mb-0! overflow-hidden", className)}
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={SPRING}
        >
          <div className={spacing}>{children}</div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
