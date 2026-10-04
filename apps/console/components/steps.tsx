"use client"

import * as React from "react"
import { motion } from "motion/react"
import { Check } from "lucide-react"
import { AutoHeight } from "@repo/ui/components/auto-height"
import { cn } from "cn"

/**
 * The vertical rail of steps that adding a domain and set-up both walk down
 * (2026-10-03): a dot per step, a line between them that turns green as each is
 * answered, the current step's question open, and every answered one folded
 * into a green card that says what was chosen.
 *
 * ⚠ ONE COMPONENT FOR BOTH SCREENS, so set-up's domain step and /domains/new
 * are not two drawings of the same idea that drift apart. Callers put several
 * `StepItem`s inside one `StepRail`; a flow nested in another (the domain steps
 * inside set-up) contributes its items to the same list.
 */

export const EASE = [0.22, 1, 0.36, 1] as const

/**
 * One step on the rail: its dot, the line down to the next, and either its
 * question (current), its answer folded into a card (done), or its title
 * dimmed (not reached).
 *
 * ⚠ THE LINE BETWEEN TWO STEPS IS GREEN ONCE THE UPPER ONE IS DONE, which is
 * the progress: it fills down the rail as the steps are answered. A step
 * answered with "not yet" - skipped, or a domain still unverified - is amber
 * instead, and turns green by itself if it is finished later.
 *
 * ⚠ ANSWERING IS ONE MOVEMENT, NOT TWO (2026-10-03). The question used to
 * collapse to nothing and the card then grow from nothing - up all the way,
 * then down. Now the two crossfade in place while the box changes height once,
 * from the question's height straight to the card's.
 */
export function StepItem({
  state,
  last,
  title,
  icon,
  description,
  summary,
  tone = "success",
  badge,
  reduce,
  children,
}: {
  state: "done" | "current" | "next"
  last: boolean
  title: string
  /** A glyph beside the title - set-up's steps carry one. */
  icon?: React.ReactNode
  description: string
  /** What the answered step folds down to. */
  summary?: React.ReactNode
  /** Answered, but "not yet": skipped, or waiting on something. */
  tone?: "success" | "warning"
  /** A word beside an answered step's title - "Skipped". */
  badge?: string
  reduce: boolean
  children: React.ReactNode
}) {
  const done = state === "done"
  const current = state === "current"
  const warn = done && tone === "warning"
  // Opened once, kept: see the note on the layers below.
  const [opened, setOpened] = React.useState(current)
  if (current && !opened) setOpened(true)
  return (
    <motion.li
      layout={reduce ? false : "position"}
      transition={{ duration: 0.45, ease: EASE }}
      data-step-state={state}
      // ⚠ WHERE "SCROLL TO THE NEW STEP" STOPS: a little below the top edge.
      className="relative scroll-mt-6 pb-6 pl-10 last:pb-0"
    >
      {/*
       * ⚠ THE LINE RUNS FROM THIS DOT INTO THE NEXT ONE, NOT TO THE BOTTOM OF
       * THIS STEP. Every dot is at the same height (see the frame below), so the
       * line can reach the next: it runs 3px INTO both rings with square ends,
       * and the rings are drawn after it with a filled centre, so the joint has
       * no gap.
       */}
      {!last && (
        <span
          aria-hidden
          className={cn(
            "absolute top-[40px] -bottom-[31px] left-[6.5px] w-0.5 transition-colors duration-500",
            // ⚠ THE RINGS' OWN INK, NOT A FADED ONE - same colour, same weight.
            warn ? "bg-amber-500" : done ? "bg-emerald-500" : "bg-muted-foreground/40",
          )}
        />
      )}
      <span
        aria-hidden
        className={cn(
          "absolute top-7 left-0 size-[15px] rounded-full border-2 bg-background transition-colors duration-300",
          warn ? "border-amber-500" : done && "border-emerald-500",
          state === "current" && "border-foreground",
          state === "next" && "border-muted-foreground/40",
        )}
      />

      {/*
       * ⚠ THE SAME FRAME IN EVERY STATE, ONLY ITS BORDER AND TINT CHANGE, so
       * answering a step colours the box it is already in rather than moving
       * its title.
       */}
      <div
        className={cn(
          "-ml-4 rounded-3xl border p-5 pl-4 transition-[background-color,border-color] duration-500",
          warn
            ? "border-amber-500/30 bg-linear-to-br from-amber-500/12 via-amber-500/4 to-transparent"
            : done
              ? "border-emerald-500/30 bg-linear-to-br from-emerald-500/12 via-emerald-500/4 to-transparent"
              : "border-transparent",
        )}
      >
        <h2
          className={cn(
            "flex items-center gap-2 font-display text-xl font-semibold tracking-tight transition-colors",
            state === "next" && "text-muted-foreground/50",
          )}
        >
          {icon && (
            <span
              aria-hidden
              className={cn(
                "grid size-7 shrink-0 place-items-center rounded-lg border bg-linear-to-b from-muted/80 to-background transition-colors duration-300 [&_svg]:size-3.5",
                warn
                  ? "border-amber-500/30 text-amber-500"
                  : done
                    ? "border-emerald-500/30 text-emerald-500"
                    : state === "current"
                      ? "text-foreground"
                      : "text-muted-foreground/50",
              )}
            >
              {icon}
            </span>
          )}
          {title}
          {done && !warn && <Check aria-hidden className="size-4 text-emerald-500" />}
          {done && badge && (
            <span
              className={cn(
                "rounded-full px-2 py-0.5 font-sans text-xs font-medium tracking-normal",
                warn
                  ? "bg-amber-500/14 text-amber-700 dark:text-amber-300"
                  : "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
              )}
            >
              {badge}
            </span>
          )}
        </h2>

        {/*
         * ⚠ A STEP'S CONTENTS STAY MOUNTED ONCE IT HAS BEEN OPENED, AND ONLY
         * HIDE (2026-10-04). They used to unmount whenever the step stopped
         * being current, so going back to an earlier step threw away whatever
         * a later one held - a key just created, an address typed, a domain
         * half set up. Now the inactive layer is taken out of the flow and
         * faded to invisible and inert; the box's height follows whichever
         * layer is showing, still in one movement.
         */}
        <AutoHeight grow="animate">
          <div className="relative">
            {opened && (
              <Layer shown={current} reduce={reduce}>
                <p className="mt-1 max-w-xl text-sm text-muted-foreground">
                  {description}
                </p>
                <div className="pt-5">{children}</div>
              </Layer>
            )}
            {summary && (
              <Layer shown={done} reduce={reduce}>
                <div className="pt-3">{summary}</div>
              </Layer>
            )}
          </div>
        </AutoHeight>
      </div>
    </motion.li>
  )
}

/**
 * One of a step's two faces - its question or its answer.
 *
 * ⚠ HIDDEN, NOT REMOVED. Out of the flow (so the box measures only the face
 * that is showing), faded, `invisible` once faded and `inert` throughout, so a
 * hidden question can neither be seen nor tabbed into nor read out.
 */
function Layer({
  shown,
  reduce,
  children,
}: {
  shown: boolean
  reduce: boolean
  children: React.ReactNode
}) {
  return (
    <div
      inert={!shown}
      aria-hidden={!shown}
      className={cn(
        reduce ? "" : "transition-[opacity,visibility] duration-300 ease-out",
        shown
          ? "visible relative opacity-100 delay-75"
          : "invisible absolute inset-x-0 top-0 opacity-0",
      )}
    >
      {children}
    </div>
  )
}

/**
 * The list the items sit in.
 *
 * ⚠ IT FOLLOWS THE STEP IN PROGRESS (2026-10-03). When a different item
 * becomes current, the nearest scrolling box glides so that item sits at the
 * top - the answered step moves up and out, the new question arrives where the
 * eye already is. It waits for the answered step to finish folding, or it
 * would aim at where the new one was a moment ago. On the first render it goes
 * there at once, so a resumed flow opens on its step.
 */
export function StepRail({
  className,
  follow = false,
  children,
}: {
  className?: string
  follow?: boolean
  children: React.ReactNode
}) {
  const ref = React.useRef<HTMLOListElement>(null)

  React.useEffect(() => {
    const list = ref.current
    if (!follow || !list) return
    let current: Element | null = null
    let timer: ReturnType<typeof setTimeout> | undefined

    const go = (instant: boolean) => {
      const next = list.querySelector("[data-step-state=current]")
      if (!next || next === current) return
      const first = current === null
      current = next
      clearTimeout(timer)
      timer = setTimeout(
        () =>
          next.scrollIntoView({
            behavior: instant || first ? "instant" : "smooth",
            block: "start",
          }),
        instant || first ? 0 : 480,
      )
    }

    go(true)
    const watcher = new MutationObserver(() => go(false))
    watcher.observe(list, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-step-state"],
    })
    return () => {
      watcher.disconnect()
      clearTimeout(timer)
    }
  }, [follow])

  return (
    <ol ref={ref} className={cn("min-w-0", className)}>
      {children}
    </ol>
  )
}
