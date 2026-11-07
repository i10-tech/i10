"use client"

import * as React from "react"
import { isClerkAPIResponseError } from "@clerk/nextjs/errors"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { Plus } from "lucide-react"
import { Button } from "@repo/ui/components/button/button"
import { glideIntoView, holdScrollFloor } from "@repo/ui/components/lib/glide-scroll"
import { motionTokens } from "@repo/ui/components/lib/motion-tokens"
import { cn } from "cn"

/**
 * The frame of the account page, in the shape of Clerk's `<UserProfile />`
 * (2026-10-12): a heading per block ("Profile details", "Security"), and under
 * it rows with the label on the left and the thing itself on the right, a
 * hairline between them.
 *
 * ⚠ THE SAME LAYOUT ON PURPOSE. Clerk's panel was the part of the console
 * people liked using; this is ours now, but nobody should have to relearn
 * where their password is.
 */
export function ProfileBlock({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="pb-10 last:pb-0">
      <h2 className="border-b pb-3 text-base font-medium">{title}</h2>
      <div className="divide-y">{children}</div>
    </section>
  )
}

/** One row of a block - Clerk's `ProfileSection`: label left, content right. */
export function ProfileRow({
  label,
  children,
  className,
}: {
  label: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "grid gap-3 py-4 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-6",
        className,
      )}
    >
      <h3 className="pt-1.5 text-sm font-medium">{label}</h3>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

/**
 * Clerk's "+ Add email address", "+ Add a passkey": the quiet action at the
 * foot of a row, a text button with a plus.
 */
export function AddAction({
  children,
  onClick,
  disabled,
  loading,
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
  loading?: boolean
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="-ml-2 text-muted-foreground hover:text-foreground"
      onClick={onClick}
      disabled={disabled}
      loading={loading}
    >
      <Plus aria-hidden />
      {children}
    </Button>
  )
}

/**
 * A list whose items arrive and leave on Arc's panel spring - an email added,
 * a passkey removed, a device signed out - as Clerk's lists did, so the rows
 * below glide rather than jump.
 */
export function MotionList({
  children,
  busy,
  label,
}: {
  children: React.ReactNode
  /** Still loading: announced as busy, with `label` saying what. */
  busy?: boolean
  label?: string
}) {
  return (
    <ul className="flex flex-col" aria-busy={busy || undefined} aria-label={label}>
      <AnimatePresence initial={false}>{children}</AnimatePresence>
    </ul>
  )
}

export function MotionItem({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  const reduce = useReducedMotion() ?? false
  const ease = [...motionTokens.ease.enter] as [number, number, number, number]
  /*
   * ⚠ NO `layout` ANIMATION (2026-10-12). Every row used to glide to its new
   * place whenever anything above it resized - a card folding, a row
   * arriving - while the plain labels in the left column snapped there, so
   * the page tore in two for half a second. A row's own entrance and exit
   * already animate its height in the flow, which carries everything below
   * it smoothly; nothing else needs to move on its own.
   *
   * ⚠ CLIPPED ONLY WHILE IT MOVES (2026-10-12), as `Reveal` is. A row that
   * clipped all the time cut off anything opening inside it - the team page's
   * role picker grows in place, and showed as a sliver.
   */
  // Unclipped until an animation actually starts: rows already in the list
  // when it appears never animate, so they would never report stopping.
  const [moving, setMoving] = React.useState(false)
  return (
    <motion.li
      onAnimationStart={() => setMoving(true)}
      onAnimationComplete={() => setMoving(false)}
      initial={reduce ? false : { opacity: 0, height: 0, filter: "blur(2px)" }}
      animate={{
        opacity: 1,
        height: "auto",
        filter: "blur(0px)",
        transitionEnd: { filter: "none" },
      }}
      exit={
        reduce
          ? { opacity: 0, height: 0, transition: { duration: 0 } }
          : {
              opacity: 0,
              height: 0,
              filter: "blur(2px)",
              transition: {
                height: motionTokens.spring.smooth,
                opacity: { duration: motionTokens.duration.fast },
              },
            }
      }
      transition={{
        height: motionTokens.spring.smooth,
        opacity: { duration: motionTokens.duration.standard, ease },
        filter: { duration: motionTokens.duration.standard, ease },
      }}
      className={cn(moving && "[overflow-y:clip]", className)}
    >
      <div className="py-1.5">{children}</div>
    </motion.li>
  )
}

/**
 * A row's action or badge, fading in and out rather than popping, and leaving
 * no box behind while it is away. `swap` names what is shown, so one action
 * replacing another (Set up, then the menu) fades across instead of cutting.
 */
export function RowAction({
  show,
  swap = "action",
  children,
}: {
  show: boolean
  swap?: string
  children: React.ReactNode
}) {
  const reduced = useReducedMotion()
  return (
    <AnimatePresence initial={false} mode="popLayout">
      {show && (
        <motion.span
          key={swap}
          className="flex shrink-0 items-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduced ? 0 : motionTokens.duration.fast }}
        >
          {children}
        </motion.span>
      )}
    </AnimatePresence>
  )
}

/** Clerk's own sentence for a refusal, or ours when it gives none. */
export function clerkReason(
  error: unknown,
  fallback = "That did not work. Try again.",
): string {
  if (isClerkAPIResponseError(error)) {
    const first = error.errors[0]
    return first?.longMessage ?? first?.message ?? fallback
  }
  return fallback
}

/** "Mar 4, 2026" - Clerk's dates in the panel, in the person's locale. */
export function shortDate(date: Date | null | undefined): string {
  if (!date) return ""
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

/**
 * Bring an editor that just opened fully into view - the way set-up's rail
 * follows the step in progress. `nearest`, so an editor already on screen does
 * not move at all.
 *
 * ⚠ IT GLIDES FROM THE PRESS, RIDING THE PANEL AS IT OPENS (2026-11-04). It
 * used to wait 420ms for the panel to settle and then ask for a native smooth
 * scroll: the panel opened, everything stopped, then the page moved. See
 * `glideIntoView`. Reduced motion keeps the old wait and jumps.
 */
export function useFollowOpen<T extends HTMLElement>(open: boolean) {
  const ref = React.useRef<T>(null)
  const reduced = useReducedMotion()
  const wasOpen = React.useRef(open)
  /*
   * ⚠ AND CLOSING HOLDS THE VIEW STILL (2026-11-04). The glide left the page
   * scrolled down; without a floor the fold shortened the page under that
   * position and the browser dragged everything above the panel down the
   * screen. A layout effect, so the floor is down before the first folded frame
   * is painted. See `holdScrollFloor`; it outlives this effect on purpose.
   */
  React.useLayoutEffect(() => {
    const closing = wasOpen.current && !open
    wasOpen.current = open
    if (closing && ref.current) holdScrollFloor(ref.current)
  }, [open])
  React.useEffect(() => {
    if (!open) return
    if (reduced) {
      const timer = window.setTimeout(
        () => ref.current?.scrollIntoView({ block: "nearest" }),
        // Arc's panel spring settles in about this long.
        420,
      )
      return () => window.clearTimeout(timer)
    }
    let stop: (() => void) | undefined
    // The frame after the panel's content has mounted.
    const frame = requestAnimationFrame(() => {
      if (ref.current) stop = glideIntoView(ref.current, "nearest")
    })
    return () => {
      cancelAnimationFrame(frame)
      stop?.()
    }
  }, [open, reduced])
  return ref
}
