"use client"

import * as React from "react"
import {
  AnimatePresence,
  motion,
  useReducedMotion,
  type Transition,
  type Variants,
} from "motion/react"
import { cn } from "cn"
import { motionTokens } from "../lib/motion-tokens"
import { AutoHeight } from "./auto-height"
import { carryBetween } from "./carry"

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
 * thing React genuinely cannot express - a component that has been removed is
 * already gone from the DOM, so there is nothing left to animate - and a
 * container that follows its new content's height needs that height measured
 * as it changes. `AnimatePresence` is the first; `AutoHeight` - a
 * `ResizeObserver` and a real, animated `height` - is the second.
 *
 * ⚠ `mode="popLayout"` IS THE WHOLE TRICK, AND THE DEFAULT IS WRONG HERE. With
 * the default `sync`, the outgoing pane keeps its space in the layout while it
 * fades, so the wrapper first grows to fit BOTH panes and then shrinks - a
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
 * ⚠ ARC'S PANEL MOTION, NOT A SPRING OF ITS OWN (2026-10-12). This used to
 * carry its own stiffness and damping and a 12px slide, and it morphed the
 * box with Motion's `layout` - a TRANSFORM, so the card's borders and text
 * were scaled while it changed height. Now the height is real (`AutoHeight`,
 * on `spring.smooth`, the same spring every panel uses), and a step changes
 * the way Arc's panels do: in from 8px with a brief focus pull, out faster
 * than it came in. A spring still carries velocity, so pressing Next twice
 * quickly is one continuous movement rather than a restart.
 *
 * ⚠ 8px OF TRAVEL, NOT A FULL WIDTH. A pane that slides the width of the card
 * is a page transition, and it makes a four-step form feel like four screens -
 * which is the feeling this exists to remove. A few pixels plus a fade reads as
 * the same card changing its mind.
 */
const TRAVEL = 8

const ENTER: Transition = {
  x: motionTokens.spring.smooth,
  opacity: {
    duration: motionTokens.duration.standard,
    ease: [...motionTokens.ease.enter] as [number, number, number, number],
  },
  filter: {
    duration: motionTokens.duration.standard,
    ease: [...motionTokens.ease.enter] as [number, number, number, number],
  },
}

const VARIANTS: Variants = {
  enter: (direction: Direction) => ({
    opacity: 0,
    x: direction === "back" ? -TRAVEL : TRAVEL,
    filter: `blur(${motionTokens.blur.subtle}px)`,
  }),
  center: {
    opacity: 1,
    x: 0,
    filter: "blur(0px)",
    transition: ENTER,
    // ⚠ `none` ONCE SETTLED: any filter makes the pane a containing block
    // for fixed descendants, and the passkey cover is one.
    transitionEnd: { filter: "none" },
  },
  exit: (direction: Direction) => ({
    opacity: 0,
    x: direction === "back" ? TRAVEL : -TRAVEL,
    filter: `blur(${motionTokens.blur.subtle}px)`,
    // ⚠ THE EXIT IS FASTER THAN THE ENTRANCE AND IS NOT A SPRING. Nobody is
    // waiting to see the old step leave; out quickly, in with weight.
    transition: {
      duration: motionTokens.duration.fast,
      ease: [...motionTokens.ease.standard] as [number, number, number, number],
    },
  }),
}

const STILL: Variants = {
  enter: { opacity: 0 },
  center: { opacity: 1, transition: { duration: motionTokens.duration.instant } },
  exit: { opacity: 0, transition: { duration: motionTokens.duration.instant } },
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
   * always a smaller number - a flow that branches (add a passkey, skip to the
   * end) has steps that are neither forward nor backward of each other, and
   * inferring direction from an ordering that does not exist gets it wrong
   * exactly when somebody has done something unusual.
   */
  direction = "forward",
  /**
   * Whether this box animates its own height.
   *
   * ⚠ OFF INSIDE ANOTHER `AutoHeight` THAT ALREADY OWNS THE HEIGHT. Nesting
   * two stages is fine - the outer one follows the inner one's movement
   * frame by frame - but a stage inside a box that animates the same height
   * for its own reasons should leave it to that box.
   */
  morph = true,
}: {
  /** Changes when the visible pane should change. */
  step: string
  children: React.ReactNode
  className?: string
  direction?: Direction
  morph?: boolean
}) {
  const reduce = useReducedMotion() ?? false
  const box = React.useRef<HTMLDivElement>(null)

  /*
   * ⚠ A VALUE SHOWN ON BOTH SIDES OF A STEP IS CARRIED ACROSS, NOT FADED
   * TWICE. The email typed on a first step that the next one shows in its
   * "· Change" chip travels there - see `carryBetween`. The leaving pane is
   * still on screen, where it was, while this runs: `popLayout` has only taken
   * it out of flow.
   */
  const previous = React.useRef(step)
  React.useLayoutEffect(() => {
    if (previous.current === step) return
    previous.current = step
    const stage = box.current
    if (reduce || !stage) return
    const panes = [...stage.querySelectorAll<HTMLElement>("[data-stage-pane]")].filter(
      (pane) => pane.closest("[data-stage]") === stage,
    )
    const entering = panes.find((pane) => pane.dataset.stagePane === step)
    const leaving = panes.find((pane) => pane !== entering)
    if (!entering || !leaving) return
    return carryBetween(stage, leaving, entering)
  }, [step, reduce])

  const panes = (
    <div className="relative">
      <AnimatePresence mode="popLayout" initial={false} custom={direction}>
        <motion.div
          key={step}
          data-stage-pane={step}
          custom={direction}
          variants={reduce ? STILL : VARIANTS}
          initial="enter"
          animate="center"
          exit="exit"
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  )

  return (
    <div ref={box} data-stage="" className={cn("relative w-full", className)}>
      {morph ? <AutoHeight grow="animate">{panes}</AutoHeight> : panes}
    </div>
  )
}
