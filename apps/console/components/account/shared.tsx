"use client"

import * as React from "react"
import { isClerkAPIResponseError } from "@clerk/nextjs/errors"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { Plus } from "lucide-react"
import { Button } from "@repo/ui/components/button/button"
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
export function MotionList({ children }: { children: React.ReactNode }) {
  return (
    <ul className="flex flex-col">
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
 * follows the step in progress. Waits for the panel to finish opening, or it
 * would aim at where the bottom was a moment ago; `nearest`, so an editor
 * already on screen does not move at all.
 */
export function useFollowOpen<T extends HTMLElement>(open: boolean) {
  const ref = React.useRef<T>(null)
  React.useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(
      () => ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }),
      // Arc's panel spring settles in about this long.
      420,
    )
    return () => window.clearTimeout(timer)
  }, [open])
  return ref
}
