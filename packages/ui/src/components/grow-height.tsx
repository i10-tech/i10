"use client"

import * as React from "react"
import { motion, type Transition } from "motion/react"
import { cn } from "cn"

/** The field hint's spring, so a growing line moves like every other one. */
const GROW: Transition = { type: "spring", stiffness: 420, damping: 38, mass: 1 }

/**
 * A block whose content changes length, springing to its new height.
 *
 * ⚠ THE SAME FIX THE FLOATING FIELD USES FOR ITS HINT, FOR ANY TEXT THAT CAN
 * CHANGE FROM ONE LINE TO SEVERAL. Swapping a short sentence for a long one
 * adds its extra lines in one frame and shoves everything below down in the
 * same frame — a jump. The content is measured and the box around it springs
 * to that height, so what is below slides, both ways.
 *
 * ⚠ `null` UNTIL FIRST MEASURED, read as "auto", so the first paint lays out
 * naturally and nothing animates on mount. Honours reduced motion through the
 * app's `MotionConfig`, like the rest of the motion here.
 */
export function GrowHeight({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  const inner = React.useRef<HTMLDivElement>(null)
  const [height, setHeight] = React.useState<number | null>(null)

  React.useLayoutEffect(() => {
    const el = inner.current
    if (!el || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => setHeight(el.offsetHeight))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <motion.div
      className={cn("overflow-hidden", className)}
      initial={false}
      animate={{ height: height ?? "auto" }}
      transition={GROW}
    >
      <div ref={inner}>{children}</div>
    </motion.div>
  )
}
