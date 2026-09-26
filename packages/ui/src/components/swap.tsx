"use client"

import type * as React from "react"
import { AnimatePresence, motion, type Transition } from "motion/react"
import { cn } from "cn"

/**
 * A short piece of status that changes in place — "Unsaved changes" becoming
 * "Saved", "Unpublished changes" becoming "v3 live since …".
 *
 * ⚠ THE SAME SWAP `ActionButton` DOES INSIDE ITSELF, OFFERED TO THE TEXT BESIDE
 * IT. A button that eases from "Save" to a tick next to a status line that cuts
 * from one sentence to another in a single frame is two physics a centimetre
 * apart, and the cut is the one people notice. Four pixels of rise, a fast
 * fade, the old line out quicker than the new one comes in: the same numbers,
 * so a form and its status read as one thing reacting.
 *
 * ⚠ `popLayout` AND A GRID CELL, FOR THE SAME REASON AS THE BUTTON. The leaving
 * line is taken out of flow so the box measures only the arriving one, and the
 * two overlap in one cell for the few frames they share rather than stacking
 * and shoving whatever sits beside them.
 *
 * ⚠ `initial={false}` — a status that animates in on page load is a load
 * animation. Only a CHANGE moves.
 */

const SWAP: Transition = { duration: 0.12, ease: "easeOut" }

export function Swap({
  id,
  children,
  className,
}: {
  /** Changes when the content means something different. */
  id: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <span className={cn("inline-grid", className)} aria-live="polite">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={id}
          className="col-start-1 row-start-1"
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4, transition: { duration: 0.08, ease: "easeIn" } }}
          transition={SWAP}
        >
          {children}
        </motion.span>
      </AnimatePresence>
    </span>
  )
}
