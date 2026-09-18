"use client"

import * as React from "react"
import { AnimatePresence, motion, type Transition } from "motion/react"
import { cn } from "cn"

/**
 * One box that changes what is inside it, instead of one screen replacing
 * another.
 *
 * ⚠ THIS IS MOTION'S JOB AND NOT CSS's, WHICH IS WORTH BEING EXPLICIT ABOUT
 * BECAUSE THE REST OF THIS PACKAGE GOES THE OTHER WAY. The floating label, the
 * notch, hover and focus colours are all pure CSS on purpose: they change on
 * every keystroke, they have to work on uncontrolled inputs, and routing them
 * through React would mean a re-render per character for an effect the
 * compositor can do alone. None of that is true here. An EXIT animation is the
 * thing React genuinely cannot express — a component that has been removed is
 * already gone from the DOM, so there is nothing left to animate — and a
 * container that morphs to its new content's height needs a measurement taken
 * before the swap and applied after it. Hand-rolling those is a `ResizeObserver`
 * and a FLIP implementation; `AnimatePresence` and `layout` are what that
 * implementation is for.
 *
 * ⚠ `mode="popLayout"` IS THE WHOLE TRICK, AND THE DEFAULT IS WRONG HERE. With
 * the default `sync`, the outgoing pane keeps its space in the layout while it
 * fades, so the wrapper first grows to fit BOTH panes and then shrinks — a
 * visible lurch in the middle of an animation whose entire purpose is to remove
 * one. `popLayout` takes the exiting pane out of flow immediately, so the
 * wrapper only ever has one pane's height to animate to.
 *
 * ⚠ AND `initial={false}` MEANS THE FIRST STEP DOES NOT ANIMATE IN. A form that
 * slides itself into existence on page load is a load animation nobody asked
 * for, and it is the thing that makes an interface feel slower than it is. Only
 * the second step onwards moves.
 */

/**
 * ⚠ A SPRING, NOT A DURATION, AND THE DIFFERENCE SHOWS UP UNDER IMPATIENCE.
 * A tweened swap always takes its full time; a spring carries velocity, so
 * somebody clicking Next twice quickly gets one continuous movement rather than
 * an animation that restarts. `damping: 38` against `stiffness: 420` is just
 * under critical — enough overshoot to read as weight, not enough to read as
 * bounce.
 */
const SPRING: Transition = { type: "spring", stiffness: 420, damping: 38, mass: 1 }

/**
 * ⚠ 12px OF TRAVEL, NOT A FULL WIDTH. A pane that slides the width of the card
 * is a page transition, and it makes a four-step form feel like four screens —
 * which is the feeling this exists to remove. Twelve pixels plus a fade reads as
 * the same card changing its mind.
 */
const VARIANTS = {
  enter: (direction: Direction) => ({
    opacity: 0,
    x: direction === "back" ? -12 : 12,
  }),
  center: { opacity: 1, x: 0 },
  exit: (direction: Direction) => ({
    opacity: 0,
    x: direction === "back" ? 12 : -12,
    // ⚠ THE EXIT IS FASTER THAN THE ENTRANCE AND IS NOT A SPRING. Nobody is
    // waiting to see the old step leave; springing it out means its overshoot
    // is still on screen while the new one arrives, and the two read as a
    // collision. Out quickly, in with weight.
    transition: { duration: 0.12, ease: "easeIn" as const },
  }),
}

type Direction = "forward" | "back"

export function StepStage({
  step,
  children,
  className,
  /**
   * Which way the panes slide.
   *
   * ⚠ IT IS A PROP RATHER THAN DERIVED FROM A STEP INDEX, because "back" is not
   * always a smaller number — a flow that branches (add a passkey, skip to the
   * end) has steps that are neither forward nor backward of each other, and
   * inferring direction from an ordering that does not exist gets it wrong
   * exactly when somebody has done something unusual.
   */
  direction = "forward",
}: {
  /** Changes when the visible pane should change. */
  step: string
  children: React.ReactNode
  className?: string
  direction?: Direction
}) {
  return (
    <motion.div layout className={cn("relative w-full", className)} transition={SPRING}>
      <AnimatePresence mode="popLayout" initial={false} custom={direction}>
        <motion.div
          key={step}
          custom={direction}
          variants={VARIANTS}
          initial="enter"
          animate="center"
          exit="exit"
          transition={SPRING}
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </motion.div>
  )
}
