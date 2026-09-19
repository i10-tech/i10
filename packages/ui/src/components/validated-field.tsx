"use client"

import * as React from "react"
import type { Check } from "../checks"
import { releaseFocus, useFieldFocus, type FieldFocus } from "../hooks/field-focus"
import { FloatingInput, FloatingTextarea, type FieldState } from "./floating-field"

/**
 * A field that knows when it is wrong, and says so at the right moment.
 *
 * ⚠ THE TIMING RULES WERE CORRECT AND COPIED BY HAND INTO TWO SCREENS, WHICH IS
 * WHY THIS EXISTS. Red only once somebody has stopped typing, green only where
 * a value was shown wrong and has since been fixed, empty never red until the
 * button is pressed — three rules, each with a failure mode that looks like a
 * design choice rather than a bug, reproduced at every call site by whoever
 * remembered. The sign-in box and the add-domain box got them right. The
 * eighteen other inputs in the product got nothing at all: `required` on the
 * element, the browser's own grey bubble in the operating system's font, and
 * an email field that accepted anything.
 *
 * ⚠ SO THE CALLER SUPPLIES THE RULE AND NOTHING ELSE. `check` returns the
 * sentence to show or `null`; `required` is the sentence for an empty box at
 * submit time. Everything between — when to redden, when to go green, when to
 * stay quiet, whether to block the submit — is here, once.
 *
 * ⚠ AND IT FINDS ITS OWN FORM RATHER THAN BEING WIRED TO ONE. `input.form` is
 * the element the browser already associates with this control, so a field
 * refuses its own submit by listening for it — no context, no provider, no
 * registry, and no change to the twenty forms that already exist. A new input
 * works by being rendered.
 */

export interface ValidatedFieldProps {
  /**
   * What is wrong with what is in the box, or `null`.
   *
   * ⚠ NEVER CALLED WITH AN EMPTY VALUE. Emptiness is handled by `required`,
   * because the two are revealed at different moments and a check that had to
   * express both would have to know which moment it was being asked in.
   */
  check?: Check
  /**
   * The sentence for an empty box, and the fact that empty is not allowed.
   *
   * ⚠ IT IS THE MESSAGE RATHER THAN A BOOLEAN, AND IT REPLACES THE `required`
   * ATTRIBUTE RATHER THAN JOINING IT. The DOM attribute summons the browser's
   * own validation bubble — a grey tooltip in the operating system's font,
   * positioned by the browser, saying "Please fill out this field." It arrives
   * BEFORE the submit event, so it pre-empts everything below, and it is the
   * one piece of this product's interface nobody here designed. Passing a
   * sentence instead means the field says what it wants in our own words, in
   * our own colours, in the row that is already reserved for it.
   */
  required?: string
  /**
   * Keep a permanent row for the message, or draw it into the gap below.
   *
   * ⚠ THE DEFAULT IS DERIVED FROM WHETHER THERE IS A DESCRIPTION, AND THAT IS
   * THE WHOLE ANSWER TO "WHY DID THE FORM JUMP". There are two kinds of line
   * under a field and they want opposite layouts — see `Frame` in
   * floating-field. A description is content and belongs in the flow; a
   * validation message is absent most of the time, so reserving a strip for it
   * makes every field permanently taller against a moment that may never come.
   *
   * Neither of those should ever MOVE anything, and the rule that achieves it
   * is the same one either way: a field with a description already has a row,
   * and the red sentence swaps into it; a field without one has no row, and
   * the red sentence lands in the gap the layout already leaves between
   * fields. Nothing is added, so nothing below it can be pushed down.
   *
   * ⚠ IT WAS A HAND-PASSED FLAG, WHICH MEANT THE TWO SCREENS SOMEBODY HAD
   * THOUGHT ABOUT DID NOT JUMP AND THE OTHER EIGHTEEN DID. Deriving it removes
   * the decision rather than documenting it; an explicit value still wins for
   * the field that knows better.
   */
  reserveHint?: boolean
  /**
   * Show the waiting tone regardless of the verdict.
   *
   * ⚠ FOR WORK THE FIELD CANNOT DO ITSELF — the add-domain box asking DNS who
   * hosts a name. A verdict is about the shape of the value; this is about
   * something still being in flight, and the two are different colours.
   */
  busy?: boolean
}

/**
 * The verdict a value has earned, given what the person has done so far.
 *
 * ⚠ IT IS THE SAME FUNCTION `emailVerdict` AND `domainVerdict` BOTH WERE. Those
 * two were written months apart from the same set of rules and agreed, which
 * is luck rather than design — the third copy is where they stop agreeing, and
 * the symptom is one screen reddening a field somebody is still typing into
 * while another waits.
 */
export function fieldVerdict(
  value: string,
  focus: Pick<FieldFocus, "blurred" | "submitted" | "recovering">,
  { check, required }: Pick<ValidatedFieldProps, "check" | "required">,
): { state: FieldState; hint?: string } {
  /*
   * ⚠ EMPTY IS NOT WRONG UNTIL THE BUTTON IS PRESSED. Tabbing through a box you
   * have not answered yet is how people read a form; reddening it for that is
   * the interface telling somebody off for looking.
   */
  if (value.trim() === "") {
    return focus.submitted && required
      ? { state: "invalid", hint: required }
      : { state: "idle" }
  }

  const problem = check?.(value) ?? null

  /*
   * ⚠ CORRECT IS NOT THE SAME AS GREEN. Most fields are filled in correctly
   * first time and saying so is not news — green is spent only on a value that
   * was SHOWN wrong and has since been fixed, and only while the caret is
   * still in the box asking the question green answers.
   */
  if (!problem) return focus.recovering ? { state: "valid" } : { state: "idle" }

  const { message, early } =
    typeof problem === "string" ? { message: problem, early: false } : problem

  /*
   * ⚠ AND RED WAITS. Every value is wrong while it is being typed — `m`, `mi`,
   * `mid` — so a field that reddens on the first keystroke is red for the whole
   * time anybody is using it, and the colour stops meaning anything at all.
   */
  if (focus.blurred) return { state: "invalid", hint: message }
  return early ? { state: "idle", hint: message } : { state: "idle" }
}

/** Whether this value should stop the form being submitted. */
export function fieldBlocks(
  value: string,
  { check, required }: Pick<ValidatedFieldProps, "check" | "required">,
): boolean {
  if (value.trim() === "") return required !== undefined
  return (check?.(value) ?? null) !== null
}

/**
 * Refuse this field's own submit, and let the person see why.
 *
 * ⚠ IT LISTENS ON THE FORM ELEMENT, WHICH RUNS BEFORE REACT'S `onSubmit`. React
 * delegates events to the root container, so a native listener on the form
 * itself is reached first as the event passes through its target — early enough
 * to stop it.
 *
 * ⚠ AND IT STOPS PROPAGATION AS WELL AS THE DEFAULT, WHICH IS THE ONLY PART
 * THAT ACTUALLY BLOCKS ANYTHING. `preventDefault()` alone suppresses the
 * browser's native navigation, which these forms never use — every one of them
 * is a React `onSubmit` that calls an action. That handler lives at the root
 * and would run regardless, so the invalid form would submit anyway with a
 * red border next to it. Stopping propagation is what keeps it from being
 * reached.
 *
 * ⚠ EVERY FIELD STILL GETS ITS TURN. `stopPropagation` ends the journey to the
 * root but not the listeners already registered on this same element, so the
 * other fields on the form reveal themselves in the same pass — which is the
 * behaviour anybody expects from pressing a button on a form with three empty
 * boxes.
 *
 * ⚠ AND THE FOCUS IS RELEASED FIRST. Pressing Enter inside a box submits
 * without blurring it, and a focused field is never painted red — so without
 * this the guard refuses and nothing on screen changes, which is a button that
 * visibly does nothing. See `releaseFocus`.
 */
function useSubmitGuard(
  ref: React.RefObject<HTMLElement | null>,
  onRefuse: (wrong: boolean) => void,
  wrongNow: () => boolean,
) {
  /*
   * ⚠ THE LATEST VALUE THROUGH A REF, so the listener is attached once rather
   * than removed and re-added on every keystroke — a `submit` handler that is
   * swapped on each render is a handler that can be missing at the moment the
   * button is pressed.
   *
   * ⚠ AND IT IS WRITTEN IN AN EFFECT, NOT DURING RENDER. The React compiler
   * refuses a ref assignment in the render body, correctly: a render can be
   * discarded, and a ref written during one that never commits is a listener
   * closing over a value the person never saw.
   */
  const latest = React.useRef({ onRefuse, wrongNow })
  React.useEffect(() => {
    latest.current = { onRefuse, wrongNow }
  })

  React.useEffect(() => {
    const control = ref.current
    const form =
      control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement
        ? control.form
        : null
    if (!form) return

    const onSubmit = (event: Event) => {
      releaseFocus()
      const wrong = latest.current.wrongNow()
      latest.current.onRefuse(wrong)
      if (!wrong) return
      event.preventDefault()
      event.stopPropagation()
    }

    form.addEventListener("submit", onSubmit)
    return () => form.removeEventListener("submit", onSubmit)
  }, [ref])
}

/**
 * What is actually in the box, whether or not React is holding it.
 *
 * ⚠ THIS FIELD USED TO ASSUME IT WAS CONTROLLED, AND THE ONE INPUT IN THE
 * PRODUCT THAT IS NOT WAS THE SIGN-IN PASSWORD. Reading `value` off the props
 * of an uncontrolled input gives `undefined` on every render, which became the
 * empty string, which `required` reads as "they left it blank" — so typing a
 * perfectly good password and pressing Login painted the field red and said
 * "Enter your password" over a box with a password in it, and the submit guard
 * refused the form on top of that. It was not a sign-in bug; it was this
 * component being silently wrong about an entirely ordinary way to use an
 * input.
 *
 * ⚠ AND UNCONTROLLED IS THE RIGHT CHOICE THERE, WHICH IS WHY THIS TRACKS THE
 * DOM RATHER THAN THE CALL SITE BEING CORRECTED. A password field that
 * re-renders its parent on every keystroke is a password in React state for no
 * reason; `FloatingInput` is already CSS-only for exactly this, and the form
 * reads the value from `FormData` at submit time. The fix belongs where the
 * assumption was.
 *
 * ⚠ IT LISTENS FOR `input` **AND** `change`, because a password manager is not
 * a keyboard. 1Password and the browser's own autofill set `.value` and
 * dispatch one or the other depending on the browser — missing that would put
 * us straight back to "there is text on screen and this component thinks the
 * box is empty", which is the bug.
 *
 * ⚠ AND IT READS ONCE ON MOUNT, for `defaultValue` and for a browser restoring
 * a form on a back navigation. Neither fires an event.
 */
function useLiveValue(
  ref: React.RefObject<HTMLInputElement | HTMLTextAreaElement | null>,
  value: unknown,
): string {
  const controlled = value !== undefined
  const [mirror, setMirror] = React.useState("")

  React.useEffect(() => {
    if (controlled) return
    const control = ref.current
    if (!control) return

    const read = () => setMirror(control.value)
    read()

    control.addEventListener("input", read)
    control.addEventListener("change", read)
    return () => {
      control.removeEventListener("input", read)
      control.removeEventListener("change", read)
    }
  }, [controlled, ref])

  return controlled ? String(value ?? "") : mirror
}

type InputProps = Omit<
  React.ComponentProps<typeof FloatingInput>,
  "state" | "required" | "reserveHint"
> &
  ValidatedFieldProps

export function ValidatedInput({
  check,
  required,
  busy,
  hint,
  reserveHint,
  value,
  ref,
  spellCheck,
  ...props
}: InputProps) {
  const own = React.useRef<HTMLInputElement>(null)
  const text = useLiveValue(own, value)

  const focus = useFieldFocus((v) => v.trim() !== "" && (check?.(v) ?? null) !== null)
  useSubmitGuard(own, focus.reveal, () =>
    fieldBlocks(own.current?.value ?? text, { check, required }),
  )

  const verdict = fieldVerdict(text, focus, { check, required })

  return (
    <FloatingInput
      {...props}
      value={value}
      /*
       * ⚠ OFF BY DEFAULT, BECAUSE THE BROWSER'S RED IS OUR RED. A spell-checker
       * draws a red wavy line under `i10.tech`, `acme-corp`, `prod-api-key` and
       * most surnames — a claim about correctness, in the one colour this
       * component spends its whole existence making mean something, about words
       * it has no opinion worth having on. Two different systems marking the
       * same field wrong for different reasons is worse than either alone.
       *
       * ⚠ A SINGLE-LINE FIELD IS NOT PROSE, WHICH IS WHAT MAKES THIS SAFE AS A
       * DEFAULT RATHER THAN A DECISION PER CALL SITE. It holds a name, an
       * address, a domain, a key — identifiers, where a dictionary is wrong by
       * construction. `ValidatedTextarea` deliberately does NOT do this: that
       * one holds sentences somebody wrote, and a spell-checker is earning its
       * keep there. Anything single-line that really is prose — a subject line
       * — passes `spellCheck` back on.
       */
      spellCheck={spellCheck ?? false}
      ref={mergeRefs(own, ref)}
      {...focus.props}
      state={busy ? "pending" : verdict.state}
      // ⚠ THE CALLER'S HINT IS THE RESTING STATE, NOT A COMPETITOR. Guidance
      // shows while there is nothing to complain about and steps aside for a
      // correction, which is the same row either way — so nothing moves.
      hint={verdict.hint ?? hint}
      // See `reserveHint` above: a row only exists where there is something
      // permanent to put in it.
      reserveHint={reserveHint ?? hint !== undefined}
      // See `required` above: the attribute is deliberately absent so the
      // browser's own bubble cannot pre-empt ours.
      aria-required={required !== undefined || undefined}
    />
  )
}

type TextareaProps = Omit<
  React.ComponentProps<typeof FloatingTextarea>,
  "state" | "required" | "reserveHint"
> &
  ValidatedFieldProps

export function ValidatedTextarea({
  check,
  required,
  busy,
  hint,
  reserveHint,
  value,
  ref,
  ...props
}: TextareaProps) {
  const own = React.useRef<HTMLTextAreaElement>(null)
  const text = useLiveValue(own, value)

  const focus = useFieldFocus((v) => v.trim() !== "" && (check?.(v) ?? null) !== null)
  useSubmitGuard(own, focus.reveal, () =>
    fieldBlocks(own.current?.value ?? text, { check, required }),
  )

  const verdict = fieldVerdict(text, focus, { check, required })

  return (
    <FloatingTextarea
      {...props}
      value={value}
      ref={mergeRefs(own, ref)}
      onFocus={focus.props.onFocus}
      // ⚠ RETYPED RATHER THAN SPREAD. `useFieldFocus` is written against an
      // input's blur event; a textarea's carries the same `currentTarget.value`
      // and nothing else is read from it.
      onBlur={(event) =>
        focus.props.onBlur(event as unknown as React.FocusEvent<HTMLInputElement>)
      }
      state={busy ? "pending" : verdict.state}
      hint={verdict.hint ?? hint}
      reserveHint={reserveHint ?? hint !== undefined}
      aria-required={required !== undefined || undefined}
    />
  )
}

/** Our own ref plus whatever the caller wanted. */
function mergeRefs<T>(
  own: React.RefObject<T | null>,
  theirs: React.Ref<T> | undefined,
): React.RefCallback<T> {
  return (node) => {
    own.current = node
    if (typeof theirs === "function") theirs(node)
    else if (theirs) theirs.current = node
  }
}
