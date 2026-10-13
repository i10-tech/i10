"use client"

import * as React from "react"
import { motion } from "motion/react"
import { AutoHeight } from "@repo/ui/components/i10/auto-height"
import { carryBetween } from "@repo/ui/components/i10/carry"
import { Reveal } from "@repo/ui/components/i10/reveal"
import { cn } from "cn"
import { motionTokens } from "@repo/ui/components/lib/motion-tokens"

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
  enter = true,
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
  /**
   * Whether this step settles in when it joins a rail already on screen. Off
   * for a step that REPLACES one with the same title (set-up's Domain step
   * swapping to the add-domain steps and back): the title is already there,
   * and fading it in again would read as a different step arriving.
   */
  enter?: boolean
  children: React.ReactNode
}) {
  const ref = React.useRef<HTMLLIElement>(null)
  useCarry(ref, state, reduce)
  const rail = React.useContext(RailReady)
  // Decided once, at mount: joining a rail that was already drawn.
  const [joining] = React.useState(() => rail.current && enter && !reduce)
  const done = state === "done"
  const current = state === "current"
  const warn = done && tone === "warning"
  // Opened once, kept: see the note on the layers below.
  const [opened, setOpened] = React.useState(current)
  if (current && !opened) setOpened(true)
  return (
    <motion.li
      ref={ref}
      layout={reduce ? false : "position"}
      initial={
        joining ? { opacity: 0, filter: `blur(${motionTokens.blur.subtle}px)` } : false
      }
      // ⚠ `none` ONCE SETTLED: any filter, even blur(0), makes the step a
      // containing block for fixed descendants and a new stacking context.
      animate={{ opacity: 1, filter: "blur(0px)", transitionEnd: { filter: "none" } }}
      transition={{
        layout: { duration: 0.45, ease: EASE },
        opacity: {
          duration: motionTokens.duration.standard,
          ease: [...motionTokens.ease.enter],
        },
        filter: {
          duration: motionTokens.duration.standard,
          ease: [...motionTokens.ease.enter],
        },
      }}
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
            warn ? "bg-warning" : done ? "bg-success" : "bg-muted-foreground/40",
          )}
        />
      )}
      <StepMarker state={warn ? "warn" : state} reduce={reduce} />

      {/*
       * ⚠ THE SAME FRAME IN EVERY STATE, ONLY ITS BORDER AND TINT CHANGE, so
       * answering a step colours the box it is already in rather than moving
       * its title.
       */}
      <div
        className={cn(
          "-ml-4 rounded-3xl border p-5 pl-4 transition-[background-color,border-color] duration-500",
          warn
            ? "border-warning/30"
            : done
              ? "border-success/30"
              : "border-transparent",
        )}
      >
        <h2
          className={cn(
            "flex items-center gap-2.5 font-display text-xl font-normal tracking-[-0.02em] transition-colors",
            state === "next" && "text-muted-foreground/50",
          )}
        >
          {icon && (
            <span
              aria-hidden
              className={cn(
                "inline-flex shrink-0 transition-colors duration-300 [&_svg]:size-4.5",
                warn
                  ? "text-warning"
                  : done
                    ? "text-success"
                    : state === "current"
                      ? "text-foreground"
                      : "text-muted-foreground/50",
              )}
            >
              {icon}
            </span>
          )}
          {title}
          {done && badge && (
            <span
              className={cn(
                "rounded-full px-2 py-0.5 font-sans text-xs font-medium tracking-normal",
                warn ? "bg-warning/14 text-warning" : "bg-success/12 text-success",
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
         * half set up.
         *
         * ⚠ EACH FACE IS A `Reveal`, ARC'S PANEL MOTION (2026-10-12). The two
         * faces used to crossfade inside a box that sprang between their
         * heights and clipped while it grew, so the question's buttons were
         * sliced by the box's edge on the way in - the Advanced options bug
         * again, on every step. Now one face closes as the other opens on the
         * same spring, so their heights add up to one straight movement from
         * one height to the other, and each face settles into place with
         * Arc's small drop and focus pull instead of being wiped in.
         *
         * ⚠ THE ANSWER IS ABOVE THE QUESTION, so the answer never moves while
         * it opens or closes: the value carried into it (see `useCarry`) lands
         * on a target that is standing still.
         */}
        <AutoHeight grow="animate">
          {summary && (
            <Reveal show={done} spacing="pt-3" keepMounted>
              <div data-face="answer">{summary}</div>
            </Reveal>
          )}
          <Reveal show={current} spacing="pt-1" keepMounted>
            {opened && (
              <div data-face="question">
                <p className="max-w-xl text-sm text-muted-foreground">{description}</p>
                <div className="pt-5">{children}</div>
              </div>
            )}
          </Reveal>
        </AutoHeight>
      </div>
    </motion.li>
  )
}

/**
 * Carries a value from one face of a step to the other: the domain typed in
 * the box travels to where the answer shows it, and back on "Change". Mark
 * both ends with the same `data-carry` key - see @repo/ui's `carryBetween`.
 */
function useCarry(
  ref: React.RefObject<HTMLElement | null>,
  state: "done" | "current" | "next",
  reduce: boolean,
) {
  const previous = React.useRef(state)
  React.useLayoutEffect(() => {
    const from = previous.current
    previous.current = state
    const item = ref.current
    if (reduce || !item || from === state) return
    const turn =
      from === "current" && state === "done"
        ? (["question", "answer"] as const)
        : from === "done" && state === "current"
          ? (["answer", "question"] as const)
          : null
    if (!turn) return
    const face = (name: string) => item.querySelector(`[data-face=${name}]`)
    const source = face(turn[0])
    const target = face(turn[1])
    if (!source || !target) return
    return carryBetween(item, source, target)
  }, [ref, state, reduce])
}

/**
 * A step that joins the rail after it was first drawn - the records step when
 * somebody chooses to add a domain, the publish step after Manual setup -
 * settles in with Arc's enter (a fade and a brief focus pull) while the steps
 * below it slide down to make room. On the first render nothing enters.
 */
const RailReady = React.createContext<{ readonly current: boolean }>({ current: false })

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
  // ⚠ A BOX, NOT STATE: steps read it once as they mount, and flipping it
  // must not re-render every step on the rail.
  const drawn = React.useRef(false)
  React.useEffect(() => {
    drawn.current = true
  }, [])

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
      /*
       * ⚠ OPENING ON THE FIRST STEP, THE PAGE STAYS AT THE TOP (2026-10-13).
       * Jumping to it hid the heading and the progress above it, so set-up for
       * a new workspace opened mid-page; a resumed flow on a later step still
       * opens on that step.
       */
      if (first && next === list.querySelector("[data-step-state]")) return
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
      <RailReady.Provider value={drawn}>{children}</RailReady.Provider>
    </ol>
  )
}

/**
 * The dot on the rail, Arc's stepper marker: a finished step fills with the
 * status colour and a check draws itself in; the current one is a solid ring;
 * those still to come are faint. Fill and check move on Arc's tokens, and
 * reduced motion lands on the final state.
 */
function StepMarker({
  state,
  reduce,
}: {
  state: "done" | "warn" | "current" | "next"
  reduce: boolean
}) {
  const filled = state === "done" || state === "warn"
  return (
    <span
      aria-hidden
      className={cn(
        "absolute top-7 left-0 grid size-[15px] place-items-center rounded-full border-2 bg-background",
        "transition-colors duration-(--duration-standard) ease-(--ease-standard)",
        state === "done" && "border-success",
        state === "warn" && "border-warning",
        state === "current" && "border-foreground",
        state === "next" && "border-muted-foreground/40",
      )}
    >
      <motion.span
        className={cn(
          "absolute -inset-[2px] rounded-full",
          state === "warn" ? "bg-warning" : "bg-success",
        )}
        initial={false}
        animate={{ scale: filled ? 1 : 0.4, opacity: filled ? 1 : 0 }}
        transition={reduce ? { duration: 0 } : motionTokens.spring.snappy}
      />
      <svg
        viewBox="0 0 16 16"
        className="relative size-[11px] text-[var(--background)]"
        fill="none"
      >
        {state === "warn" ? (
          <motion.path
            d="M8 4.5v4.25M8 11.25v.25"
            stroke="currentColor"
            strokeWidth={2.25}
            strokeLinecap="round"
            initial={false}
            animate={{ pathLength: filled ? 1 : 0, opacity: filled ? 1 : 0 }}
            transition={
              reduce
                ? { duration: 0 }
                : {
                    duration: motionTokens.duration.standard,
                    ease: [...motionTokens.ease.enter],
                    delay: 0.06,
                  }
            }
          />
        ) : (
          <motion.path
            d="M4.25 8.25 6.75 10.75l5-5.5"
            stroke="currentColor"
            strokeWidth={2.25}
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={false}
            animate={{ pathLength: filled ? 1 : 0, opacity: filled ? 1 : 0 }}
            transition={
              reduce
                ? { duration: 0 }
                : {
                    duration: motionTokens.duration.standard,
                    ease: [...motionTokens.ease.enter],
                    delay: 0.06,
                  }
            }
          />
        )}
      </svg>
    </span>
  )
}
