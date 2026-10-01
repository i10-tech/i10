"use client"

import * as React from "react"
import { cn } from "cn"
import { domainCompletion, domainCorrection } from "../email-domains"
import { ValidatedInput } from "./validated-field"

/**
 * An email box that finishes the domain (#175).
 *
 * Type `@` and the most likely provider appears as ghost text after the caret;
 * keep typing and it narrows. Tab, → or a click on the ghost accepts it, Esc
 * dismisses it. A domain one slip away from a common provider gets a "Did you
 * mean …?" in the hint row, which is a button.
 *
 * ⚠ GHOST TEXT, NOT A LIST. A dropdown under the sign-in email box would sit
 * on top of the password manager's own menu and the passkey autofill prompt,
 * which attach to the same field. Ghost text occupies only the space the value
 * is about to fill, so it cannot cover anything.
 *
 * ⚠ IT NEVER CHANGES THE VALUE ON ITS OWN. Nothing is accepted until somebody
 * presses a key or clicks; the field's value is only ever what they typed or
 * chose, so autofill, password managers and `autocomplete="email webauthn"`
 * see exactly the input they would without this component.
 *
 * ⚠ AND IT STEPS ASIDE FOR AUTOFILL. A filled address is complete, so it never
 * has a completion anyway; the `insertReplacementText` check below also hides
 * the ghost when a browser replaces the value wholesale (autofill, a
 * password-manager fill, a suggestion picked from the browser's own list) until
 * the next real keystroke.
 */
export function EmailInput({
  hint,
  reserveHint,
  className,
  onChange,
  onKeyDown,
  ref,
  ...props
}: Omit<React.ComponentProps<typeof ValidatedInput>, "type" | "underlay">) {
  const own = React.useRef<HTMLInputElement>(null)
  // The DOM's value, mirrored so an uncontrolled caller gets suggestions too.
  const [text, setText] = React.useState(() => String(props.value ?? ""))
  const [focused, setFocused] = React.useState(false)
  const [atEnd, setAtEnd] = React.useState(true)
  // The text the ghost was dismissed at, by Esc or by a wholesale fill.
  const [quietAt, setQuietAt] = React.useState<string | null>(null)

  const current = props.value !== undefined ? String(props.value) : text
  const completion =
    focused && atEnd && quietAt !== current ? domainCompletion(current) : null
  const correction = completion ? null : domainCorrection(current)

  function syncCaret() {
    const el = own.current
    if (!el) return
    // ⚠ `type="email"` HAS NO SELECTION API - Chrome throws on reading it and
    // reports `null`. Anywhere but the end the ghost would sit in the middle of
    // the text, so "unknown" is treated as "at the end" only when nothing is
    // selected, which is the only state a selection-less input can be in.
    const start = el.selectionStart
    setAtEnd(start === null || (start === el.selectionEnd && start === el.value.length))
  }

  /**
   * Put `next` in the field the way typing would.
   *
   * ⚠ THROUGH THE NATIVE SETTER AND A REAL `input` EVENT, NOT BY CALLING
   * `onChange`. React tracks the value it last rendered and drops an event
   * whose value it already knows; the prototype setter bypasses that tracker,
   * so the caller's `onChange` fires with a real event, and the uncontrolled
   * case - which has no `onChange` to call - works identically.
   */
  function fill(next: string) {
    const el = own.current
    if (!el) return
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
      el,
      next,
    )
    el.dispatchEvent(new Event("input", { bubbles: true }))
    el.focus()
  }

  const accept = () => completion && fill(current + completion)

  return (
    <div
      className="contents"
      onFocus={() => {
        setFocused(true)
        syncCaret()
      }}
      onBlur={() => setFocused(false)}
    >
      <ValidatedInput
        {...props}
        type="email"
        ref={mergeRefs(own, ref)}
        className={className}
        role="combobox"
        aria-autocomplete="inline"
        aria-expanded={false}
        onChange={(event) => {
          const native = event.nativeEvent as InputEvent
          setText(event.currentTarget.value)
          setQuietAt(
            native.inputType === "insertReplacementText"
              ? event.currentTarget.value
              : null,
          )
          syncCaret()
          onChange?.(event)
        }}
        onSelect={syncCaret}
        onKeyDown={(event) => {
          if (completion) {
            const caretKey =
              event.key === "ArrowRight" && !event.shiftKey && !event.metaKey
            if ((event.key === "Tab" && !event.shiftKey) || caretKey) {
              event.preventDefault()
              accept()
              return
            }
            if (event.key === "Escape") {
              // Only swallowed when there was a ghost to dismiss, so Esc still
              // closes the dialog an email box sits in.
              event.preventDefault()
              event.stopPropagation()
              setQuietAt(current)
              return
            }
          }
          onKeyDown?.(event)
        }}
        hint={
          correction ? (
            <>
              Did you mean{" "}
              <button
                type="button"
                className="font-medium text-foreground underline-offset-2 hover:underline"
                onClick={() => fill(correction)}
              >
                {correction}
              </button>
              ?
            </>
          ) : (
            hint
          )
        }
        // ⚠ PINNED TO THE CALLER'S OWN HINT, so a correction appearing cannot
        // grow a row the field did not have and push the button below it down.
        reserveHint={reserveHint ?? hint !== undefined}
        underlay={
          completion ? (
            <span
              aria-hidden="true"
              className={cn(
                // ⚠ THE SAME BOX, PADDING AND TYPE AS THE INPUT'S VALUE, or the
                // ghost lands beside the text rather than after it. Callers'
                // `className` (the console's mono `text-xs`) comes along too.
                "pointer-events-none absolute inset-0 flex items-center overflow-hidden px-6 text-base whitespace-pre",
                className,
              )}
            >
              <span className="invisible">{current}</span>
              <span
                className="pointer-events-auto cursor-text text-muted-foreground/70"
                // mousedown, not click: a click would blur the input first.
                onMouseDown={(event) => {
                  event.preventDefault()
                  accept()
                }}
              >
                {completion}
              </span>
            </span>
          ) : null
        }
      />
      {/*
       * ⚠ THE INPUT'S OWN HINT ROW ANNOUNCES CORRECTIONS; THIS ANNOUNCES THE
       * GHOST, which a screen reader cannot see because it is not the value.
       * Always mounted, so the region exists before its text arrives.
       */}
      <span aria-live="polite" className="sr-only">
        {completion ? `Suggestion: ${current}${completion}. Press Tab to accept.` : ""}
      </span>
    </div>
  )
}

function mergeRefs<T>(...refs: (React.Ref<T> | undefined)[]): React.RefCallback<T> {
  return (node) => {
    for (const ref of refs) {
      if (typeof ref === "function") ref(node)
      else if (ref) ref.current = node
    }
  }
}
