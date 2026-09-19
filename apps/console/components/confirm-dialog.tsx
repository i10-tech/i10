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
import { Spinner } from "@repo/ui/components/spinner"
import { FloatingInput } from "@repo/ui/components/floating-field"
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
 *
 * ⚠ `children` IS FOR A SECOND QUESTION THE FIRST ONE RAISES, NOT FOR DECORATION.
 * Deleting a domain is the case it exists for: any key restricted to that
 * domain is about to become a credential that can send from nothing, and the
 * moment to ask about it is while somebody is already deciding. A separate
 * dialog afterwards would be a second interruption about a consequence of the
 * first, and one nobody would connect to it.
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
  children,
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
  /** A second question, asked above the confirmation. See the note above. */
  children?: React.ReactNode
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

        {/*
         * ⚠ ABOVE THE TYPE-THE-NAME FIELD, WHICH IS THE ONLY ORDER THAT WORKS.
         * The field is the last thing before the button and the thing that arms
         * it; a question underneath it would be answered after somebody has
         * already committed to the action.
         */}
        {children}

        {confirmWord !== undefined && (
          <div>
            {/*
             * ⚠ THE WORD IS IN THE LABEL, WHICH MEANS IT LOSES THE MONOSPACE
             * EMPHASIS IT USED TO HAVE. A floating label is a plain string —
             * it animates `font-size`, and a nested element with its own family
             * shifts at a different rate and lands a pixel out. The word is
             * repeated in the hint below in mono, where it can be compared
             * character by character, which is what it is actually for.
             */}
            <FloatingInput
              id="confirm-word"
              label={`Type ${confirmWord} to confirm`}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              className="font-mono"
              /*
               * ⚠ IT GOES GREEN ONLY ON AN EXACT MATCH, AND STAYS NEUTRAL WHILE
               * EMPTY RATHER THAN GOING RED. A field that turns red the moment
               * you focus it is scolding somebody for not having typed yet;
               * red here means "this is not the word", which is only true once
               * there is something to compare.
               */
              state={typed.length === 0 ? "idle" : armed ? "valid" : "invalid"}
              hint={<span className="font-mono">{confirmWord}</span>}
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
