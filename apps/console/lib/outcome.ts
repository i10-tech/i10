"use client"

import * as React from "react"
import type { ActionState } from "@repo/ui/components/action-button"

/**
 * How every form in the console answers a submit: in place, and once.
 *
 * ⚠ THE ANSWER APPEARS WHERE THE QUESTION WAS ASKED. Pressing Save used to spin
 * the button, return it to "Save", close the dialog and slide a toast in from
 * the bottom-right corner — four things in three places, for one event, with
 * the only one that said "it worked" being the one furthest from the eye. The
 * language this replaces it with is Clerk's: the button you pressed becomes a
 * tick, the fields you filled in go green, and a dialog holds that for a beat
 * before it leaves — so the confirmation is the thing you were already
 * looking at. See `ActionButton` and the `data-outcome` note in floating-field.
 *
 * ⚠ A FAILURE GOES BACK TO IDLE, NOT TO "FAILED". Every failure in this product
 * is reported through `toastFailure`, with a title and the API's own sentence;
 * a button that also said "Failed" would announce the same event twice in two
 * wordings. The button's job on failure is to become pressable again, with
 * everything that was typed still in the form.
 *
 * ⚠ AND IT NEVER REFRESHES. The action's own response carries the re-rendered
 * page (see `run` in lib/actions.ts), so by the time `action` resolves the list
 * behind the dialog already shows the new row. The hold is the dialog standing
 * over a page that has finished changing — which is why nothing moves when it
 * closes.
 */

/**
 * ⚠ LONG ENOUGH TO READ ONE WORD AND SEE A COLOUR CHANGE, SHORT ENOUGH THAT
 * NOBODY WAITS FOR IT. The tick lands on a ~400ms spring; 700ms gives it the
 * settle and a moment at rest before the dialog's own exit starts. Longer reads
 * as the console making somebody watch it be pleased with itself.
 */
export const OUTCOME_HOLD_MS = 700

export function useOutcome(): {
  state: ActionState
  /**
   * Run `action`; on `true`, show the tick and call `then` after the hold.
   *
   * `action` reports its own failure (a toast) and returns `false` — the same
   * contract `ConfirmDialog.onConfirm` already has.
   */
  run: (action: () => Promise<boolean>, then?: () => void) => Promise<boolean>
  reset: () => void
  /** Spread on the `<form>`: turns every idle field inside it green on success. */
  formProps: { "data-outcome": ActionState }
} {
  const [state, setState] = React.useState<ActionState>("idle")
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  // ⚠ A HOLD THAT OUTLIVES ITS COMPONENT WOULD CLOSE A DIALOG THAT IS GONE, OR —
  // worse — one that was reopened in the meantime. Cleared on unmount.
  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const run = React.useCallback(
    async (action: () => Promise<boolean>, then?: () => void) => {
      if (timer.current) clearTimeout(timer.current)
      setState("pending")

      let ok = false
      try {
        ok = await action()
      } catch {
        // ⚠ A THROW IS A FAILURE LIKE ANY OTHER. The alternative is a button
        // left spinning for ever, which is the one state nobody can act on.
        ok = false
      }

      if (!ok) {
        setState("idle")
        return false
      }

      setState("done")
      if (then) timer.current = setTimeout(then, OUTCOME_HOLD_MS)
      return true
    },
    [],
  )

  const reset = React.useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    setState("idle")
  }, [])

  return { state, run, reset, formProps: { "data-outcome": state } }
}
