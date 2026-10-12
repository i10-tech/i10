"use client"

import * as React from "react"
import { Check, X } from "lucide-react"
import { Button, type ButtonProps } from "../button/button"

export type ActionState = "idle" | "pending" | "done" | "failed"

/**
 * A button that reports the outcome of the action it started, in place.
 *
 * Arc's rule is that a foreground action confirms on the control itself, not
 * in a toast. This is Arc's Button driven by an outcome state: `loading`
 * while pending, then the label morphs to "Saved" (or "Failed") with Arc's
 * width spring, and back to idle after `resetAfter`.
 *
 * Kept as a state-driven API (rather than Arc's promise-driven ActionButton)
 * because the forms here own their outcome through `useActionState` and
 * submit with `type="submit"`.
 */
export function StateButton({
  state,
  children,
  pendingLabel,
  doneLabel = "Done",
  failedLabel = "Failed",
  resetAfter = 1800,
  onReset,
  disabled,
  ...props
}: Omit<ButtonProps, "children" | "loading"> & {
  state: ActionState
  children: React.ReactNode
  /** Announced while pending; the button shows Arc's spinner. */
  pendingLabel: string
  doneLabel?: string
  failedLabel?: string
  resetAfter?: number
  onReset?: () => void
}) {
  React.useEffect(() => {
    if (!onReset || resetAfter <= 0) return
    if (state !== "done" && state !== "failed") return
    const timer = setTimeout(onReset, resetAfter)
    return () => clearTimeout(timer)
  }, [state, resetAfter, onReset])

  const label =
    state === "done" ? (
      <>
        <Check size={16} strokeWidth={1.75} aria-hidden="true" />
        {doneLabel}
      </>
    ) : state === "failed" ? (
      <>
        <X size={16} strokeWidth={1.75} aria-hidden="true" />
        {failedLabel}
      </>
    ) : (
      children
    )

  return (
    <Button
      {...props}
      loading={state === "pending"}
      disabled={disabled}
      aria-live="polite"
      aria-label={state === "pending" ? pendingLabel : props["aria-label"]}
    >
      {label}
    </Button>
  )
}

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
      setState("failed")
    }
  }, [])
  const reset = React.useCallback(() => setState("idle"), [])
  return { state, run, reset }
}
