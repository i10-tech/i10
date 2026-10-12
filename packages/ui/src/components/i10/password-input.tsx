"use client"

import { useState } from "react"
import {
  AnimatePresence,
  motion,
  useReducedMotion,
  type TargetAndTransition,
  type Transition,
} from "motion/react"
import { ValidatedInput } from "@repo/ui/components/i10/validated-field"
import { motionTokens } from "../lib/motion-tokens"
import { EyeMorph } from "@repo/ui/components/password-strength/password-strength"

/**
 * A password field that can be read back.
 *
 * ⚠ THE TOGGLE IS A `type="button"`, AND THE ATTRIBUTE IS LOAD-BEARING. A
 * <button> inside a <form> defaults to `type="submit"`, so without it the eye
 * would submit the form - on the sign-in page that means one click sends a
 * half-typed password, and on the sign-up page it fires validation against a
 * form nobody finished.
 *
 * ⚠ AND THE TOGGLE NEVER MOVES THE CARET. Switching `type` between `password`
 * and `text` keeps the value and the cursor where they were in every browser we
 * care about; re-rendering a different element instead would drop the caret to
 * the end mid-word. Where the caret STARTS is the caller's business - sign-up
 * autofocuses this field when it already has the address, see `startOnPassword`
 * there - and `autoFocus` passes straight through with everything else.
 *
 * ⚠ AND PRESSING IT NEVER MOVES FOCUS (2026-10-12). The press is cancelled
 * at pointer-down, before the browser hands focus to the button: a field that
 * was being typed in stays focused with its caret where it was, and one that
 * was not stays unfocused rather than lighting up because the eye was pressed.
 * Keyboard users still Tab to it and press it as an ordinary button.
 *
 * ⚠ THE LABEL IS NOW INSIDE THE FIELD RATHER THAN ABOVE IT. `FloatingInput`
 * owns the association, so the caller passes `label` instead of pairing an
 * `<Input>` with its own `<FieldLabel htmlFor>` - which is one fewer place for
 * an id to be spelled two different ways.
 *
 * ⚠ AND IT WRAPS `ValidatedInput` RATHER THAN THE PLAIN FIELD, so a password
 * box takes a `check` like everything else. The sign-up form used to compute
 * the verdict itself and hand it down as `state` and `hint`; the reset form,
 * which asks for the same password under the same policy, computed nothing at
 * all and let the server say no.
 */
export function PasswordInput({
  label = "Password",
  verified = false,
  ...props
}: Omit<React.ComponentProps<typeof ValidatedInput>, "adornment" | "type"> & {
  /**
   * The value has been checked and is right (2026-10-12): the eye becomes a
   * green tick, the way Arc's copy button turns into one, and the box locks.
   * The change-password form sets it once the current password is confirmed.
   */
  verified?: boolean
}) {
  const [shown, setShown] = useState(false)
  const reduce = useReducedMotion() ?? false

  return (
    <ValidatedInput
      {...props}
      label={label}
      // ⚠ HIDDEN AGAIN ONCE VERIFIED. A confirmed password left readable on
      // screen is a password left readable for the rest of the form.
      type={shown && !verified ? "text" : "password"}
      readOnly={verified || props.readOnly}
      aria-readonly={verified || undefined}
      adornment={
        <span className="relative -me-1 grid size-9 place-items-center">
          <AnimatePresence initial={false}>
            {verified ? (
              <motion.span
                key="verified"
                role="img"
                aria-label="Password confirmed"
                className="absolute inset-0 grid place-items-center text-success"
                initial={reduce ? fadeIn : iconIn}
                animate={rest}
                exit={reduce ? fadeOut : iconOut}
                transition={reduce ? instant : iconEnter}
              >
                <DrawnCheck reduced={reduce} />
              </motion.span>
            ) : (
              <motion.span
                key="eye"
                className="absolute inset-0 grid place-items-center"
                initial={reduce ? fadeIn : iconIn}
                animate={rest}
                exit={reduce ? fadeOut : iconOut}
                transition={reduce ? instant : iconEnter}
              >
                <button
                  type="button"
                  // ⚠ BOTH, because touch focuses on the compatibility mousedown that
                  // a cancelled pointerdown suppresses, and a mouse on the mousedown.
                  onPointerDown={(event) => event.preventDefault()}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => setShown((v) => !v)}
                  // ⚠ THE LABEL NAMES THE ACTION, NOT THE STATE, and `aria-pressed`
                  // carries the state instead. A screen reader announcing "show
                  // password, pressed" is unambiguous; a label that flips to "hide
                  // password" makes the button appear to rename itself on every click.
                  aria-label="Show password"
                  aria-pressed={shown}
                  // ⚠ `-me-1` PULLS IT BACK TOWARDS THE EDGE THE PADDING PUSHED IT FROM.
                  // The tap target stays 36px square, which is what the padding is for;
                  // without the negative margin the icon sits visibly further from the
                  // rounded edge than the caret does from the other one.
                  className="grid size-9 place-items-center rounded-pill text-muted-foreground transition-colors duration-(--duration-instant) hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  {/*
                   * ⚠ 18px, WHICH OVERRIDES `Button`'S 16px DEFAULT ON PURPOSE. An eye
                   * is a lot of detail in a small square - pupil, lid, and on the
                   * crossed-out variant a stroke through all of it - so at 16px it
                   * reads as a smudge where the other icons in the product read as
                   * shapes. It is the only control in the form somebody has to FIND
                   * rather than tab to, and it sits alone in a 36px tap target with
                   * room to spare.
                   */}
                  {/*
                   * ⚠ ARC'S EYE MORPH, NOT TWO ICONS (2026-10-12): one eye, and a
                   * slash that draws across it and cuts the outline beneath - the
                   * same `EyeMorph` Arc's password-strength field uses.
                   */}
                  <EyeMorph slashed={shown} reduced={reduce} />
                </button>
              </motion.span>
            )}
          </AnimatePresence>
        </span>
      }
    />
  )
}

/*
 * Arc's copy-button swap, at the eye's size: the old glyph shrinks into a blur
 * while the new one grows out of it on a slow, barely bouncing spring.
 */
const soft = `blur(${motionTokens.blur.soft}px)`
const instant: Transition = { duration: motionTokens.duration.instant }
const rest: TargetAndTransition = { opacity: 1, scale: 1, filter: "blur(0px)" }
const fadeIn: TargetAndTransition = { ...rest, opacity: 0 }
const fadeOut: TargetAndTransition = { opacity: 0, transition: instant }
const iconIn: TargetAndTransition = { opacity: 0, scale: 0.6, filter: soft }
const iconOut: TargetAndTransition = {
  opacity: 0,
  scale: 0.6,
  filter: soft,
  transition: {
    duration: 0.24,
    ease: [...motionTokens.ease.standard] as [number, number, number, number],
  },
}
const enter = {
  duration: 0.36,
  ease: [...motionTokens.ease.enter] as [number, number, number, number],
  delay: 0.03,
}
const iconEnter: Transition = {
  scale: { type: "spring", visualDuration: 0.5, bounce: 0.06 },
  opacity: enter,
  filter: enter,
}

/** The tick draws itself from its short stroke, as the copy button's does. */
function DrawnCheck({ reduced }: { reduced: boolean }) {
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <motion.path
        d="M4 12l5 5L20 6"
        initial={reduced ? false : { pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{
          pathLength: {
            duration: 0.5,
            ease: [...motionTokens.ease.standard] as [number, number, number, number],
            delay: 0.05,
          },
          opacity: { duration: 0.01, delay: 0.05 },
        }}
      />
    </svg>
  )
}
