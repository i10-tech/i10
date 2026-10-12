"use client"

import * as React from "react"
import { LogOut, Redo2 } from "lucide-react"
import { StateButton } from "@repo/ui/components/i10/state-button"
import { Button } from "@repo/ui/components/button/button"
import { Dialog, DialogContent } from "@repo/ui/components/dialog/dialog"
import { DialogFooter } from "@repo/ui/components/i10/dialog-footer"
import { Kbd } from "@repo/ui/components/i10/kbd"
import { KBD_ON_BUTTON } from "@/components/confirm-dialog"
import { useOutcome } from "@/lib/outcome"

/**
 * Leaving the editor with changes auto-save is not keeping: save them and
 * go, go without them, or - the X - stay.
 *
 * ⚠ SAVING FIRST IS THE DEFAULT, ON ENTER. Losing work is the outcome nobody
 * picks on purpose, so it takes the deliberate key (⌘⌫) and the plain one
 * keeps it. A save that fails leaves the dialog open, with the work intact.
 */
export function LeaveDialog({
  open,
  onOpenChange,
  onSave,
  onDiscard,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Saves; true when it did. */
  onSave: () => Promise<boolean>
  onDiscard: () => void
}) {
  const outcome = useOutcome()
  const pending = outcome.state !== "idle"

  return (
    <Dialog open={open} onOpenChange={pending ? () => {} : onOpenChange}>
      <DialogContent
        onKeyDown={(event) => {
          if (pending) return
          if (event.key === "Backspace" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            onDiscard()
          } else if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
            if ((event.target as HTMLElement).closest("button")) return
            event.preventDefault()
            void outcome.run(onSave)
          }
        }}
        title="Leave with unsaved changes?"
        description="Your latest changes to this template have not been saved. Save them before you go, or leave them behind."
        style={{ width: "min(calc(100vw - 2rem), 448px)" }}
      >
        <DialogFooter>
          <Button variant="secondary" onClick={onDiscard} disabled={pending}>
            <LogOut />
            Leave without saving
            <Kbd>⌘⌫</Kbd>
          </Button>
          <StateButton
            onClick={() => void outcome.run(onSave)}
            state={outcome.state}
            pendingLabel="Saving"
            doneLabel="Saved"
          >
            Save and leave
            <Kbd className={KBD_ON_BUTTON.default}>
              <Redo2 aria-hidden="true" className="size-2.5 rotate-180" />
            </Kbd>
          </StateButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
