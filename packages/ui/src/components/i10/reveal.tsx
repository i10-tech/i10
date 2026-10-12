"use client"

import * as React from "react"
import { motion, useReducedMotion, type Variants } from "motion/react"
import { cn } from "cn"
import { motionTokens } from "../lib/motion-tokens"

/**
 * Content that opens under the control that asked for it, with Arc's panel
 * motion (the same variants as Arc's Accordion): the height follows the
 * content on `spring.smooth` both ways, so everything below glides rather than
 * jumps, and the content settles down into place with a brief focus pull.
 *
 * ⚠ ONE ELEMENT, ALWAYS MOUNTED WHILE IT MATTERS. The panel is never swapped
 * in and out of a presence boundary: opening and closing are two targets of
 * the same animation, so a toggle mid-flight turns around where it is instead
 * of restarting from zero. The children stay mounted until the panel has
 * finished closing, then leave.
 *
 * ⚠ CLIPPED ONLY WHILE IT MOVES OR IS SHUT, AND THEN VERTICALLY ONLY. Once
 * open and settled nothing is clipped: a picker inside it (the API key's
 * domain list) opens downward past the panel's edge, and a permanent clip
 * hid its options. While moving, `overflow-y: clip` keeps the other axis
 * visible, so a focus outline or a field's side border is never cut. What
 * reaches above the top edge (a floating label on its field's border) sits
 * inside `spacing`, which is why callers pad the top.
 */
const panel: Variants = {
  open: {
    height: "auto",
    opacity: 1,
    transition: {
      height: motionTokens.spring.smooth,
      opacity: {
        duration: motionTokens.duration.standard,
        ease: [...motionTokens.ease.enter],
      },
    },
  },
  /*
   * ⚠ THE FADE FOLLOWS THE FOLD (2026-10-12). It used to finish in 0.16s
   * while the height took about half a second, so the content vanished and
   * an empty gap shrank after it - unremarkable on a short form, a blink and
   * a slide on a tall card like the backup codes. Now the content stays
   * readable while the panel closes over it, and is gone as it lands.
   */
  closed: {
    height: 0,
    opacity: 0,
    transition: {
      height: motionTokens.spring.smooth,
      opacity: {
        duration: motionTokens.duration.standard,
        delay: motionTokens.duration.instant,
        ease: [...motionTokens.ease.standard],
      },
    },
  },
}

const content: Variants = {
  open: {
    y: 0,
    filter: "blur(0px)",
    transition: {
      y: motionTokens.spring.smooth,
      filter: {
        duration: motionTokens.duration.standard,
        ease: [...motionTokens.ease.enter],
      },
    },
    transitionEnd: { filter: "none" },
  },
  closed: {
    y: -6,
    filter: `blur(${motionTokens.blur.subtle}px)`,
    transition: {
      duration: motionTokens.duration.fast,
      ease: [...motionTokens.ease.standard],
    },
  },
}

const still: Variants = {
  open: {
    height: "auto",
    opacity: 1,
    y: 0,
    filter: "none",
    transition: { duration: 0 },
  },
  closed: { height: 0, opacity: 0, transition: { duration: 0 } },
}

export function Reveal({
  show,
  children,
  spacing = "pb-6",
  className,
  keepMounted = false,
  onClosed,
}: {
  show: boolean
  children: React.ReactNode
  spacing?: string
  className?: string
  /**
   * Keep the children after closing, hidden and inert. For content that
   * holds state somebody would lose - a step's half-typed form.
   */
  keepMounted?: boolean
  /**
   * Called once a close has finished moving. For a change that should wait
   * until the panel is out of the way, instead of happening during its fold.
   */
  onClosed?: () => void
}) {
  const reduced = useReducedMotion()
  // Mounted while open and while closing; gone once fully closed.
  const [present, setPresent] = React.useState(show)
  // Content that was open on the first render does not animate in; any
  // later opening does.
  const [entering, setEntering] = React.useState(false)
  if (show && !present) {
    setPresent(true)
    setEntering(true)
  }
  const state = show ? "open" : "closed"
  /*
   * ⚠ AT THE FOLD'S VISUAL END, NOT ITS MATHEMATICAL ONE. The height spring
   * looks finished at its 0.4s visual duration and then spends as long again
   * crawling the last pixel; `onAnimationComplete` waits for that, which left
   * whatever was waiting on the close standing still for half a second after
   * the panel was visibly gone. Measured in the console (2026-10-12).
   */
  const closedRef = React.useRef(onClosed)
  React.useEffect(() => {
    closedRef.current = onClosed
  })
  React.useEffect(() => {
    if (show) return
    const timer = window.setTimeout(
      () => closedRef.current?.(),
      reduced ? 0 : motionTokens.spring.smooth.visualDuration * 1000,
    )
    return () => window.clearTimeout(timer)
  }, [show, reduced])
  // Open and finished moving: the only state that does not clip.
  const [settled, setSettled] = React.useState(show)

  return (
    <motion.div
      className={cn(
        "mt-0! mb-0!",
        !(show && settled) && "[overflow-y:clip]",
        className,
      )}
      initial={false}
      animate={state}
      variants={reduced ? still : panel}
      onAnimationStart={() => setSettled(false)}
      onAnimationComplete={() => {
        if (show) setSettled(true)
        else if (!keepMounted) setPresent(false)
      }}
      aria-hidden={!show || undefined}
      inert={!show || undefined}
    >
      {present && (
        <motion.div
          className={spacing}
          initial={entering ? "closed" : false}
          animate={state}
          variants={reduced ? still : content}
        >
          {children}
        </motion.div>
      )}
    </motion.div>
  )
}
