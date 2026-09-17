"use client"

import * as React from "react"
import { Button } from "@repo/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/ui/components/dialog"
import { Input } from "@repo/ui/components/input"
import { Label } from "@repo/ui/components/label"
import { Spinner } from "@repo/ui/components/spinner"
import { useResetOnOpen } from "@/lib/react"

/**
 * "Are you sure?", for the things that are worth asking about.
 *
 * ⚠ IT IS USED SPARINGLY, ON PURPOSE. A confirmation on every destructive
 * action trains people to dismiss confirmations, which makes the one that
 * mattered useless. The rule here: confirm when the action is irreversible AND
 * affects something live. Deleting a draft does not qualify; deleting a domain
 * that is carrying mail does.
 *
 * ⚠ `confirmWord` RAISES THE BAR FROM "CLICK AGAIN" TO "READ THIS". Typing the
 * name is the only confirmation that cannot be completed by muscle memory, and
 * it is the one that stops somebody deleting the production domain from a table
 * of five similar rows. It is reserved for exactly that case.
 *
 * ⚠ AND `onConfirm` RETURNS A BOOLEAN RATHER THAN THROWING. A failed delete
 * must leave the dialog open with the error visible — closing it and firing a
 * toast means the person believes the thing is gone when it is not, and the
 * list they return to still shows it.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  confirmWord,
  destructive = true,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel?: string
  /** When set, the button stays disabled until this exact string is typed. */
  confirmWord?: string
  destructive?: boolean
  onConfirm: () => Promise<boolean>
}) {
  const [typed, setTyped] = React.useState("")
  const [pending, setPending] = React.useState(false)

  // ⚠ RESET ON OPEN, NOT ON CLOSE. Resetting on close races the exit animation
  // — the field visibly empties while the dialog is still fading out, which
  // looks like the input being cleared out from under you.
  useResetOnOpen(open, () => setTyped(""))

  const armed = confirmWord === undefined || typed.trim() === confirmWord

  async function confirm() {
    if (!armed || pending) return
    setPending(true)
    const ok = await onConfirm()
    setPending(false)
    if (ok) onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={pending ? () => {} : onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {confirmWord !== undefined && (
          <div className="space-y-2">
            <Label htmlFor="confirm-word" className="text-xs font-normal">
              Type <span className="font-mono font-medium">{confirmWord}</span> to
              confirm
            </Label>
            <Input
              id="confirm-word"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              className="font-mono"
              // ⚠ SUBMITS ON ENTER ONLY WHEN ARMED. Without the guard, Enter in
              // a half-typed field would fire a disabled-looking button.
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  void confirm()
                }
              }}
            />
          </div>
        )}

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            onClick={confirm}
            disabled={!armed || pending}
          >
            {pending && <Spinner />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
