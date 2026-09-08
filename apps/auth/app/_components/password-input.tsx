"use client"

import { useState } from "react"
import { EyeIcon, EyeOffIcon } from "lucide-react"
import { Input } from "@repo/ui/components/input"

/**
 * A password field that can be read back.
 *
 * ⚠ THE TOGGLE IS A `type="button"`, AND THE ATTRIBUTE IS LOad-BEARING. A
 * <button> inside a <form> defaults to `type="submit"`, so without it the eye
 * would submit the form — on the sign-in page that means one click sends a
 * half-typed password, and on the sign-up page it fires validation against a
 * form nobody finished.
 *
 * ⚠ AND IT NEVER AUTOFOCUSES OR STEALS THE CARET. Toggling `type` between
 * `password` and `text` keeps the value and the cursor where they were in every
 * browser we care about; re-rendering a different element instead would drop
 * the caret to the end mid-word.
 */
export function PasswordInput({
  className,
  ...props
}: React.ComponentProps<typeof Input>) {
  const [shown, setShown] = useState(false)
  const Icon = shown ? EyeOffIcon : EyeIcon

  return (
    <div className="relative">
      <Input
        {...props}
        type={shown ? "text" : "password"}
        // Room for the button, so a long password never runs underneath it.
        className={`pr-10 ${className ?? ""}`}
      />
      <button
        type="button"
        onClick={() => setShown((v) => !v)}
        // ⚠ THE LABEL NAMES THE ACTION, NOT THE STATE, and `aria-pressed`
        // carries the state instead. A screen reader announcing "show password,
        // pressed" is unambiguous; a label that flips to "hide password" makes
        // the button appear to rename itself on every click.
        aria-label="Show password"
        aria-pressed={shown}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring absolute inset-y-0 right-0 flex items-center rounded-md px-3 focus-visible:ring-2 focus-visible:outline-none"
      >
        <Icon className="size-4" aria-hidden="true" />
      </button>
    </div>
  )
}
