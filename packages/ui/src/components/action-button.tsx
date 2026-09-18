"use client"

import * as React from "react"
import { AnimatePresence, motion, type Transition } from "motion/react"
import { CheckIcon, XIcon } from "lucide-react"
import { cn } from "cn"
import { buttonVariants } from "./button"
import { Spinner } from "./spinner"

/**
 * A button that reports its own outcome, in place.
 *
 * ⚠ THE POINT IS THAT THE ANSWER APPEARS WHERE THE QUESTION WAS ASKED. The
 * pattern this replaces is: press a button, the button spins, the button goes
 * back to normal, and a toast slides in from a corner of the screen the eye is
 * not on. That works — it is what the console does everywhere — but it splits
 * one interaction across two places, and for a fast, self-explanatory outcome
 * ("copied", "verified", "saved") the toast is a notification about something
 * the person is already looking at.
 *
 * ⚠ IT DOES NOT REPLACE THE TOAST FOR ANYTHING THAT NEEDS EXPLAINING. A tick
 * inside a button can say "that worked". It cannot say "the records have not
 * propagated yet, which is normal for the first few minutes and can take up to
 * 72 hours" — and the moment an outcome needs a sentence, it needs the toast.
 * So `done` and `failed` here are a SECOND channel for the one-word version,
 * not a reason to stop describing what happened. See lib/toast.ts.
 *
 * ⚠ AND IT REVERTS ITSELF. A button frozen on a tick is a button nobody can
 * tell is still pressable, and the state it is reporting goes stale within
 * seconds — the tick means "that call succeeded", not "this is verified".
 * Reverting is what keeps it an ANNOUNCEMENT rather than a status.
 */

export type ActionState = "idle" | "pending" | "done" | "failed"

/**
 * ⚠ THE BUTTON'S WIDTH SPRINGS AND THE CONTENT CROSSFADES, WHICH IS TWO
 * DIFFERENT ANIMATIONS ON PURPOSE. "Verify" to "Checking…" is a real change of
 * size, and a button that snaps between widths mid-interaction shoves whatever
 * is beside it sideways under the cursor. Springing the width and fading the
 * label means the box grows smoothly while the words swap inside it — the
 * layout move is the thing you feel, the text change is the thing you read.
 */
const BOX: Transition = { type: "spring", stiffness: 500, damping: 42, mass: 1 }

/**
 * ⚠ FAST, AND FASTER OUT THAN IN. The two labels overlap for a moment
 * regardless — they occupy the same grid cell — so a slow crossfade renders
 * both at half opacity, which reads as a rendering fault rather than as a
 * transition.
 */
const SWAP: Transition = { duration: 0.12, ease: "easeOut" }

const CONTENT = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4, transition: { duration: 0.08, ease: "easeIn" as const } },
}

export function ActionButton({
  state,
  children,
  pendingLabel,
  doneLabel = "Done",
  failedLabel = "Failed",
  variant,
  size,
  className,
  resetAfter = 1800,
  onReset,
  disabled,
  ...props
}: Omit<React.ComponentProps<"button">, "children"> &
  React.ComponentProps<typeof buttonVariants> & {
    state: ActionState
    /** The resting content — icon and label, exactly as for `<Button>`. */
    children: React.ReactNode
    pendingLabel: string
    doneLabel?: string
    failedLabel?: string
    className?: string
    /**
     * How long the outcome stays on screen, in ms. `0` keeps it until the
     * caller changes `state`.
     */
    resetAfter?: number
    /** Called when the outcome has been shown for `resetAfter`. */
    onReset?: () => void
  }) {
  /*
   * ⚠ THE TIMER IS AN EFFECT AND IS CANCELLED ON EVERY STATE CHANGE, which is
   * what stops a second press being reverted by the FIRST press's timer.
   * Without the cleanup, pressing twice inside the window schedules two
   * resets — and the second one fires while the second call is still pending,
   * so the button silently drops back to idle mid-flight.
   */
  React.useEffect(() => {
    if (!onReset || resetAfter <= 0) return
    if (state !== "done" && state !== "failed") return

    const timer = setTimeout(onReset, resetAfter)
    return () => clearTimeout(timer)
  }, [state, resetAfter, onReset])

  const content =
    state === "pending" ? (
      <>
        {/* ⚠ `aria-hidden` — the label beside it already says "Checking…", and
            the Spinner ships with `role="status"`. Both on means a screen
            reader announces the same thing twice. */}
        <Spinner aria-hidden="true" aria-label={undefined} />
        {pendingLabel}
      </>
    ) : state === "done" ? (
      <>
        <CheckIcon aria-hidden="true" />
        {doneLabel}
      </>
    ) : state === "failed" ? (
      <>
        <XIcon aria-hidden="true" />
        {failedLabel}
      </>
    ) : (
      children
    )

  return (
    <motion.button
      layout
      transition={BOX}
      className={cn(buttonVariants({ variant, size }), "relative", className)}
      // ⚠ DEAD WHILE THE CALL IS IN FLIGHT, LIVE AGAIN THE MOMENT IT LANDS.
      // Disabling through the outcome too would mean a button that cannot be
      // pressed for two seconds after it worked, which is the state somebody is
      // most likely to want to press it again from.
      disabled={disabled || state === "pending"}
      /*
       * ⚠ `polite`, ON THE BUTTON ITSELF. The outcome replaces the button's own
       * accessible name, so without a live region a screen reader user gets no
       * announcement at all — the name simply becomes something else the next
       * time they land on it.
       */
      aria-live="polite"
      {...(props as React.ComponentProps<typeof motion.button>)}
    >
      {/*
       * ⚠ `mode="popLayout"` AND A GRID, TOGETHER. `popLayout` takes the
       * outgoing label out of flow so the button measures only the incoming
       * one — otherwise the width springs to fit BOTH and then shrinks. The
       * single-cell grid is what keeps them stacked while they overlap.
       */}
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={state}
          layout="position"
          variants={CONTENT}
          initial="initial"
          animate="animate"
          exit="exit"
          transition={SWAP}
          className="inline-flex items-center gap-2 whitespace-nowrap"
        >
          {content}
        </motion.span>
      </AnimatePresence>
    </motion.button>
  )
}

/**
 * The state machine, so no caller writes it twice.
 *
 * ⚠ IT RETURNS `run`, NOT A SETTER, BECAUSE THE ORDER MATTERS AND IS EASY TO GET
 * WRONG. Pending has to be claimed BEFORE the await and released only after the
 * outcome is known; a caller holding raw state writes that by hand every time,
 * and the failure mode is a button that stays spinning after a call that threw.
 */
export function useActionState(): {
  state: ActionState
  run: (action: () => Promise<boolean>) => Promise<void>
  reset: () => void
} {
  const [state, setState] = React.useState<ActionState>("idle")

  const run = React.useCallback(async (action: () => Promise<boolean>) => {
    setState("pending")
    try {
      setState((await action()) ? "done" : "failed")
    } catch {
      // ⚠ A THROW IS A FAILURE LIKE ANY OTHER HERE. The alternative is an
      // unhandled rejection and a button left on "pending" forever, which is
      // the one outcome the person cannot act on.
      setState("failed")
    }
  }, [])

  const reset = React.useCallback(() => setState("idle"), [])

  return { state, run, reset }
}
