"use client"

import * as React from "react"
import { motion, type Transition } from "motion/react"
import { cn } from "cn"
import { mergeRefs, ResizeGrip } from "./resize-grip"

/**
 * An input whose label rises out of the field and sits on its top border.
 *
 * At rest the label sits where the value will be, at the value's size, so the
 * field reads as a single object rather than a caption stacked on a box. On
 * focus - or as soon as there is anything to show - it shrinks and moves onto
 * the top border, and its own background covers the line behind it.
 *
 * ⚠ THE BORDER IS COVERED, NOT CUT, AND THAT IS WHAT MAKES SAFARI AND CHROME
 * AGREE. This was a `<fieldset>`/`<legend>` notch for a long time, and the two
 * engines paint a legend into a rounded corner differently: Chrome cuts the gap
 * into the arc, WebKit leaves the arc whole and starts the gap where the line
 * turns straight, so the word sat in a different place on a Mac than on
 * everything else. A plain border with a patch of colour over it is drawn the
 * same way by every engine - it is how auth.openai.com does it.
 *
 * ⚠ AND THE PATCH HAS TO BE THE COLOUR OF WHATEVER THE FIELD SITS ON. That is
 * `--chip`, which a surface declares for itself - `Card` and `PopoverContent`
 * set it - and which falls back to `--background`. A field on a new surface
 * with its own fill needs that one variable on the surface, or the patch shows
 * as a dark slot over the border.
 *
 * ⚠ WHICH IS ALSO WHY THE BOX HAS NO FILL. It had `dark:bg-input/25` once, and
 * a patch can only match one colour: page-coloured, it showed as a dark slot in
 * the lighter box; split into a page-coloured top half and a clear bottom half,
 * the translucent fill showed through around the border and the line looked
 * washed out beside the word. Every text field is the page colour now - the
 * plain `Input`, `Textarea` and code boxes too, so they sit at the same depth.
 *
 * ⚠ THE WHOLE THING IS CSS. There is no `useState`, no `onFocus`, and no
 * `onChange` handler, which matters for more than tidiness: a React-driven
 * float cannot see the browser autofilling a password manager's saved email, so
 * the label would sit ON TOP of text the person can already read.
 * `:placeholder-shown` is evaluated by the browser against the live value and
 * gets autofill right for free. It also means this works uncontrolled, inside a
 * plain `<form>`, with no re-render per keystroke.
 *
 * ⚠ AND THAT IS WHY `placeholder=" "` IS FORCED AND NOT A PROP. The selectors
 * below key off `:placeholder-shown`, which is true only while the field is
 * empty AND a placeholder attribute exists. With no placeholder the pseudo-class
 * never matches and the label is stuck in the floated position over an empty
 * box; with a REAL placeholder the person sees two labels at once. A single
 * space is the established way to ask for the pseudo-class and render nothing.
 * Anything a caller would have put in `placeholder` belongs in `hint`.
 */

export type FieldState = "idle" | "pending" | "invalid" | "valid"

/*
 * ⚠ ONE SELECTOR FOR "FLOATED", AND IT IS POSITIVE: `:has(.peer:focus,
 * .peer:not(:placeholder-shown))`. Rest is the default and this overrides it,
 * so there is no pair of equal-specificity rules whose order decides the
 * winner.
 *
 * ⚠ AND NOT THE NEGATED FORM, `:has(.peer:placeholder-shown:not(:focus))`, WITH
 * FLOATED AS THE DEFAULT. That was tried and Safari got it wrong: switch to
 * another app and back, and WebKit re-evaluated the border's `:has(:focus)` but
 * not the negated rule, so the field showed a focused border around a label
 * sitting at rest. The positive form is the one auth.openai.com uses, and it
 * survives the switch.
 *
 * ⚠ AND IT IS REPEATED IN FULL ON EVERY LINE RATHER THAN BUILT FROM A CONSTANT.
 * Tailwind finds classes by scanning source text for complete literals, so a
 * template string is invisible to it and the variant is never generated - every
 * label in both apps once rendered stuck in the floated position that way.
 *
 * ⚠ `group-has-*`, NOT `peer-*`, ON THE LABEL'S INSIDES. `peer-*` compiles to a
 * following-sibling combinator, which the label itself satisfies but its
 * children do not; `:has()` on the control reaches all of them.
 */

/**
 * The bordered box. The border is the control's own, so it follows the corner
 * radius exactly, in every engine.
 *
 * ⚠ `--surface` IS WHAT THE FIELD SITS ON, resolved once here so the label and
 * the autofill cover read the same value.
 */
const CONTROL = cn(
  "group/field relative flex w-full items-center border bg-transparent",
  "[--surface:var(--chip,var(--background))]",
  "transition-[border-color] duration-(--duration-instant) ease-(--ease-linear)",
  "has-[input:disabled]:opacity-55 has-[textarea:disabled]:opacity-55",
)

/** Spans the control; only carries the colour, which the text inherits. */
const LABEL = cn(
  "pointer-events-none absolute inset-0 z-10",
  "transition-colors duration-(--duration-instant) ease-(--ease-linear)",
)

/*
 * ⚠ THE LABEL MOVES BY TRANSFORM ONLY. The row that holds it is centred where
 * the value sits and travels up by half its own height, which puts the word's
 * middle on the border whatever the control's height; the word shrinks with
 * `scale`, not `font-size`, so nothing reflows mid-flight and both engines
 * interpolate the same two numbers.
 *
 * ⚠ 100ms ON `--ease-quad-out`: non-zero velocity at t=0, so the answer is
 * immediate, and only a gentle deceleration, so the duration is spent
 * travelling rather than settling. `quint-out` was over inside a frame, and
 * every ease-in tried read as a pause before the click registered.
 */
const LABEL_ROW = cn(
  "absolute inset-x-0 flex items-center px-6",
  "group-has-[.peer:focus,.peer:not(:placeholder-shown)]/field:-translate-y-1/2",
  "transition-transform duration-(--duration-instant) ease-(--ease-quad-out)",
)

/**
 * ⚠ THE RESTING POSITION DIFFERS BY CONTROL AND CANNOT BE SHARED. On the input
 * the label rests where the value will be, which is the vertical centre of the
 * box. On a textarea the value starts at the TOP of a box several rows tall, so
 * the row is one input-height tall and pinned to the top - centring it would
 * park the label in the middle of the writing area.
 */
const RESTS_CENTRED = "inset-y-0"
const RESTS_AT_TOP = "top-0 h-14"

/*
 * ⚠ THE GEOMETRY IS ONE NUMBER: 24px. The row's `px-6` plus the text's `px-1`
 * less its `-translate-x-1` puts the glyphs at 24, which is where the value
 * starts (`px-6` on the input) and where the hint starts. The label does not
 * move sideways as it rises; only the row's `translate` and the text's `scale`
 * change. `origin-left` keeps the first letter where it was as the word shrinks.
 *
 * ⚠ 0.875 IS 14/16: the floated label is the 14px the console uses for labels,
 * scaled from the 16px value it rests as.
 *
 * ⚠ THE PATCH IS SOLID AND ALWAYS THERE. At rest it is the page colour on a
 * box that is the page colour, so it cannot be seen; floated, it is what hides
 * the border behind the word. Nothing about it changes, so nothing can flash.
 */
const LABEL_TEXT = cn(
  "max-w-full origin-left -translate-x-1 truncate px-1 py-px text-base leading-none",
  "bg-(--surface)",
  "group-has-[.peer:focus,.peer:not(:placeholder-shown)]/field:scale-[0.875]",
  "transition-[translate,scale] duration-(--duration-instant) ease-(--ease-quad-out)",
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
 * mode and grey to near-black in light - see the `--ring` note in
 * styles/tokens.css for why the 3px translucent halo shadcn ships was the wrong
 * signal on this surface.
 *
 * ⚠ AND THE STATE TONES DO NOT REVERT TO `--ring` ON FOCUS. A field that is
 * showing an error has to keep showing it while somebody types the correction
 * into it - a red border that turns white the moment the caret lands removes
 * the message exactly when it is being acted on.
 */
/*
 * ⚠ AN IDLE FIELD INSIDE A FORM THAT HAS JUST WORKED GOES GREEN, AND THE FORM
 * SAYS SO RATHER THAN EACH FIELD. `data-outcome="done"` on any ancestor - the
 * console's forms set it from the same state that puts the tick in their submit
 * button - reaches every field below it through Tailwind's `in-*` variant, so a
 * dialog with four boxes confirms all four without one prop threaded to each.
 * It is the language Clerk's code field speaks: the boxes you filled in are the
 * thing that turns green, and the word under them is the thing that says why.
 *
 * ⚠ `!` BECAUSE `in-*` COMPILES TO `:where()`, WHICH HAS NO SPECIFICITY. The
 * field is very often still focused when the answer lands - Enter submits
 * without blurring - and `has-[.peer:focus]:border-ring` would win, leaving the one box
 * the person is looking at as the one that did not change.
 *
 * ⚠ ONLY A FIELD THAT WAS FILLED IN. An optional box left empty took no part
 * in what just worked, and a green outline round nothing reads as the form
 * claiming an answer nobody gave. `:placeholder-shown` is how this markup
 * already tells empty from filled.
 *
 * ⚠ ONLY ON `idle`. A field showing a verdict of its own keeps it; a form cannot
 * have succeeded with a red field in it, and a warning tone means something is
 * still in flight.
 */
const TONES: Record<FieldState, { frame: string; label: string; hint: string }> = {
  idle: {
    frame:
      "border-input has-[.peer:focus]:border-ring in-data-[outcome=done]:has-[.peer:not(:placeholder-shown)]:border-success!",
    label:
      "text-muted-foreground peer-focus:text-foreground in-data-[outcome=done]:peer-[:not(:placeholder-shown)]:text-success!",
    hint: "text-muted-foreground",
  },
  pending: {
    frame: "border-warning/60 has-[.peer:focus]:border-warning",
    label: "text-warning",
    hint: "text-warning",
  },
  invalid: {
    frame: "border-danger/70 has-[.peer:focus]:border-danger",
    label: "text-danger",
    hint: "text-danger",
  },
  valid: {
    frame: "border-success/60 has-[.peer:focus]:border-success",
    label: "text-success",
    hint: "text-muted-foreground",
  },
}

/**
 * The colour a validation message takes for a given state.
 *
 * ⚠ EXPORTED SO THE CODE FIELD DOES NOT PICK ITS OWN RED. `input-otp` draws
 * nothing like this component - no peer, no floating label, no frame - but the
 * sentence under it means exactly what the sentence under an email box means,
 * and two files each choosing `text-danger` is how the two drift apart the
 * first time one of them is adjusted. Only the hint half is shared: the frame
 * classes are written against a `.peer` input that exists in this
 * markup and nowhere else.
 */
export const fieldHintTone = (state: FieldState): string => TONES[state].hint

const CONTROL_INPUT = cn(
  /*
   * ⚠ 16px, WHICH IS ALSO THE ONLY SIZE iOS WILL NOT ZOOM INTO. Safari on
   * iPhone magnifies the whole page when a focused input's text is under 16px
   * and does not zoom back out afterwards, so a 14px field costs a pinch on
   * every sign-in. The console's 14px base is a density decision for tables;
   * a field somebody types their password into is not a table.
   */
  // ⚠ `px-6` IS 24px, WHICH IS WHERE THE RESTING LABEL'S GLYPHS ARE. See the
  // sum in LABEL - if the LEADING value disagrees, the label jumps sideways as
  // it rises, and the jump is at the instant somebody types their first
  // character, which is the worst possible moment to move the thing they are
  // reading.
  //
  // ⚠ AND THE TRAILING VALUE MATCHES IT RATHER THAN STAYING AT THE 16px A
  // SQUARE INPUT WOULD USE. Whatever the leading side costs, the other side
  // pays too; a long value with 24px on the left and 16 on the right sits
  // visibly off-centre in its own box.
  "peer h-full w-full min-w-0 bg-transparent px-6 text-base outline-none",
  "selection:bg-primary selection:text-primary-foreground",
  "disabled:cursor-not-allowed",
  // ⚠ CHROME PAINTS AUTOFILLED FIELDS WITH ITS OWN YELLOW AND IGNORES
  // `background-color` TO DO IT. A 1000px inset shadow is the only thing that
  // covers that layer, and it would also cover the text - so the fill colour
  // has to be restored explicitly, or the field looks empty while holding a
  // value. Both halves are needed; neither works alone.
  "autofill:[-webkit-text-fill-color:var(--foreground)]",
  "autofill:[box-shadow:0_0_0_1000px_var(--surface)_inset]",
)

/**
 * The shared frame: the control, and the line underneath it.
 *
 * ⚠ THERE ARE TWO KINDS OF LINE UNDER A FIELD AND THEY WANT OPPOSITE LAYOUTS,
 * WHICH IS WHY `reserveHint` EXISTS RATHER THAN ONE BEHAVIOUR FOR BOTH.
 *
 *   DESCRIPTION - "Must be HTTPS and publicly reachable", "e.g. production-api".
 *   Always there, often two lines, and part of what the field IS. It belongs in
 *   the flow: it is content, and the form should be as tall as its content.
 *
 *   VALIDATION - "That does not look like an email address". Absent most of the
 *   time and present for a few seconds. Putting it in the flow means every
 *   field permanently carries a strip of empty space against the moment it
 *   might have something to say, and a sign-up form pays for four of those.
 *
 * ⚠ RESERVING IS STILL THE DEFAULT, AND THAT IS NOT TIMIDITY. Nineteen call
 * sites across the console pass a description, several of which wrap to two
 * lines at dialog width - overlaying those would put a second line of text on
 * top of the next field. The caller that knows its hint is transient and short
 * is the caller that can say so.
 *
 * ⚠ WHEN IT DOES OVERLAY, IT LANDS IN SPACE THAT ALREADY EXISTS. `FieldGroup`
 * separates fields by `gap-7`, which is 28px; the line is 16px on a 6px offset,
 * so it sits inside that gap with six pixels to spare and the field's own
 * height is just the control. Nothing is reserved, so nothing can be pushed.
 */
function Frame({
  id,
  hint,
  state,
  reserveHint,
  className,
  children,
}: {
  id: string
  hint?: React.ReactNode
  state: FieldState
  reserveHint: boolean
  className?: string
  children: React.ReactNode
}) {
  const row = React.useRef<HTMLDivElement>(null)
  const height = useHeight(row)

  /*
   * ⚠ THE ROW'S HEIGHT IS ANIMATED, NOT ITS CONTENT, AND THAT IS WHAT STOPS THE
   * JUMP. A message that wraps to a second line used to add sixteen pixels in
   * one frame and shove every field and button under it down by sixteen in the
   * same frame; fixing the value took them back up just as abruptly. The row is
   * measured, and the box around it springs to that height - so what is below
   * it slides, both ways, whatever the message says.
   *
   * ⚠ IN OVERLAY MODE ONLY THE OVERFLOW IS PAID FOR. One line still hangs in
   * the gap below the field and costs nothing; a second line is what would
   * land on top of the next field, so exactly that much is pushed - on the
   * same spring.
   */
  const push = height === null ? 0 : Math.max(0, height - ONE_LINE)

  const hintRow = (
    <div
      ref={row}
      className={cn(
        // ⚠ `px-6` MATCHES THE VALUE'S OWN INSET, so a validation message
        // starts under the first character of what it is about. It moves with
        // `CONTROL_INPUT`'s padding and has no independent opinion.
        "px-6 pt-1.5 text-2xs leading-4",
        "transition-colors duration-(--duration-instant) ease-(--ease-linear)",
        /*
         * ⚠ `min-h-4` IS THE RESERVATION, AND IT IS THE WHOLE POINT OF THE
         * FLOW VERSION. A message that appears on blur without it pushes every
         * field below it down by twenty pixels - on a four-field form the
         * submit button moves under the cursor between the mousedown and the
         * click. Sixteen reserved pixels remove a class of misclick that is
         * invisible until somebody hits the wrong button.
         */
        reserveHint
          ? "min-h-4"
          : /*
             * ⚠ `pointer-events-none` BECAUSE IT NOW HANGS OVER SOMETHING
             * ELSE. Out of flow, this strip sits in the gap above whatever
             * comes next - on the last field of a form, that is the submit
             * button. An invisible 22px band across it would swallow clicks
             * along its top edge, which is the kind of defect nobody reports
             * because it only bites near one border.
             */
            "pointer-events-none absolute inset-x-0 top-full",
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
  )

  return (
    <div className={cn("w-full", className)} data-slot="floating-field">
      {reserveHint ? (
        <>
          {children}
          <motion.div
            className="overflow-hidden"
            initial={false}
            animate={{ height: height ?? "auto" }}
            transition={GROW}
          >
            {hintRow}
          </motion.div>
        </>
      ) : (
        <>
          {/* ⚠ THE ROW ANCHORS TO THE CONTROL, NOT TO THE WHOLE FIELD - the
              whole field now includes the spacer below, and `top-full` of that
              would move the message down by exactly the push. */}
          <div className="relative">
            {children}
            {hintRow}
          </div>
          <motion.div initial={false} animate={{ height: push }} transition={GROW} />
        </>
      )}
    </div>
  )
}

/**
 * `autoFocus` that also works on a page the server rendered.
 *
 * ⚠ REACT DOES NOT FOCUS AN `autoFocus` INPUT IT HYDRATES - only one it
 * creates. So a one-field page reached by a client navigation had the caret,
 * and the same page opened fresh or reloaded did not: `/domains/new` came up
 * with focus on the body. This focuses it once hydrated, and only when nothing
 * else has focus, so it never takes the caret from somebody already typing
 * elsewhere, and does nothing where React has already focused it.
 */
function useHydratedAutoFocus(id: string, autoFocus: boolean | undefined) {
  React.useEffect(() => {
    if (!autoFocus) return
    const active = document.activeElement
    if (active && active !== document.body) return
    document.getElementById(id)?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on mount only, like the attribute
  }, [])
}

/** `pt-1.5` plus one `leading-4` line: what a one-line hint row measures. */
const ONE_LINE = 22

/** The spring `Reveal` and `StepStage` use, so the row moves like everything else. */
const GROW: Transition = { type: "spring", stiffness: 420, damping: 38, mass: 1 }

/**
 * The element's rendered height, kept current as its content wraps and unwraps.
 *
 * ⚠ `null` UNTIL FIRST MEASURED, which the caller reads as "auto" - so the
 * server render and the first client paint lay out naturally, and nothing
 * animates on mount.
 */
function useHeight(ref: React.RefObject<HTMLElement | null>): number | null {
  const [height, setHeight] = React.useState<number | null>(null)
  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => setHeight(el.offsetHeight))
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
  return height
}

/**
 * The label, in the three layers the float needs: the coloured box over the
 * control, the row that moves up, and the text that shrinks and carries the
 * patch over the border.
 */
function FloatingLabel({
  id,
  label,
  rest,
  className,
}: {
  id: string
  label: string
  rest: string
  className: string
}) {
  return (
    <label htmlFor={id} className={cn(LABEL, className)}>
      <span className={cn(LABEL_ROW, rest)}>
        <span className={LABEL_TEXT}>{label}</span>
      </span>
    </label>
  )
}

export function FloatingInput({
  label,
  hint,
  state = "idle",
  reserveHint = true,
  className,
  controlClassName,
  containerClassName,
  adornment,
  underlay,
  id: providedId,
  ...props
}: Omit<React.ComponentProps<"input">, "placeholder"> & {
  label: string
  hint?: React.ReactNode
  state?: FieldState
  /**
   * Keep a permanent row for the hint, or draw it into the gap below.
   *
   * ⚠ `true` FOR A DESCRIPTION, `false` FOR A VALIDATION MESSAGE. See `Frame`:
   * a line that is always there is content and belongs in the flow; a line that
   * appears for a few seconds should not make every field taller for ever.
   */
  reserveHint?: boolean
  /**
   * Classes for the `<input>` itself - type, size, letter spacing.
   *
   * ⚠ `className` TARGETS THE INPUT RATHER THAN THE WRAPPER, WHICH IS THE
   * OPPOSITE OF WHAT THE MARKUP SUGGESTS AND THE RIGHT CHOICE ANYWAY. This
   * component replaced bare `<Input className="font-mono text-xs" />` call
   * sites, and every one of them means "set the type of the value". Routing them
   * to the bordered box instead loses `text-xs` silently - the input's own
   * `text-sm` wins over an inherited size - so an API key would render in the
   * proportional face with nothing to explain it.
   */
  className?: string
  /** Classes for the bordered box: height, radius. */
  controlClassName?: string
  /** Classes for the whole field, including the hint row. */
  containerClassName?: string
  /** A button or icon pinned to the trailing edge - reveal, clear, spinner. */
  adornment?: React.ReactNode
  /**
   * Drawn in the control, level with the value - the email box's ghost text.
   *
   * ⚠ BEFORE THE INPUT IN THE DOM, unlike the label and the adornment, because
   * the `peer-*` rules only look at FOLLOWING siblings; nothing reads this one.
   * It is positioned, so it still paints over the transparent input, and it
   * must be `pointer-events-none` wherever it is not itself a target.
   */
  underlay?: React.ReactNode
}) {
  const generated = React.useId()
  const id = providedId ?? generated
  const tone = TONES[state]
  useHydratedAutoFocus(id, props.autoFocus)

  return (
    <Frame
      id={id}
      hint={hint}
      state={state}
      reserveHint={reserveHint}
      className={containerClassName}
    >
      <div className={cn(CONTROL, tone.frame, "h-14 rounded-pill", controlClassName)}>
        {underlay}
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
        <FloatingLabel
          id={id}
          label={label}
          rest={RESTS_CENTRED}
          className={tone.label}
        />
        {adornment && (
          // ⚠ `end-6` IS THE SAME 24px THE VALUE IS INSET BY, so the reveal
          // icon lines up with the right-hand edge of the text rather than
          // hanging out over the corner arc. `pe-14` on the input clears its
          // width: the button is 36px wide and carries `-me-1`, so its leading
          // edge lands at exactly 56px from the right.
          <div className="absolute end-6 z-10 flex items-center text-muted-foreground">
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
  reserveHint = true,
  className,
  controlClassName,
  containerClassName,
  rows = 4,
  id: providedId,
  ref,
  ...props
}: Omit<React.ComponentProps<"textarea">, "placeholder"> & {
  label: string
  hint?: React.ReactNode
  state?: FieldState
  /** See `FloatingInput`. */
  reserveHint?: boolean
  /** Classes for the `<textarea>` itself. See `FloatingInput`. */
  className?: string
  /** Classes for the bordered box. */
  controlClassName?: string
  containerClassName?: string
}) {
  const generated = React.useId()
  const id = providedId ?? generated
  const tone = TONES[state]
  const own = React.useRef<HTMLTextAreaElement>(null)

  return (
    <Frame
      id={id}
      hint={hint}
      state={state}
      reserveHint={reserveHint}
      className={containerClassName}
    >
      {/*
       * ⚠ `rounded-xl` RATHER THAN THE PILL THE INPUT USES, and the reason is in
       * the pill token's own note: a stadium corner is height over two, so on a
       * box that grows with its content the corners swell as you type. The
       * textarea takes the largest corner on the fixed scale instead.
       */}
      <div className={cn(CONTROL, tone.frame, "rounded-xl", controlClassName)}>
        <textarea
          ref={mergeRefs(own, ref)}
          id={id}
          rows={rows}
          placeholder=" "
          aria-invalid={state === "invalid" || undefined}
          aria-describedby={hint ? `${id}-hint` : undefined}
          // ⚠ `field-sizing-content` IS NOT SET HERE. The height is the
          // person's, set with the grip; a box that also grew as they typed
          // would undo what they just dragged it to.
          /*
           * ⚠ A FLOOR AND A CEILING, BOTH IN WHOLE LINES. `min-h-20` is the
           * `py-4` padding plus two 24px lines: one fewer and the caret sits on
           * the bottom border, and the resting label - which is placed one line
           * from the top - drops out of the box. `max-h-80` is the padding plus
           * eleven lines; past that the text scrolls rather than the page
           * growing a box nobody can see the end of.
           */
          className={cn(
            CONTROL_INPUT,
            "h-auto min-h-20 max-h-80 resize-none py-4",
            className,
          )}
          {...props}
        />
        <FloatingLabel
          id={id}
          label={label}
          rest={RESTS_AT_TOP}
          className={tone.label}
        />
        <ResizeGrip targetRef={own} />
      </div>
    </Frame>
  )
}
