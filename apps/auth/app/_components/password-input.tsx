"use client"

import { useState } from "react"
import { EyeIcon, EyeOffIcon } from "lucide-react"
import { ValidatedInput } from "@repo/ui/components/validated-field"

/**
 * A password field that can be read back.
 *
 * ⚠ THE TOGGLE IS A `type="button"`, AND THE ATTRIBUTE IS LOAD-BEARING. A
 * <button> inside a <form> defaults to `type="submit"`, so without it the eye
 * would submit the form — on the sign-in page that means one click sends a
 * half-typed password, and on the sign-up page it fires validation against a
 * form nobody finished.
 *
 * ⚠ AND THE TOGGLE NEVER MOVES THE CARET. Switching `type` between `password`
 * and `text` keeps the value and the cursor where they were in every browser we
 * care about; re-rendering a different element instead would drop the caret to
 * the end mid-word. Where the caret STARTS is the caller's business — sign-up
 * autofocuses this field when it already has the address, see `startOnPassword`
 * there — and `autoFocus` passes straight through with everything else.
 *
 * ⚠ THE LABEL IS NOW INSIDE THE FIELD RATHER THAN ABOVE IT. `FloatingInput`
 * owns the association, so the caller passes `label` instead of pairing an
 * `<Input>` with its own `<FieldLabel htmlFor>` — which is one fewer place for
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
  ...props
}: Omit<React.ComponentProps<typeof ValidatedInput>, "adornment" | "type">) {
  const [shown, setShown] = useState(false)
  const Icon = shown ? EyeOffIcon : EyeIcon

  return (
    <ValidatedInput
      {...props}
      label={label}
      type={shown ? "text" : "password"}
      adornment={
        <button
          type="button"
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
          className="-me-1 grid size-9 place-items-center rounded-pill text-muted-foreground transition-colors duration-(--duration-instant) hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {/*
           * ⚠ 18px, WHICH OVERRIDES `Button`'S 16px DEFAULT ON PURPOSE. An eye
           * is a lot of detail in a small square — pupil, lid, and on the
           * crossed-out variant a stroke through all of it — so at 16px it
           * reads as a smudge where the other icons in the product read as
           * shapes. It is the only control in the form somebody has to FIND
           * rather than tab to, and it sits alone in a 36px tap target with
           * room to spare.
           */}
          <Icon className="size-4.5" aria-hidden="true" />
        </button>
      }
    />
  )
}
