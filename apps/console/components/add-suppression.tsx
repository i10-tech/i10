"use client"

import * as React from "react"
import { Plus } from "lucide-react"
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
import { EmailInput } from "@repo/ui/components/email-input"
import { emailProblem } from "@repo/ui/checks"
import { addSuppression } from "@/lib/actions"
import { useOutcome } from "@/lib/outcome"
import { useResetOnOpen } from "@/lib/react"
import { toastError } from "@/lib/toast"

/**
 * ⚠ ADDING BY HAND IS FOR THE ADDRESS THAT KEEPS BOUNCING SOFTLY, OR THE ONE
 * SOMEBODY ASKED TO BE REMOVED OVER THE PHONE. It is deliberately a small,
 * quiet control: the list should mostly fill itself from real bounces and
 * complaints, and an account whose suppressions are mostly manual has a data
 * quality problem upstream rather than a suppression problem here.
 */
export function AddSuppressionButton() {
  const [open, setOpen] = React.useState(false)
  const [address, setAddress] = React.useState("")
  const outcome = useOutcome()

  // On open, not on close: see `useResetOnOpen`.
  useResetOnOpen(open, () => {
    setAddress("")
    outcome.reset()
  })

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (outcome.state !== "idle") return

    /*
     * ⚠ NO SUCCESS TOAST. "We will skip it on every future send" is the
     * dialog's own description, already read before pressing the button; the
     * tick confirms it and the new row is in the table behind before the
     * dialog closes. See lib/outcome.ts.
     */
    await outcome.run(
      async () => {
        const result = await addSuppression(address.trim())
        if (!result.ok) {
          toastError("Could not suppress that address", { description: result.error })
          return false
        }
        return true
      },
      () => setOpen(false),
    )
  }

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Plus />
        Suppress an address
      </Button>

      <Dialog
        open={open}
        onOpenChange={outcome.state === "pending" ? () => {} : setOpen}
      >
        <DialogContent className="sm:max-w-md">
          <form onSubmit={submit} {...outcome.formProps}>
            <DialogHeader>
              <DialogTitle>Suppress an address</DialogTitle>
              <DialogDescription>
                We will skip this address on every send from this workspace,
                transactional and marketing alike.
              </DialogDescription>
            </DialogHeader>

            <div className="py-4">
              <EmailInput
                id="suppress-address"
                label="Email address"
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                className="font-mono text-xs"
                check={emailProblem}
                required="Enter the address to suppress."
                autoFocus
                hint="e.g. bounced@example.com"
              />
            </div>

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <ActionButton
                type="submit"
                state={outcome.state}
                pendingLabel="Suppress"
                doneLabel="Suppressed"
                disabled={!address.includes("@")}
              >
                Suppress
              </ActionButton>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
