"use client"

import type * as React from "react"
import { Field, FieldLabel } from "./field"
import { fieldHintTone, type FieldState } from "./floating-field"
import { InputOTP, InputOTPGroup, InputOTPSlot } from "./input-otp"
import { cn } from "cn"

/** Every code Clerk emails is six digits. */
export const OTP_LENGTH = 6

/**
 * How long the accepted state stays on screen before the page moves on.
 *
 * ⚠ THE WHOLE ANIMATION, AND NOT A FRAME MORE. The row slides down over
 * 450ms and the check draws over 400ms starting 150ms in, so the last frame
 * lands at 550ms; 600ms lets it be seen finished. It is counted from when the
 * check appeared, and `finalize` runs during it, so on a normal connection
 * this is the whole wait on our side. Keep it above the animation's end if
 * either duration changes.
 */
export const ACCEPTED_HOLD_MS = 600

/**
 * The six-box code entry, shared by every flow that asks for one - in auth
 * today, and in the console the moment it asks for a code of its own.
 *
 * ⚠ IT EXISTS BECAUSE THE PLAIN `<Input>` IT REPLACES CARRIED A REAL BUG, not
 * because three screens happened to look alike. Sign-up renders its two stages
 * from one component, and a bare `<Input>` in the verify stage landed at the
 * SAME position in the React tree as the "Full Name" field of the stage before
 * it. React reconciles by position and type, so it reused the DOM node - and
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
  state = "idle",
  hint,
  verified = false,
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
  /**
   * ⚠ THE SAME FOUR STATES EVERY OTHER FIELD HAS, AND `invalid` IS THE ONE THIS
   * SCREEN WAS MISSING. A rejected code used to be reported by a toast and
   * nothing else - it slid away after four seconds and left six boxes looking
   * exactly as they had when the code was still unjudged, which is the state
   * somebody is in when they type the same wrong code again.
   */
  state?: FieldState
  /** The sentence under the boxes. Takes its colour from `state`. */
  hint?: React.ReactNode
  /**
   * The code was accepted.
   *
   * ⚠ IT IS A SEPARATE PROP RATHER THAN `state="valid"` AT EACH CALL SITE,
   * because the accepted state is not just a colour - it is a colour, a word
   * and a movement, and four screens reproducing that from three props is four
   * chances for them to disagree. Everything that asks for a code now confirms
   * it identically.
   *
   * ⚠ AND IT IS WORTH SHOWING AT ALL EVEN THOUGH THE SCREEN IS ABOUT TO
   * NAVIGATE. Six boxes that simply empty and vanish leave somebody unsure
   * whether the code worked or the page glitched; half a second of green is
   * the difference between "done" and "what just happened".
   */
  verified?: boolean
}) {
  /*
   * ⚠ ACCEPTANCE OUTRANKS EVERYTHING, INCLUDING A STALE `invalid`. A caller
   * that forgets to clear its rejection message before reporting success would
   * otherwise paint red boxes around a code that was just accepted.
   */
  const tone: FieldState = verified ? "valid" : state
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
            <InputOTPSlot
              key={i}
              index={i}
              state={tone}
              // The boxes turn green as slowly as the check below draws, so
              // the whole field answers as one movement.
              className={verified ? "duration-300" : undefined}
            />
          ))}
        </InputOTPGroup>
      </InputOTP>
      {/*
       * ⚠ THE ROW IS ALWAYS RENDERED AND ALWAYS RESERVED, for the reason the
       * floating field reserves its own: a message that appears underneath
       * pushes the button below it down by sixteen pixels, and on this screen
       * the button below it is the one being aimed at.
       *
       * ⚠ AND THE LIVE REGION IS THE ROW, NOT THE MESSAGE. A region has to
       * exist before its text arrives for a screen reader to announce the
       * change; conditionally rendering it is why validation is silent for
       * anybody not looking at it.
       */}
      {/*
       * ⚠ THE ACCEPTED STATE IS OUT OF THE FLOW, PINNED IN THIS ROW. Drawn
       * inline, a 16px icon inside a 16px line of text still moved the line
       * box by about a pixel, and the card is centred vertically, so the
       * boxes, the heading and everything above shifted with it. Absolutely
       * positioned, the only pixels that change are its own.
       */}
      <p
        aria-live="polite"
        className={cn(
          "relative min-h-4 text-center text-2xs leading-4",
          "transition-colors duration-(--duration-instant) ease-(--ease-linear)",
          fieldHintTone(tone),
        )}
      >
        {verified ? (
          <span className="absolute inset-x-0 top-0 flex h-4 justify-center">
            <Accepted />
          </span>
        ) : (
          hint
        )}
      </p>
    </Field>
  )
}

/**
 * The accepted state: a green check that draws itself, sliding down into the
 * row under the boxes, with the word beside it (#151).
 *
 * ⚠ IT MOVES DOWN, FROM THE BOXES, BECAUSE THAT IS WHERE THE ANSWER CAME
 * FROM. The code was typed above; the confirmation arriving out of it reads as
 * the boxes answering, where a fade in place reads as a label changing.
 *
 * ⚠ THE CHECK IS DRAWN, NOT SHOWN. `pathLength="1"` normalises the stroke so
 * one keyframe on `stroke-dashoffset` works at any size. Under reduced motion
 * the blanket rule in tokens.css cuts both animations to their last frame: the
 * check and the word are simply there.
 */
function Accepted() {
  return (
    <span className="flex h-4 animate-[code-accepted_450ms_var(--ease-quint-out)] items-center gap-1.5 text-xs leading-4 font-medium text-success">
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        className="size-4 shrink-0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="8" cy="8" r="7" className="opacity-30" />
        <path
          d="M4.75 8.25 7 10.5l4.25-4.75"
          pathLength="1"
          strokeDasharray="1"
          className="animate-[check-draw_400ms_var(--ease-quint-out)_150ms_both]"
        />
      </svg>
      Verified
    </span>
  )
}
