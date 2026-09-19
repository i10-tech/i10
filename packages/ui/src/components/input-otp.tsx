"use client"

import * as React from "react"
import { cn } from "cn"
import { OTPInput, OTPInputContext } from "input-otp"
import { MinusIcon } from "lucide-react"
import type { FieldState } from "./floating-field"

/**
 * The six-box code entry, drawn like the rest of our fields.
 *
 * ⚠ IT ARRIVED AS SHADCN'S DEFAULT AND LOOKED LIKE IT: nine-by-nine boxes fused
 * into one strip by shared borders, `rounded-md` corners and a 14px digit. Every
 * other field in the product is a 56px pill with a floating label, so the one
 * screen that asks for a code was visibly from a different product — and it is
 * not a rare screen, it is on the path of every sign-up, every password reset
 * and every second factor.
 *
 * ⚠ SO THE BOXES ARE SEPARATE, NOT FUSED. A single strip is one control that
 * happens to have gridlines; six boxes are six digits, which is what the person
 * is actually being asked for and what they are counting off a notification. It
 * also means the active box can carry a full border on every side rather than
 * borrowing its neighbour's.
 *
 * ⚠ AND IT SPEAKS THE SAME `FieldState` AS EVERY OTHER FIELD. A wrong code is
 * the most ordinary failure in the product, and it used to be reported only by
 * a toast that slid away — leaving six boxes looking exactly as they had
 * before. `invalid` paints the same red the email box uses; `valid` the same
 * green. The tones are imported rather than re-picked, because the one thing
 * worse than an unstyled code field is a second, slightly different red.
 */

/**
 * ⚠ THE SAME TWO-STRENGTH RULE THE FLOATING FIELD USES: muted at rest, solid
 * when the box is the one being typed into. It is duplicated here rather than
 * imported because the floating field's map is keyed to a `peer-focus` selector
 * that does not exist in this markup — the real input is a single hidden field
 * somewhere else in the tree, so "active" is a piece of state `input-otp` hands
 * us, not a CSS relationship.
 */
const SLOT_TONES: Record<FieldState, { rest: string; active: string }> = {
  idle: { rest: "border-input", active: "border-ring" },
  pending: { rest: "border-warning/60", active: "border-warning" },
  invalid: { rest: "border-danger/70", active: "border-danger" },
  valid: { rest: "border-success/60", active: "border-success" },
}

function InputOTP({
  className,
  containerClassName,
  ...props
}: React.ComponentProps<typeof OTPInput> & {
  containerClassName?: string
}) {
  return (
    <OTPInput
      data-slot="input-otp"
      containerClassName={cn(
        "flex items-center gap-2 has-disabled:opacity-50",
        containerClassName,
      )}
      className={cn("disabled:cursor-not-allowed", className)}
      {...props}
    />
  )
}

function InputOTPGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-otp-group"
      /*
       * ⚠ A REAL GAP, WHICH IS WHAT MAKES THEM SIX THINGS. The default group
       * sets no gap at all and relies on `first:`/`last:` border rules to fake
       * one control out of six elements.
       */
      className={cn("flex items-center gap-2", className)}
      {...props}
    />
  )
}

function InputOTPSlot({
  index,
  state = "idle",
  className,
  ...props
}: React.ComponentProps<"div"> & {
  index: number
  state?: FieldState
}) {
  const inputOTPContext = React.useContext(OTPInputContext)
  const { char, hasFakeCaret, isActive } = inputOTPContext?.slots[index] ?? {}
  const tone = SLOT_TONES[state]

  return (
    <div
      data-slot="input-otp-slot"
      data-active={isActive}
      className={cn(
        /*
         * ⚠ 48px SQUARE AND `rounded-xl`, WHICH IS THE TEXTAREA'S CORNER RATHER
         * THAN THE INPUT'S PILL. See the note on `rounded-xl` in
         * floating-field: a pill radius on a box this small eats the corner
         * entirely and leaves a lozenge, and six lozenges in a row read as
         * buttons. Forty-eight also keeps all six on one line at 320px with the
         * 8px gaps, which a 56px box does not.
         */
        "relative flex size-12 items-center justify-center rounded-xl border",
        // ⚠ 18px. The digits are the content of the screen, and the 14px the
        // default shipped is smaller than the sentence explaining them.
        "text-lg font-medium tabular-nums",
        // The same translucent fill every other control carries in dark mode,
        // so a row of these sits at the same depth as the inputs above them.
        "bg-transparent dark:bg-input/25",
        /*
         * ⚠ THE TRANSITION IS EXPLICIT AND SHORT. `transition-all` was picking
         * up the layout properties too, so a slot that gained a digit animated
         * its own metrics — which at six boxes filled in a second reads as the
         * row wobbling.
         */
        "transition-colors duration-(--duration-instant) ease-(--ease-linear)",
        "outline-none",
        tone.rest,
        isActive && ["z-10", tone.active],
        className,
      )}
      {...props}
    >
      {char}
      {hasFakeCaret && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-5 w-px animate-caret-blink bg-foreground duration-1000" />
        </div>
      )}
    </div>
  )
}

function InputOTPSeparator({ ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="input-otp-separator" role="separator" {...props}>
      <MinusIcon />
    </div>
  )
}

export { InputOTP, InputOTPGroup, InputOTPSlot, InputOTPSeparator }
