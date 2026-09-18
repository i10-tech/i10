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
 * ⚠ AND IT IS THREE BOOLEANS, BECAUSE THREE DIFFERENT QUESTIONS ARE BEING
 * ASKED. "Has this been left at least once", "is it being edited right now" and
 * "has the form been submitted" are independent, and collapsing any pair of
 * them produces a specific wrong screen:
 *
 *   touched merged into focused — a field left wrong, focused, then abandoned
 *   without an edit goes quietly back to grey. The person tabbed through it
 *   twice and the form now says nothing about a value it already refused.
 *
 *   submitted merged into touched — this is the one that shipped and was wrong.
 *   Tabbing through an EMPTY field marked it touched, so a box nobody had
 *   answered yet turned red for the crime of being looked at. Emptiness is not
 *   a mistake until somebody presses the button; malformedness is a mistake as
 *   soon as they stop typing it.
 */
export interface FieldFocus {
  /**
   * Whether a MALFORMED value may be painted red right now.
   *
   * ⚠ IT SAYS NOTHING ABOUT AN EMPTY ONE, AND THAT SEPARATION IS THE POINT.
   * Tabbing through a field you have not filled in yet is not a mistake — it is
   * how anybody reads a form before answering it, and reddening it is the
   * interface telling somebody off for looking. Emptiness is only a fault at the
   * moment they say they are finished, which is `submitted` below.
   */
  blurred: boolean
  /**
   * Whether an EMPTY value may be painted red right now.
   *
   * ⚠ ONLY EVER TRUE AFTER A REFUSED SUBMIT. Nothing a person does inside the
   * form sets this; pressing the button is the only thing that turns "you have
   * not filled this in" from an observation into a complaint.
   */
  submitted: boolean
  /**
   * Mark it as answered-for, for a submit that was refused.
   *
   * ⚠ NEEDED FOR THE FIELD NOBODY VISITED. Pressing the submit button with an
   * untouched password box has to say something about it, and `blurred` alone
   * would stay false because the field was never focused, so never blurred.
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
  const [submitted, setSubmitted] = useState(false)
  const [focused, setFocused] = useState(false)

  return {
    blurred: touched && !focused,
    // ⚠ `!focused` ON THIS ONE TOO, so an empty field that went red on submit
    // goes quiet the moment somebody clicks into it to answer it. Same rule as
    // everywhere else: red means "you stopped, and it is still wrong".
    submitted: submitted && !focused,
    reveal: () => setSubmitted(true),
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
