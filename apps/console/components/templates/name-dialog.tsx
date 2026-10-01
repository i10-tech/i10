"use client"

import * as React from "react"
import { ValidatedInput } from "@repo/ui/components/validated-field"
import { FormDialog } from "@/components/form-dialog"
import type { ActionResult } from "@/lib/actions"
import { useResetOnOpen } from "@/lib/react"

/**
 * One name in a dialog: "Create folder", "Rename folder", "Rename template".
 *
 * ⚠ THE SAME DIALOG AS EVERY OTHER CREATE IN THE CONSOLE, so a failure (a
 * name that is taken) keeps it open with what was typed, and success ticks
 * the button before it closes. See `FormDialog`.
 */
export function NameDialog<T>({
  open,
  onOpenChange,
  title,
  description,
  label = "Name",
  placeholder,
  initial = "",
  submitLabel,
  doneLabel,
  maxLength = 100,
  onSubmit,
  onSuccess,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  label?: string
  placeholder?: string
  initial?: string
  submitLabel: string
  doneLabel: string
  maxLength?: number
  onSubmit: (name: string) => Promise<ActionResult<T>>
  onSuccess?: (data: T) => void
}) {
  const [name, setName] = React.useState(initial)
  useResetOnOpen(open, () => setName(initial))
  const trimmed = name.trim()

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      submitLabel={submitLabel}
      doneLabel={doneLabel}
      canSubmit={
        trimmed.length > 0 && trimmed.length <= maxLength && trimmed !== initial.trim()
      }
      onSubmit={() => onSubmit(trimmed)}
      onSuccess={onSuccess}
    >
      <ValidatedInput
        label={label}
        id="name-dialog-input"
        value={name}
        onChange={(event) => setName(event.target.value)}
        autoComplete="off"
        autoFocus
        required={`${label} cannot be empty.`}
        check={(value) =>
          value.trim().length > maxLength ? `At most ${maxLength} characters.` : null
        }
        hint={placeholder}
      />
    </FormDialog>
  )
}
