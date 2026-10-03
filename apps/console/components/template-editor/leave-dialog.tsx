"use client"

import * as React from "react"
import { LogOut, Redo2 } from "lucide-react"
import { ActionButton } from "@repo/ui/components/action-button"
import { Button } from "@repo/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/ui/components/dialog"
import { Kbd } from "@repo/ui/components/kbd"
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
        className="sm:max-w-md"
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
      >
        <DialogHeader>
          <DialogTitle>Leave with unsaved changes?</DialogTitle>
          <DialogDescription>
            Your latest changes to this template have not been saved. Save them before
            you go, or leave them behind.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onDiscard} disabled={pending}>
            <LogOut />
            Leave without saving
            <Kbd>⌘⌫</Kbd>
          </Button>
          <ActionButton
            onClick={() => void outcome.run(onSave)}
            state={outcome.state}
            pendingLabel="Saving"
            doneLabel="Saved"
          >
            Save and leave
            <Kbd className={KBD_ON_BUTTON.default}>
              <Redo2 aria-hidden="true" className="size-2.5 rotate-180" />
            </Kbd>
          </ActionButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
