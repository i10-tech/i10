"use client"

import * as React from "react"
import { ActionButton } from "@repo/ui/components/action-button"
import { Button } from "@repo/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@repo/ui/components/dialog"
import type { ActionResult } from "@/lib/actions"
import { useOutcome } from "@/lib/outcome"
import { useResetOnOpen } from "@/lib/react"
import { toastFailure } from "@/lib/toast"

/**
 * The shape every small create/edit dialog in the console shares.
 *
 * ⚠ IT EXISTS SO THAT ERROR HANDLING IS WRITTEN ONCE. Eight dialogs each doing
 * their own `try`, their own toast and their own refresh is eight chances for
 * one of them to close on a failure - which tells somebody the thing was
 * created when it was not, and the list they return to proves them wrong. Here
 * the rule is in one place: a failed submit keeps the dialog open and shows the
 * API's own message.
 *
 * ⚠ SUCCESS IS SAID IN THE DIALOG, NOT IN A TOAST. The submit button becomes a
 * tick with the past tense of its own label, the fields turn green, and the
 * dialog holds that for a beat before closing - over a list that has ALREADY
 * changed, because the action's response carries the re-rendered page (see
 * `run` in lib/actions.ts). It used to toast, close, and then ask the router
 * for the page again, so the new row arrived a moment after the dialog had gone
 * and the toast was still sliding in. See lib/outcome.ts.
 */
export function FormDialog<T>({
  trigger,
  title,
  description,
  submitLabel = "Create",
  doneLabel = "Created",
  onSubmit,
  onSuccess,
  children,
  open: controlledOpen,
  onOpenChange: setControlledOpen,
  canSubmit = true,
}: {
  trigger?: React.ReactNode
  title: string
  description?: string
  submitLabel?: string
  /**
   * The word on the button once it worked. A dialog whose verb is not "create"
   * says its own - "Added", "Saved".
   */
  doneLabel?: string
  onSubmit: () => Promise<ActionResult<T>>
  /**
   * Called after the confirmation has been shown, INSTEAD of closing. For a
   * caller that navigates to what it just made: the dialog belongs to the page
   * being left and goes with it, where closing it first would uncover the old
   * list for a frame between the tick and the new page.
   */
  onSuccess?: (data: T) => void
  children: React.ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  canSubmit?: boolean
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false)
  const outcome = useOutcome()

  const open = controlledOpen ?? uncontrolledOpen
  const setOpen = setControlledOpen ?? setUncontrolledOpen

  // ⚠ ON OPEN, NOT ON CLOSE - the tick has to stay on the button while the
  // dialog animates out. See `useResetOnOpen`.
  useResetOnOpen(open, outcome.reset)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (outcome.state !== "idle" || !canSubmit) return

    let created: { data: T } | null = null

    await outcome.run(
      async () => {
        const result = await onSubmit()
        if (!result.ok) {
          /*
           * ⚠ A TOAST, AND THE DIALOG STAYS OPEN. This used to render inline,
           * on the reasoning that the message often names a field - "a
           * property with that key already exists" - and a toast puts it where
           * the person is not looking. That trade was made the other way
           * deliberately: errors in this product are reported in ONE place so
           * that none of them can leak wording nobody reviewed, and a red panel
           * appearing inside the dialog also pushed the footer down and moved
           * the submit button under the cursor mid-click.
           *
           * ⚠ WHAT MAKES IT SURVIVABLE IS THAT THE DIALOG DOES NOT CLOSE. The
           * form still shows everything that was typed, so the toast names the
           * problem and the answer is still on screen. The eight-second
           * duration in lib/toast.ts is set for exactly this case.
           */
          toastFailure(result)
          return false
        }
        created = { data: result.data }
        return true
      },
      () => {
        if (onSuccess && created) onSuccess(created.data)
        else setOpen(false)
      },
    )
  }

  return (
    // ⚠ LOCKED WHILE THE CALL IS IN FLIGHT ONLY. Once the tick shows, Escape
    // is just an early close - the thing has been created either way.
    <Dialog open={open} onOpenChange={outcome.state === "pending" ? () => {} : setOpen}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} {...outcome.formProps}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>

          <div className="space-y-4 py-4">{children}</div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={outcome.state === "pending"}
            >
              Cancel
            </Button>
            <ActionButton
              type="submit"
              state={outcome.state}
              pendingLabel={submitLabel}
              doneLabel={doneLabel}
              disabled={!canSubmit}
            >
              {submitLabel}
            </ActionButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
