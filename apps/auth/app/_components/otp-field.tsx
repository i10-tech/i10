"use client"

import { Field, FieldLabel } from "@repo/ui/components/field"
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@repo/ui/components/input-otp"

/** Every code Clerk emails is six digits. */
export const OTP_LENGTH = 6

/**
 * The six-box code entry, shared by every flow that asks for one.
 *
 * ⚠ IT EXISTS BECAUSE THE PLAIN `<Input>` IT REPLACES CARRIED A REAL BUG, not
 * because three screens happened to look alike. Sign-up renders its two stages
 * from one component, and a bare `<Input>` in the verify stage landed at the
 * SAME position in the React tree as the "Full Name" field of the stage before
 * it. React reconciles by position and type, so it reused the DOM node — and
 * the name the person had just typed was sitting in the code box, waiting to be
 * deleted before they could type anything. A different component at that
 * position cannot be reused, which fixes it structurally rather than by
 * clearing a value on mount.
 */
export function OtpField({
  value,
  onChange,
  onComplete,
  label = "Verification code",
  autoFocus,
}: {
  value: string
  onChange: (value: string) => void
  /**
   * Fired when the last digit lands.
   *
   * ⚠ OMITTED WHERE THE CODE IS NOT THE WHOLE FORM. On the reset screen the
   * boxes sit above two password fields, so submitting the instant they fill
   * would send an empty password. Only pass this where the code is the last
   * thing the person has to give.
   */
  onComplete?: () => void
  label?: string
  autoFocus?: boolean
}) {
  return (
    <Field>
      {/*
       * ⚠ THE LABEL IS `htmlFor` THE OTP INPUT'S OWN HIDDEN FIELD, which
       * `InputOTP` renders and points at with this id. The boxes are
       * presentational: a screen reader lands on the single input behind them,
       * and labelling the wrapper instead leaves it unnamed.
       */}
      <FieldLabel htmlFor="code">{label}</FieldLabel>
      <InputOTP
        id="code"
        name="code"
        maxLength={OTP_LENGTH}
        value={value}
        onChange={onChange}
        onComplete={onComplete}
        // ⚠ `one-time-code` IS WHAT MAKES iOS OFFER THE CODE FROM THE
        // NOTIFICATION. Without it the person reads six digits off a banner and
        // types them by hand.
        autoComplete="one-time-code"
        autoFocus={autoFocus}
        containerClassName="justify-center"
      >
        <InputOTPGroup>
          {Array.from({ length: OTP_LENGTH }, (_, i) => (
            <InputOTPSlot key={i} index={i} />
          ))}
        </InputOTPGroup>
      </InputOTP>
    </Field>
  )
}
