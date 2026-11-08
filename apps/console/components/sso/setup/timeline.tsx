"use client"

import * as React from "react"
import { Check } from "lucide-react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { cn } from "cn"
import { motionTokens } from "@repo/ui/components/lib/motion-tokens"
import { Reveal } from "@repo/ui/components/i10/reveal"
import { glideIntoView } from "@repo/ui/components/lib/glide-scroll"

/** How long Reveal's open spring takes to settle. */
const SETTLE_MS = 420

const StepScroll = React.createContext<() => void>(() => {})

/**
 * Bring the step this is inside up to the top of the page, for an action that
 * is about to make it taller than what is left of the screen.
 */
export function useBringStepUp() {
  return React.useContext(StepScroll)
}

/**
 * One step of the setup timeline. Only the open step shows its work; a finished
 * one folds to a line that says what was decided, and the rail fills behind it.
 */
export function TimelineStep({
  index,
  title,
  state,
  summary,
  action,
  last = false,
  children,
}: {
  index: number
  title: string
  state: "waiting" | "open" | "done"
  summary?: React.ReactNode
  /** Beside a finished step's title, to change it. */
  action?: React.ReactNode
  last?: boolean
  children: React.ReactNode
}) {
  const reduced = useReducedMotion()
  const done = state === "done"
  const open = state === "open"
  const [displaySummary, setDisplaySummary] = React.useState(summary)
  if (summary && summary !== displaySummary) setDisplaySummary(summary)

  /*
   * ⚠ THE STEP'S NUMBER GOES TO THE TOP, NOT ITS NEWEST LINE INTO VIEW. A long
   * step (a TXT record and its lookup, a provider's guide) reads from its
   * heading down; scrolling just far enough to show what grew left the heading
   * and the record off screen.
   *
   * ⚠ ONE GLIDE THAT RIDES THE GROWTH, NOT A SMOOTH SCROLL ASKED TWICE. The
   * page cannot scroll that far until the panel has grown, so a native smooth
   * scroll stopped at the old bottom, waited, and a second one finished the job
   * 420ms later: two scrolls with a stall between (measured 2026-11-04).
   */
  const step = React.useRef<HTMLLIElement>(null)
  const stopGlide = React.useRef<(() => void) | null>(null)
  React.useEffect(() => () => stopGlide.current?.(), [])
  const bringUp = React.useCallback(() => {
    const el = step.current
    if (!el) return
    stopGlide.current?.()
    if (reduced) {
      const go = () => el.scrollIntoView({ block: "start" })
      requestAnimationFrame(go)
      window.setTimeout(go, SETTLE_MS)
      return
    }
    stopGlide.current = glideIntoView(el, "start")
  }, [reduced])

  // A step that opens taller than what is left of the screen is brought up too.
  const wasOpen = React.useRef(open)
  React.useEffect(() => {
    if (open === wasOpen.current) return
    wasOpen.current = open
    if (!open) return
    const timer = window.setTimeout(() => {
      const box = step.current?.getBoundingClientRect()
      if (box && box.bottom > window.innerHeight) bringUp()
    }, SETTLE_MS)
    return () => window.clearTimeout(timer)
  }, [open, bringUp])

  return (
    <li
      ref={step}
      className="relative grid scroll-mt-6 grid-cols-[1.75rem_minmax(0,1fr)] gap-x-4"
    >
      <div className="relative flex justify-center" aria-hidden>
        {!last && (
          <span className="absolute inset-y-0 top-7 w-px overflow-hidden bg-border">
            <motion.span
              className="block h-full w-full origin-top bg-foreground"
              initial={false}
              animate={{ scaleY: done ? 1 : 0 }}
              transition={reduced ? { duration: 0 } : motionTokens.spring.smooth}
            />
          </span>
        )}
        <span
          className={cn(
            "relative z-10 flex size-7 items-center justify-center rounded-full border text-xs transition-colors duration-200",
            done && "border-foreground bg-foreground text-background",
            open && "border-foreground bg-background text-foreground",
            state === "waiting" && "border-border bg-background text-muted-foreground",
          )}
        >
          <AnimatePresence mode="popLayout" initial={false}>
            {done ? (
              <motion.span
                key="check"
                initial={reduced ? false : { scale: 0.4, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.4, opacity: 0 }}
                transition={motionTokens.spring.snappy}
              >
                <Check className="size-3.5" strokeWidth={2.5} />
              </motion.span>
            ) : (
              <motion.span
                key="number"
                initial={reduced ? false : { scale: 0.6, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.6, opacity: 0 }}
                transition={motionTokens.spring.snappy}
              >
                {index}
              </motion.span>
            )}
          </AnimatePresence>
        </span>
      </div>

      <div className={cn("min-w-0", last ? "pb-2" : "pb-8")}>
        <div className="flex min-h-7 items-center justify-between gap-3">
          <h2
            className={cn(
              "text-sm font-medium transition-colors duration-200",
              state === "waiting" && "text-muted-foreground",
            )}
            aria-current={open ? "step" : undefined}
          >
            {title}
          </h2>
          <AnimatePresence initial={false}>
            {done && action && (
              <motion.div
                key="action"
                initial={reduced ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={motionTokens.spring.snappy}
              >
                {action}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <Reveal show={done && Boolean(summary)} spacing="pt-0.5">
          <div className="text-sm text-muted-foreground">{displaySummary}</div>
        </Reveal>
        <Reveal show={open} spacing="pt-3" keepMounted>
          <StepScroll.Provider value={bringUp}>{children}</StepScroll.Provider>
        </Reveal>
      </div>
    </li>
  )
}
