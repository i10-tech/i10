"use client"

import { useState } from "react"

/**
 * When a field has earned the right to turn red, and when it has earned green.
 *
 * ⚠ THE RULE FOR RED IS "WRONG **AND** NOT FOCUSED", NOT "WRONG AND ONCE
 * BLURRED". Marking a field touched on blur and leaving it touched means the
 * border is red for the entire time somebody is FIXING it: they tab away from
 * `mido@`, it goes red — correctly — they click back in to finish typing the
 * domain, and it stays red at them through every keystroke of the correction.
 * The colour is then reporting a judgement about a value that no longer exists.
 *
 * ⚠ AND GREEN IS A RECOVERY SIGNAL, NOT A RECEIPT. Confirming every correct
 * value the moment it becomes correct sounds helpful and is nearly worthless:
 * on a form where most people type most fields correctly first time, green
 * appears on almost everything, carries no information, and costs the one
 * colour in a monochrome palette that means "resolved". It is worth something
 * in exactly one situation — this field was shown to be wrong, and now is not —
 * so that is the only situation it appears in.
 *
 * ⚠ AND ONLY WHILE THE CARET IS STILL IN IT. Green answers a question somebody
 * is actively asking: "is this right yet?" Once they have moved on, the answer
 * is no longer wanted and a row of green borders down a finished form is
 * decoration. Leaving the field retires it.
 *
 * ⚠ SO FOUR BOOLEANS, BECAUSE FOUR DIFFERENT QUESTIONS ARE BEING ASKED. "Has
 * this been left at least once", "is it being edited right now", "has the form
 * been submitted" and "has it ever actually been shown wrong" are independent,
 * and collapsing any pair of them produces a specific wrong screen:
 *
 *   touched merged into focused — a field left wrong, focused, then abandoned
 *   without an edit goes quietly back to grey. The person tabbed through it
 *   twice and the form now says nothing about a value it already refused.
 *
 *   submitted merged into touched — this one shipped and was wrong. Tabbing
 *   through an EMPTY field marked it touched, so a box nobody had answered yet
 *   turned red for the crime of being looked at. Emptiness is not a mistake
 *   until somebody presses the button; malformedness is a mistake as soon as
 *   they stop typing it.
 *
 *   wrongWhenLeft merged into touched — green on any correct field that had
 *   ever been visited, which is every field on a completed form.
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
   * Whether a CORRECT value may be painted green right now.
   *
   * ⚠ BOTH HALVES ARE REQUIRED. It has to have been wrong — otherwise green is
   * a receipt for typing something correctly, which is not news — and the caret
   * has to still be in it, because the question green answers is "is this right
   * yet", and that question stops being asked the moment somebody moves on.
   *
   * ⚠ AND IT IS SPENT ONCE. Leaving a field that is now correct clears the
   * record of it having been wrong, so coming back to it shows nothing: the
   * correction has been acknowledged and saying so a second time is the same
   * decoration the "green on everything" version was. Getting it wrong AGAIN
   * re-arms it, which is what makes this repeatable rather than a one-shot.
   */
  recovering: boolean
  /**
   * Mark it as answered-for, for a submit that was refused.
   *
   * ⚠ NEEDED FOR THE FIELD NOBODY VISITED. Pressing the submit button with an
   * untouched password box has to say something about it, and `blurred` alone
   * would stay false because the field was never focused, so never blurred.
   *
   * ⚠ AND IT TAKES WHETHER **THIS** FIELD IS THE PROBLEM. A refused submit
   * reveals every field at once, but only the ones actually at fault have been
   * shown wrong — telling a valid field it was wrong would make it go green the
   * next time somebody clicked into it, for nothing.
   */
  reveal: (wrong: boolean) => void
  /** Spread onto the input. */
  props: {
    onFocus: () => void
    onBlur: (event: React.FocusEvent<HTMLInputElement>) => void
  }
}

/**
 * @param isWrong Whether what is in the box is MALFORMED — not merely empty.
 *   Read at blur time from the event's own value rather than from a prop, so
 *   there is no render-phase latch and no stale closure to reason about.
 */
export function useFieldFocus(isWrong: (value: string) => boolean): FieldFocus {
  const [touched, setTouched] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [focused, setFocused] = useState(false)
  /*
   * ⚠ "WAS IT WRONG THE LAST TIME THE CARET LEFT", NOT "HAS IT EVER BEEN
   * WRONG", AND THE SHORTER MEMORY IS WHAT MAKES GREEN MEAN SOMETHING. The
   * first version of this latched for ever, so a field corrected once went
   * green every subsequent time anybody clicked into it — which is the "green
   * on everything" problem arriving by a slower route.
   *
   * Clearing it on a clean exit reads as an acknowledgement: the interface
   * confirmed the fix, you left, and it has nothing further to say. Typing
   * something wrong and leaving again sets it right back, so the whole
   * red-then-green cycle repeats as many times as somebody needs it to.
   */
  const [wrongWhenLeft, setWrongWhenLeft] = useState(false)

  return {
    blurred: touched && !focused,
    // ⚠ `!focused` ON THIS ONE TOO, so an empty field that went red on submit
    // goes quiet the moment somebody clicks into it to answer it. Same rule as
    // everywhere else: red means "you stopped, and it is still wrong".
    submitted: submitted && !focused,
    // ⚠ AND `focused` RATHER THAN `!focused` ON THIS ONE, which is the whole
    // asymmetry. Red is for when you have stopped; green is for while you are
    // still going.
    recovering: wrongWhenLeft && focused,
    reveal: (wrong) => {
      setSubmitted(true)
      if (wrong) setWrongWhenLeft(true)
    },
    props: {
      onFocus: () => setFocused(true),
      onBlur: (event) => {
        setFocused(false)
        setTouched(true)
        /*
         * ⚠ SET **AND CLEARED** HERE, WHICH IS THE WHOLE OF THE "GREEN ONCE"
         * RULE. Leaving while wrong arms it; leaving while right disarms it.
         * One assignment rather than a latch and a separate reset, so there is
         * no state in which the two disagree.
         *
         * ⚠ AN EMPTY BOX COUNTS AS NOT WRONG, which is also how it resets.
         * Clearing a field and tabbing out disarms green, so the next round of
         * wrong-then-right earns it again — and a reload does the same thing
         * for free, because none of this outlives the component.
         */
        setWrongWhenLeft(isWrong(event.currentTarget.value))
      },
    },
  }
}

/**
 * Let go of whatever has focus, so a refused submit can be seen.
 *
 * ⚠ IT BLURS THE DOM RATHER THAN FAKING THE STATE, AND THAT IS WHAT KEEPS THE
 * RULES ABOVE HONEST. Pressing Enter inside the email box submits the form
 * without blurring anything, so the field is still focused when the guard
 * refuses — and under "not focused" it would show nothing at all, which is a
 * button that visibly does nothing. Setting `focused` to false by hand would fix
 * that screen and break the next one: the caret is still in the box, so the
 * correction they type would be typed at a red border again.
 *
 * Actually removing focus means the blur handler runs, every flag is true for
 * the right reason, and clicking back in to fix it clears the error exactly as
 * it does everywhere else. Clicking the submit button rather than pressing Enter
 * has already blurred the inputs, so this is a no-op on that path.
 */
export function releaseFocus(): void {
  const active = document.activeElement
  if (active instanceof HTMLElement) active.blur()
}
