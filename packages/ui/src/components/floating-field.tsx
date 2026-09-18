"use client"

import * as React from "react"
import { cn } from "cn"

/**
 * An input whose label starts inside it and rises out of the way when you type.
 *
 * The pattern is the one on auth.openai.com's sign-in field: at rest the label
 * sits where the value will be, at the value's size, so the field reads as a
 * single object rather than a caption stacked on a box. On focus — or as soon as
 * there is anything to show — it shrinks and moves to the top, and the value
 * takes the space it left.
 *
 * ⚠ THE WHOLE THING IS CSS. There is no `useState`, no `onFocus`, and no
 * `onChange` handler, which matters for more than tidiness: a React-driven float
 * cannot see the browser autofilling a password manager's saved email, so the
 * label would sit ON TOP of text the person can already read. `:placeholder-shown`
 * is evaluated by the browser against the live value and gets autofill right for
 * free. It also means this component works uncontrolled, inside a plain `<form>`,
 * with no re-render per keystroke.
 *
 * ⚠ AND THAT IS WHY `placeholder=" "` IS FORCED AND NOT A PROP. The selector
 * below keys off `:placeholder-shown`, which is true only while the field is
 * empty AND a placeholder attribute exists. With no placeholder the pseudo-class
 * never matches and the label is stuck in the floated position over an empty
 * box; with a REAL placeholder the person sees two labels at once. A single
 * space is the established way to ask for the pseudo-class and render nothing.
 * Anything a caller would have put in `placeholder` belongs in `hint`.
 */

export type FieldState = "idle" | "pending" | "invalid" | "valid"

/**
 * ⚠ ONE COMPOUND SELECTOR, NOT TWO STACKED VARIANTS, AND THE DIFFERENCE IS A
 * REAL BUG. The obvious spelling is `peer-placeholder-shown:` for the resting
 * position and `peer-focus:` to override it — but those generate two rules of
 * IDENTICAL specificity, so which one wins is decided by the order Tailwind
 * happens to emit them in. It currently emits focus last and it currently works;
 * a Tailwind upgrade that reorders variants would drop the label back over the
 * caret with nothing in any build log. `:placeholder-shown:not(:focus)` is a
 * single selector that is simply true or false, and cannot be reordered.
 *
 * ⚠ AND THE VARIANT IS REPEATED IN FULL ON EVERY LINE RATHER THAN FACTORED INTO
 * A CONSTANT. It was written as `` `${RESTING}top-1/2` `` first, and every label
 * in both apps rendered stuck in the floated position over an empty box.
 * Tailwind finds classes by scanning source text for complete literals; a
 * template string is not one, so the scanner saw `top-1/2` and never generated
 * the variant that actually positions the label. The repetition is not
 * stylistic — it is the only form the compiler can see.
 */
const FLOAT_LABEL = cn(
  "pointer-events-none absolute start-4 z-10 origin-[0_0] truncate",
  "max-w-[calc(100%-2rem)] text-2xs font-medium",
  // ⚠ NOT `transition-all`. A label that animates its COLOUR on the same curve
  // as its position reads as laggy on hover; position and size get the eased
  // curve, colour gets the linear instant one. Both are Base's values.
  "transition-[top,font-size,color] duration-(--duration-instant) ease-(--ease-quint-out)",
  "peer-[:placeholder-shown:not(:focus)]:text-sm",
  "peer-[:placeholder-shown:not(:focus)]:font-normal",
)

/**
 * ⚠ THE RESTING POSITION DIFFERS BY CONTROL AND CANNOT BE SHARED. On the input
 * the label rests where the value will be, which is the vertical centre of a
 * fixed 56px box. On a textarea the value starts at the TOP of a box four rows
 * tall, so centring the label would park it in the middle of the writing area —
 * the caret would be two lines above the thing naming the field.
 */
const RESTS_CENTRED = cn(
  "top-2",
  "peer-[:placeholder-shown:not(:focus)]:top-1/2",
  "peer-[:placeholder-shown:not(:focus)]:-translate-y-1/2",
)

const RESTS_AT_TOP = cn(
  "top-2.5",
  "peer-[:placeholder-shown:not(:focus)]:top-[1.125rem]",
)

/**
 * ⚠ THE TONES ARE THE STATE TOKENS, NOT NEW COLOURS. `--success`, `--warning`
 * and `--danger` already carry "went well / in progress / went wrong" in the
 * delivery tables, and a form that invented its own green would mean the same
 * thing twice in two colours. See the state-colour note in styles/tokens.css:
 * they are the only colour in a deliberately monochrome console, so spending
 * them here has to be for the same meaning.
 */
const TONES: Record<FieldState, { control: string; label: string; hint: string }> = {
  idle: {
    control: "border-input focus-within:border-ring focus-within:ring-ring/45",
    label: "text-muted-foreground peer-focus:text-foreground",
    hint: "text-muted-foreground",
  },
  pending: {
    control:
      "border-warning/60 focus-within:border-warning focus-within:ring-warning/25",
    label: "text-warning",
    hint: "text-warning",
  },
  invalid: {
    control: "border-danger/70 focus-within:border-danger focus-within:ring-danger/25",
    label: "text-danger",
    hint: "text-danger",
  },
  valid: {
    control:
      "border-success/60 focus-within:border-success focus-within:ring-success/25",
    label: "text-success",
    hint: "text-muted-foreground",
  },
}

const CONTROL = cn(
  "relative flex w-full items-center border bg-transparent",
  "transition-[color,border-color,box-shadow] duration-(--duration-instant) ease-(--ease-linear)",
  "focus-within:ring-[3px]",
  "has-[input:disabled]:opacity-55 has-[textarea:disabled]:opacity-55",
  "dark:bg-input/25",
)

const CONTROL_INPUT = cn(
  "peer h-full w-full min-w-0 bg-transparent px-4 pt-6 pb-2.5 text-sm outline-none",
  "selection:bg-primary selection:text-primary-foreground",
  "disabled:cursor-not-allowed",
  // ⚠ CHROME PAINTS AUTOFILLED FIELDS WITH ITS OWN YELLOW AND IGNORES
  // `background-color` TO DO IT. A 1000px inset shadow is the only thing that
  // covers that layer, and it would also cover the text — so the fill colour
  // has to be restored explicitly, or the field looks empty while holding a
  // value. Both halves are needed; neither works alone.
  "autofill:[-webkit-text-fill-color:var(--foreground)]",
  "autofill:[box-shadow:0_0_0_1000px_var(--background)_inset]",
)

/**
 * The shared frame: label, control, and a hint line that is always there.
 *
 * ⚠ THE HINT ROW RESERVES ITS HEIGHT WHETHER OR NOT THERE IS A HINT, AND THAT
 * IS THE WHOLE POINT OF IT BEING A ROW. A validation message that appears on
 * blur pushes every field below it down by twenty pixels — on a four-field form
 * the submit button moves under the cursor between the mousedown and the click.
 * Sixteen reserved pixels cost one line of vertical space and remove a class of
 * misclick that is invisible until somebody hits the wrong button.
 */
function Frame({
  id,
  hint,
  state,
  className,
  children,
}: {
  id: string
  hint?: React.ReactNode
  state: FieldState
  className?: string
  children: React.ReactNode
}) {
  const tone = TONES[state]

  return (
    <div className={cn("w-full", className)} data-slot="floating-field">
      {children}
      <div
        className={cn(
          "min-h-4 px-4 pt-1 text-2xs leading-4",
          "transition-colors duration-(--duration-instant) ease-(--ease-linear)",
          tone.hint,
        )}
        // ⚠ `polite`, AND ON THE ALWAYS-PRESENT ROW RATHER THAN ON THE MESSAGE.
        // A live region has to exist before the text arrives for a screen reader
        // to announce the change; one that is conditionally rendered is
        // announced inconsistently across readers, which is the usual reason
        // validation is silent for anyone not looking at it.
        aria-live="polite"
        id={`${id}-hint`}
      >
        {hint}
      </div>
    </div>
  )
}

export function FloatingInput({
  label,
  hint,
  state = "idle",
  className,
  controlClassName,
  containerClassName,
  adornment,
  id: providedId,
  ...props
}: Omit<React.ComponentProps<"input">, "placeholder"> & {
  label: string
  hint?: React.ReactNode
  state?: FieldState
  /**
   * Classes for the `<input>` itself — type, size, letter spacing.
   *
   * ⚠ `className` TARGETS THE INPUT RATHER THAN THE WRAPPER, WHICH IS THE
   * OPPOSITE OF WHAT THE MARKUP SUGGESTS AND THE RIGHT CHOICE ANYWAY. This
   * component replaced bare `<Input className="font-mono text-xs" />` call
   * sites, and every one of them means "set the type of the value". Routing
   * them to the bordered box instead loses `text-xs` silently — the input's own
   * `text-sm` wins over an inherited size — so an API key would render in the
   * proportional face with nothing to explain it.
   */
  className?: string
  /** Classes for the bordered box: height, radius, borders. */
  controlClassName?: string
  /** Classes for the whole field, including the hint row. */
  containerClassName?: string
  /** A button or icon pinned to the trailing edge — reveal, clear, spinner. */
  adornment?: React.ReactNode
}) {
  const generated = React.useId()
  const id = providedId ?? generated
  const tone = TONES[state]

  return (
    <Frame id={id} hint={hint} state={state} className={containerClassName}>
      <div className={cn(CONTROL, "h-14 rounded-pill", tone.control, controlClassName)}>
        <input
          id={id}
          data-slot="floating-input"
          // ⚠ SEE THE NOTE AT THE TOP: A SINGLE SPACE, ALWAYS.
          placeholder=" "
          aria-invalid={state === "invalid" || undefined}
          aria-describedby={hint ? `${id}-hint` : undefined}
          className={cn(CONTROL_INPUT, adornment && "pe-11", className)}
          {...props}
        />
        <label htmlFor={id} className={cn(FLOAT_LABEL, RESTS_CENTRED, tone.label)}>
          {label}
        </label>
        {adornment && (
          <div className="absolute end-3 flex items-center text-muted-foreground">
            {adornment}
          </div>
        )}
      </div>
    </Frame>
  )
}

export function FloatingTextarea({
  label,
  hint,
  state = "idle",
  className,
  controlClassName,
  containerClassName,
  rows = 4,
  id: providedId,
  ...props
}: Omit<React.ComponentProps<"textarea">, "placeholder"> & {
  label: string
  hint?: React.ReactNode
  state?: FieldState
  /** Classes for the `<textarea>` itself. See `FloatingInput`. */
  className?: string
  /** Classes for the bordered box. */
  controlClassName?: string
  containerClassName?: string
}) {
  const generated = React.useId()
  const id = providedId ?? generated
  const tone = TONES[state]

  return (
    <Frame id={id} hint={hint} state={state} className={containerClassName}>
      {/*
       * ⚠ `rounded-xl` RATHER THAN THE PILL THE INPUT USES, AND THE REASON IS
       * IN the pill token's own note: a stadium corner is height over two, so on
       * a box that grows with its content the corners swell as you type. The
       * textarea takes the largest corner on the fixed scale instead.
       */}
      <div className={cn(CONTROL, "rounded-xl", tone.control, controlClassName)}>
        <textarea
          id={id}
          rows={rows}
          placeholder=" "
          aria-invalid={state === "invalid" || undefined}
          aria-describedby={hint ? `${id}-hint` : undefined}
          // ⚠ `field-sizing-content` IS NOT SET HERE. It would make the box grow
          // as you type, which is pleasant — and it also makes the label's
          // resting position, which is vertically centred, drift down the box as
          // it grows. The label is only centred for the INPUT; here it rests one
          // line down from the top, so the height must not move under it.
          className={cn(CONTROL_INPUT, "h-auto resize-y py-2 pt-7", className)}
          {...props}
        />
        <label htmlFor={id} className={cn(FLOAT_LABEL, RESTS_AT_TOP, tone.label)}>
          {label}
        </label>
      </div>
    </Frame>
  )
}
