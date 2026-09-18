"use client"

import { useState } from "react"

/**
 * When a field has earned the right to turn red.
 *
 * ⚠ THE RULE IS "WRONG **AND** NOT FOCUSED", NOT "WRONG AND ONCE BLURRED", AND
 * THE DIFFERENCE IS THE WHOLE REASON THIS EXISTS. Marking a field touched on
 * blur and leaving it touched means the border is red for the entire time
 * somebody is FIXING it: they tab away from `mido@`, it goes red — correctly —
 * they click back in to finish typing the domain, and it stays red at them
 * through every keystroke of the correction. The colour is then reporting a
 * judgement about a value that no longer exists.
 *
 * Releasing the error on focus makes red mean one specific thing: you have
 * stopped, and it is still wrong. Nothing else in the form has to change for
 * that to read correctly, because green is not gated the same way — see
 * `emailVerdict` in validate.ts, which confirms a valid value the instant it
 * becomes valid, focused or not.
 *
 * ⚠ AND IT IS TWO BOOLEANS RATHER THAN ONE, BECAUSE "HAS BEEN LEFT AT LEAST
 * ONCE" AND "IS BEING EDITED RIGHT NOW" ARE DIFFERENT QUESTIONS. Collapsing
 * them — clearing `touched` on focus — would mean a field that was left wrong,
 * focused, and then abandoned without an edit goes quietly back to grey. The
 * person tabbed through it twice and the form now says nothing about a value it
 * has already refused once.
 */
export interface FieldFocus {
  /** Whether an error may be painted right now. */
  show: boolean
  /**
   * Mark it as left, for a submit that was refused.
   *
   * ⚠ NEEDED FOR THE FIELD NOBODY VISITED. Pressing the submit button with an
   * untouched password box has to say something about it, and `show` alone
   * would stay false because the field was never blurred — it was never
   * focused either.
   */
  reveal: () => void
  /** Spread onto the input. */
  props: {
    onFocus: () => void
    onBlur: () => void
  }
}

export function useFieldFocus(): FieldFocus {
  const [touched, setTouched] = useState(false)
  const [focused, setFocused] = useState(false)

  return {
    show: touched && !focused,
    reveal: () => setTouched(true),
    props: {
      onFocus: () => setFocused(true),
      onBlur: () => {
        setFocused(false)
        setTouched(true)
      },
    },
  }
}

/**
 * Let go of whatever has focus, so a refused submit can be seen.
 *
 * ⚠ IT BLURS THE DOM RATHER THAN FAKING THE STATE, AND THAT IS WHAT KEEPS THE
 * RULE ABOVE HONEST. Pressing Enter inside the email box submits the form
 * without blurring anything, so the field is still focused when the guard
 * refuses — and under "not focused" it would show nothing at all, which is a
 * button that visibly does nothing. Setting `focused` to false by hand would
 * fix that screen and break the next one: the caret is still in the box, so the
 * correction they type would be typed at a red border again.
 *
 * Actually removing focus means the blur handler runs, the state is true, and
 * clicking back in to fix it clears the error exactly as it does everywhere
 * else. Clicking the submit button rather than pressing Enter has already
 * blurred the inputs, so this is a no-op on that path.
 */
export function releaseFocus(): void {
  const active = document.activeElement
  if (active instanceof HTMLElement) active.blur()
}
