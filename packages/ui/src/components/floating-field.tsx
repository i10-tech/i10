"use client"

import * as React from "react"
import { cn } from "cn"

/**
 * An input whose label rises out of the field and sits in a notch cut into its
 * own border.
 *
 * At rest the label sits where the value will be, at the value's size, so the
 * field reads as a single object rather than a caption stacked on a box. On
 * focus — or as soon as there is anything to show — it shrinks and moves onto
 * the top border, which opens a gap around it.
 *
 * ⚠ THE NOTCH IS A REAL `<fieldset>`/`<legend>`, NOT A LABEL WITH A BACKGROUND
 * BEHIND IT, AND THE ALTERNATIVE IS WHY. The obvious trick is to paint a strip
 * of the page colour behind the label so it appears to interrupt the border —
 * and it works right up until the field is inside something that is not the
 * page. This console puts inputs on `--background`, on `--card` and on
 * `--popover`, which are three different colours in dark mode, so the chip
 * would be visibly wrong in a dialog and in every card. A legend removes the
 * border rather than covering it, so it is correct on any surface, including
 * ones added later.
 *
 * ⚠ THE WHOLE THING IS CSS. There is no `useState`, no `onFocus`, and no
 * `onChange` handler, which matters for more than tidiness: a React-driven
 * float cannot see the browser autofilling a password manager's saved email, so
 * the label would sit ON TOP of text the person can already read.
 * `:placeholder-shown` is evaluated by the browser against the live value and
 * gets autofill right for free. It also means this works uncontrolled, inside a
 * plain `<form>`, with no re-render per keystroke.
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
 * happens to emit them in. `:placeholder-shown:not(:focus)` is a single
 * selector that is simply true or false, and cannot be reordered.
 *
 * ⚠ AND IT IS REPEATED IN FULL ON EVERY LINE RATHER THAN BUILT FROM A CONSTANT.
 * It was written as `` `${RESTING}top-1/2` `` first, and every label in both
 * apps rendered stuck in the floated position over an empty box: Tailwind finds
 * classes by scanning source text for complete literals, so a template string is
 * invisible to it and the variant was never generated. The repetition is not
 * stylistic — it is the only form the compiler can see.
 */
/*
 * ⚠ THE HORIZONTAL GEOMETRY IS ARITHMETIC, NOT TASTE, AND GETTING IT WRONG EATS
 * THE CORNER OF THE BORDER. Four numbers have to agree:
 *
 *     control radius        28px   `rounded-pill` on `h-14` is height / 2
 *     legend box starts at  28px   fieldset border (1) + legend `ms-[27px]`
 *     label box starts at   28px   `start-7`
 *     glyphs start at       32px   both carry `px-1`, so the gap is 4px
 *                                  wider than the word on EACH side
 *     value inset           32px   `px-8`, BOTH sides
 *
 * The first line is the constraint. A stadium's top border is only horizontal
 * from x = radius onward — before that it is the corner arc — so a notch that
 * opens at 16px, which is where this started, deletes the arc instead of
 * interrupting a straight line. On screen that is a field whose top-left corner
 * is simply missing, with the label hanging off the end of it.
 *
 * ⚠ AND THE LABEL AND THE LEGEND USED TO BE 4px OUT OF STEP, which is the other
 * half of the same screenshot. The label sat at `start-3` (12) and the legend at
 * `ms-2` (16), so the gap opened four pixels to the RIGHT of the word: no
 * clearance before the first letter, double after the last. They are written as
 * one sum now so the next person changing either has to change both.
 *
 * ⚠ SO THE VALUE IS PADDED TO 32px TOO, which is what keeps the resting label
 * sitting exactly where the text it names will appear. That is the whole
 * illusion — the label does not move sideways when it rises, it only goes up
 * and gets smaller.
 */
const LABEL = cn(
  "pointer-events-none absolute start-7 z-10 truncate px-1",
  // ⚠ 14px FLOATED AGAINST A 16px VALUE, AND `leading-none` IS THE HALF THAT
  // FIXES THE ALIGNMENT. Tailwind pairs `text-sm` with a 20px line height, so
  // the label's BOX is 20px tall while the gap in the border is 14 — centre the
  // box on the border and six pixels of it stick out above the notch, which is
  // exactly the "too much on the top" the field was showing. `leading-none`
  // collapses the box onto the glyphs so the thing being centred is the text.
  "max-w-[calc(100%-3.5rem)] text-sm leading-none font-medium",
  // ⚠ ONLY `top` AND `font-size` MOVE. The label keeps `-translate-y-1/2` in
  // both states, so the animation is a single property travelling from the
  // middle of the box to its top edge — no transform to interpolate, and
  // nothing to land half a pixel off at the end.
  "-translate-y-1/2 transition-[top,font-size,color]",
  "duration-(--duration-instant) ease-(--ease-quint-out)",
  "peer-[:placeholder-shown:not(:focus)]:text-base",
  "peer-[:placeholder-shown:not(:focus)]:font-normal",
)

/**
 * ⚠ THE RESTING POSITION DIFFERS BY CONTROL AND CANNOT BE SHARED. On the input
 * the label rests where the value will be, which is the vertical centre of a
 * fixed box. On a textarea the value starts at the TOP of a box several rows
 * tall, so centring the label would park it in the middle of the writing area —
 * the caret would be two lines above the thing naming the field.
 */
const RESTS_CENTRED = cn("top-0", "peer-[:placeholder-shown:not(:focus)]:top-1/2")
const RESTS_AT_TOP = cn("top-0", "peer-[:placeholder-shown:not(:focus)]:top-7")

/**
 * The bordered box, drawn as a fieldset so the legend can cut the notch.
 *
 * ⚠ `-top-[7px]` IS HALF THE LEGEND'S HEIGHT, AND IT IS NOT OPTIONAL. A
 * fieldset does not paint its block-start border at its border-box edge: the
 * legend is laid out THROUGH that border, and the browser drops the border line
 * to the legend's vertical middle. So a fieldset at `inset-0` reports
 * `getBoundingClientRect().top === 0` while its visible line is drawn seven
 * pixels lower — and the label, centred on the box's real top edge, floats
 * clearly above the border instead of sitting in it.
 *
 * This was removed once on the reasoning that Material's own -5px was a magic
 * number. It is not magic; it is `legend height / 2`, and Material's legend is
 * 11px where ours is 14. Pulling the frame up by that much puts the painted
 * line back on the control's top edge, which is where the label already is.
 *
 * ⚠ THE NOTCH RULE LIVES HERE, ON THE FIELDSET, AND NOT ON THE LEGEND. Tailwind
 * compiles `peer-*` to a FOLLOWING-SIBLING combinator, `.peer ~ &`. The legend
 * is a CHILD of this element, not a sibling of the input, so the same variant
 * written on the legend matched nothing at all and the gap stayed open on every
 * empty, unfocused field — visible as a break in the border with no label in
 * it. Written here it compiles to `.peer… ~ fieldset > legend`, which is the
 * relationship that actually exists.
 */
const FRAME = cn(
  // ⚠ NO HORIZONTAL PADDING. The fieldset's only child is the legend, so its
  // padding does nothing except push the notch sideways — and it was doing
  // exactly that, by 8px, which is half of why the gap and the label were out
  // of step. The legend's own margin is now the single number that places it.
  "pointer-events-none absolute inset-0 -top-[7px]",
  "rounded-[inherit] border text-start",
  "transition-[color,border-color] duration-(--duration-instant) ease-(--ease-linear)",
  "peer-[:placeholder-shown:not(:focus)]:[&>legend]:max-w-[0.01px]",
)

/**
 * ⚠ `max-width`, NOT `width`, IS WHAT ANIMATES — and the closed value is
 * `0.01px` rather than `0`. A legend of zero width is dropped from layout by
 * some engines, which snaps the notch shut with no transition at all; a
 * hundredth of a pixel is indistinguishable and keeps the box alive.
 *
 * ⚠ `invisible` RATHER THAN `sr-only` OR `hidden`. The legend has to OCCUPY its
 * width — that width is the notch — while painting nothing, which is precisely
 * what `visibility: hidden` does. It also keeps the duplicated label text out of
 * the accessibility tree, so a screen reader does not read the field's name
 * twice.
 */
const LEGEND = cn(
  // ⚠ THE SIZE AND HEIGHT TRACK `LABEL` ABOVE AND CANNOT DRIFT FROM IT. This
  // measures the gap; if it is a point smaller than the word going into it the
  // border clips the last character, if it is larger there is a visible slot of
  // missing border after it, and if it is SHORTER than the label's line box the
  // label rides up out of the gap.
  // ⚠ `ms-[27px]` IS THE LABEL'S 28px LESS THE FIELDSET'S OWN 1px BORDER, which
  // a legend is laid out INSIDE. Measured, not derived: with `ms-5` the gap
  // opened at 29px against a label at 28, and the border clipped the first
  // letter by a pixel on every field in the product.
  "invisible ms-[27px] block h-[14px] w-auto max-w-full overflow-hidden p-0",
  "text-sm leading-none font-medium whitespace-nowrap",
  "transition-[max-width] duration-(--duration-instant) ease-(--ease-quint-out)",
)

/**
 * ⚠ THE TONES ARE THE STATE TOKENS, NOT NEW COLOURS. `--success`, `--warning`
 * and `--danger` already carry "went well / in progress / went wrong" in the
 * delivery tables, and a form that invented its own green would mean the same
 * thing twice in two colours. See the state-colour note in styles/tokens.css:
 * they are the only colour in a deliberately monochrome console, so spending
 * them here has to be for the same meaning.
 */
/**
 * ⚠ FOCUS IS THE BORDER GOING FULL STRENGTH, AND NOTHING ELSE IS PAINTED. Each
 * tone is the same colour twice: muted at rest, solid on focus. `--ring` is now
 * `--foreground`, so an idle field goes from grey hairline to white line in dark
 * mode and grey to near-black in light — see the `--ring` note in
 * styles/tokens.css for why the 3px translucent halo shadcn ships was the wrong
 * signal on this surface.
 *
 * ⚠ AND THE STATE TONES DO NOT REVERT TO `--ring` ON FOCUS. A field that is
 * showing an error has to keep showing it while somebody types the correction
 * into it — a red border that turns white the moment the caret lands removes
 * the message exactly when it is being acted on.
 */
const TONES: Record<FieldState, { frame: string; label: string; hint: string }> = {
  idle: {
    frame: "border-input peer-focus:border-ring",
    label: "text-muted-foreground peer-focus:text-foreground",
    hint: "text-muted-foreground",
  },
  pending: {
    frame: "border-warning/60 peer-focus:border-warning",
    label: "text-warning",
    hint: "text-warning",
  },
  invalid: {
    frame: "border-danger/70 peer-focus:border-danger",
    label: "text-danger",
    hint: "text-danger",
  },
  valid: {
    frame: "border-success/60 peer-focus:border-success",
    label: "text-success",
    hint: "text-muted-foreground",
  },
}

const CONTROL = cn(
  "relative flex w-full items-center bg-transparent",
  "has-[input:disabled]:opacity-55 has-[textarea:disabled]:opacity-55",
  "dark:bg-input/25",
)

const CONTROL_INPUT = cn(
  /*
   * ⚠ 16px, WHICH IS ALSO THE ONLY SIZE iOS WILL NOT ZOOM INTO. Safari on
   * iPhone magnifies the whole page when a focused input's text is under 16px
   * and does not zoom back out afterwards, so a 14px field costs a pinch on
   * every sign-in. The console's 14px base is a density decision for tables;
   * a field somebody types their password into is not a table.
   */
  // ⚠ `px-8` IS 32px, WHICH IS WHERE THE RESTING LABEL'S GLYPHS ARE. See the
  // sum in LABEL — if the LEADING value disagrees, the label jumps sideways as
  // it rises.
  //
  // ⚠ AND THE TRAILING VALUE MATCHES IT RATHER THAN STAYING AT THE 16px A
  // SQUARE INPUT WOULD USE. The leading inset is not a taste decision here — it
  // is forced to 32px by the corner arc the notch has to clear — so leaving the
  // other side at 16 makes a long value sit visibly off-centre in its own box,
  // closer to the right edge than the left. Whatever the notch costs on one
  // side, the other side pays too.
  "peer h-full w-full min-w-0 bg-transparent px-8 text-base outline-none",
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
 * The shared frame: control, and a hint line that is always there.
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
  return (
    <div className={cn("w-full", className)} data-slot="floating-field">
      {children}
      <div
        className={cn(
          // ⚠ `px-8` MATCHES THE VALUE'S OWN INSET, so a validation message
          // starts under the first character of what it is about.
          "min-h-4 px-8 pt-1.5 text-2xs leading-4",
          "transition-colors duration-(--duration-instant) ease-(--ease-linear)",
          TONES[state].hint,
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

/**
 * ⚠ THE NOTCH TEXT IS THE LABEL AGAIN, AND THE DUPLICATION IS LOAD-BEARING. The
 * legend is what reserves the gap, and a gap has to be exactly as wide as the
 * word sitting in it — so it has to contain the same string at the same size. It
 * is `invisible`, so nothing is painted twice and nothing is announced twice;
 * only the measurement is shared.
 */
function Notch({ label, className }: { label: string; className: string }) {
  return (
    <fieldset aria-hidden className={className}>
      <legend className={LEGEND}>
        <span className="inline-block px-1">{label}</span>
      </legend>
    </fieldset>
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
   * sites, and every one of them means "set the type of the value". Routing them
   * to the bordered box instead loses `text-xs` silently — the input's own
   * `text-sm` wins over an inherited size — so an API key would render in the
   * proportional face with nothing to explain it.
   */
  className?: string
  /** Classes for the bordered box: height, radius. */
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
      <div className={cn(CONTROL, "h-14 rounded-pill", controlClassName)}>
        <input
          id={id}
          data-slot="floating-input"
          // ⚠ SEE THE NOTE AT THE TOP: A SINGLE SPACE, ALWAYS.
          placeholder=" "
          aria-invalid={state === "invalid" || undefined}
          aria-describedby={hint ? `${id}-hint` : undefined}
          className={cn(CONTROL_INPUT, adornment && "pe-14", className)}
          {...props}
        />
        <label htmlFor={id} className={cn(LABEL, RESTS_CENTRED, tone.label)}>
          {label}
        </label>
        {/*
         * ⚠ AFTER THE INPUT IN THE DOM, WHICH IS NOT COSMETIC. Every `peer-*`
         * rule on the frame and the legend compiles to `.peer … ~ &` — a
         * FOLLOWING-sibling combinator. Moving the notch above the input would
         * leave the border with no focus state and the gap permanently shut, and
         * nothing would report it.
         */}
        <Notch label={label} className={cn(FRAME, tone.frame)} />
        {adornment && (
          // ⚠ `end-8` IS THE SAME 32px THE VALUE IS INSET BY, so the reveal
          // icon lines up with the right-hand edge of the text rather than
          // hanging out over the corner arc. `pe-14` below clears its width.
          <div className="absolute end-8 z-10 flex items-center text-muted-foreground">
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
       * ⚠ `rounded-xl` RATHER THAN THE PILL THE INPUT USES, and the reason is in
       * the pill token's own note: a stadium corner is height over two, so on a
       * box that grows with its content the corners swell as you type. The
       * textarea takes the largest corner on the fixed scale instead.
       */}
      <div className={cn(CONTROL, "rounded-xl", controlClassName)}>
        <textarea
          id={id}
          rows={rows}
          placeholder=" "
          aria-invalid={state === "invalid" || undefined}
          aria-describedby={hint ? `${id}-hint` : undefined}
          // ⚠ `field-sizing-content` IS NOT SET HERE. It would make the box grow
          // as you type, which is pleasant — and it also makes the label's
          // resting position drift down the box as it grows. The label rests one
          // line from the top, so the height must not move under it.
          className={cn(CONTROL_INPUT, "h-auto resize-y py-4", className)}
          {...props}
        />
        <label htmlFor={id} className={cn(LABEL, RESTS_AT_TOP, tone.label)}>
          {label}
        </label>
        <Notch label={label} className={cn(FRAME, tone.frame)} />
      </div>
    </Frame>
  )
}
