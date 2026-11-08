"use client"

import * as React from "react"
import { Plus } from "lucide-react"
import { Button } from "@repo/ui/components/button/button"
import { EmailInput } from "@repo/ui/components/i10/email-input"
import { emailProblem, isEmailUsable } from "@repo/ui/checks"
import { FormDialog } from "@/components/form-dialog"
import { addSuppression } from "@/lib/actions"
import { useResetOnOpen } from "@/lib/react"

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

  // On open, not on close: see `useResetOnOpen`.
  useResetOnOpen(open, () => {
    setAddress("")
  })

  return (
    <FormDialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button size="sm" variant="secondary">
          <Plus />
          Suppress an address
        </Button>
      }
      title="Suppress an address"
      description="We will skip this address on every send from this workspace, transactional and marketing alike."
      submitLabel="Suppress"
      doneLabel="Suppressed"
      canSubmit={isEmailUsable(address)}
      onSubmit={() => addSuppression(address.trim())}
    >
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
    </FormDialog>
  )
}
