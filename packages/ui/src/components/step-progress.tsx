"use client"

import { motion, type Transition } from "motion/react"
import { cn } from "cn"

/**
 * How far through a stepped flow somebody is.
 *
 * ⚠ IT EXISTS BECAUSE A SEVEN-STEP FORM WITHOUT ONE IS A FORM WITH NO END. The
 * whole argument for splitting sign-up into steps is that each screen asks one
 * thing; the cost is that nobody can see how many screens there are, and "one
 * question at a time" turns into "how many more of these". A progress bar is
 * the cheapest possible answer and it is the reason the split is tolerable.
 *
 * ⚠ IT COUNTS SEGMENTS RATHER THAN DRAWING A PERCENTAGE, because the steps are
 * not the same size and a smooth bar implies they are. Four ticks of which two
 * are filled is an honest claim — "two done, two left" — where a bar at 50%
 * claims the remaining half will take as long as the first, which for "add a
 * passkey" versus "type your email" is simply false.
 *
 * ⚠ AND THE COUNT IS A PROP RATHER THAN DERIVED FROM CHILDREN. The sign-up flow
 * decides at render time how many optional steps this Clerk instance can
 * actually offer — see _lib/environment.ts — so the total is genuinely dynamic,
 * and a component that inferred it would make the bar re-segment mid-flow.
 */

/**
 * ⚠ `--ease-spring-soft`'s SOLVER, NOT `--ease-spring`'s. A segment filling is
 * a width travelling to its own edge; overshooting it means painting a fraction
 * of a pixel outside the track and snapping back, which on a 2px bar is the
 * only part of the animation anybody would notice.
 */
const FILL: Transition = { type: "spring", stiffness: 380, damping: 40, mass: 1 }

export function StepProgress({
  total,
  current,
  className,
  label = "Progress",
}: {
  total: number
  /** 1-based. `0` fills nothing, `total` fills everything. */
  current: number
  className?: string
  /** What a screen reader calls this. */
  label?: string
}) {
  const clamped = Math.max(0, Math.min(current, total))

  return (
    /*
     * ⚠ `progressbar` WITH `valuetext`, NOT A ROW OF `listitem`s. A screen
     * reader on a progress bar announces "step 3 of 7" from one element when
     * the value changes; seven list items announce seven things and bury the
     * one that moved. The visual segments are decorative and marked so.
     */
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={clamped}
      aria-valuetext={`Step ${clamped} of ${total}`}
      className={cn("flex w-full items-center gap-1.5", className)}
    >
      {Array.from({ length: total }, (_, index) => (
        <div
          key={index}
          aria-hidden
          className="h-0.5 flex-1 overflow-hidden rounded-pill bg-border"
        >
          {/*
           * ⚠ `scaleX` WITH A LEFT ORIGIN, NOT `width`. Width is a layout
           * property — animating it runs layout and paint on every frame of
           * every segment — where a transform is handed straight to the
           * compositor. On a bar this thin nobody would see the difference in
           * smoothness; they would see it in the battery.
           */}
          <motion.div
            className="h-full w-full origin-left rounded-pill bg-foreground"
            initial={false}
            animate={{ scaleX: index < clamped ? 1 : 0 }}
            transition={FILL}
          />
        </div>
      ))}
    </div>
  )
}
