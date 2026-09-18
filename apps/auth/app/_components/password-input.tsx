"use client"

import { useState } from "react"
import { EyeIcon, EyeOffIcon } from "lucide-react"
import { FloatingInput } from "@repo/ui/components/floating-field"

/**
 * A password field that can be read back.
 *
 * ⚠ THE TOGGLE IS A `type="button"`, AND THE ATTRIBUTE IS LOAD-BEARING. A
 * <button> inside a <form> defaults to `type="submit"`, so without it the eye
 * would submit the form — on the sign-in page that means one click sends a
 * half-typed password, and on the sign-up page it fires validation against a
 * form nobody finished.
 *
 * ⚠ AND IT NEVER AUTOFOCUSES OR STEALS THE CARET. Toggling `type` between
 * `password` and `text` keeps the value and the cursor where they were in every
 * browser we care about; re-rendering a different element instead would drop
 * the caret to the end mid-word.
 *
 * ⚠ THE LABEL IS NOW INSIDE THE FIELD RATHER THAN ABOVE IT. `FloatingInput`
 * owns the association, so the caller passes `label` instead of pairing an
 * `<Input>` with its own `<FieldLabel htmlFor>` — which is one fewer place for
 * an id to be spelled two different ways.
 */
export function PasswordInput({
  label = "Password",
  ...props
}: Omit<React.ComponentProps<typeof FloatingInput>, "adornment" | "type">) {
  const [shown, setShown] = useState(false)
  const Icon = shown ? EyeOffIcon : EyeIcon

  return (
    <FloatingInput
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
          <Icon className="size-4" aria-hidden="true" />
        </button>
      }
    />
  )
}
