"use client"

import * as React from "react"
import { Alert } from "@repo/ui/components/alert/alert"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { deleteTeamInbox } from "@/lib/actions"
import { OUTCOME_HOLD_MS } from "@/lib/outcome"
import { useResetOnOpen } from "@/lib/react"
import { useStepUp } from "@/lib/step-up"
import { DELETE_EFFECT, refusalTitle, teamInboxRefusal } from "@/lib/team-inbox"
import { toastDone } from "@/lib/toast"

/**
 * Deleting a team inbox, from its own page.
 *
 * ⚠ IT SAYS EXACTLY WHAT HAPPENS TO THE MAIL, because the API does what it says:
 * the Stalwart account is destroyed first and the directory rows second
 * (`remove` in apps/api/src/team-inboxes/service.ts), so the mail in the inbox
 * and its Sent folder go with it and the address then answers 550. There is no
 * grace period and no export, unlike a mailbox, so the dialog does not offer a
 * way back it does not have.
 *
 * ⚠ THE ADDRESS IS TYPED, NOT A WORD, for the reason `ConfirmDialog` gives: it is
 * the one confirmation that makes somebody read which inbox they are on.
 *
 * ⚠ `leaving`, SO NOTHING REVALIDATES INTO A 404. The page this is called from is
 * the inbox's own, and a refresh after the delete would render its 404 behind the
 * dialog that is still saying "Deleted" (see `deleteDomain`). `onDeleted` runs
 * after the hold so the tick is seen before the page goes.
 *
 * ⚠ A REFUSAL IS AN ALERT IN THE DIALOG, WHICH STAYS OPEN. The step-up comes
 * first and declining it leaves everything as it was.
 */
export function DeleteTeamInboxDialog({
  address,
  open,
  onOpenChange,
  onDeleted,
}: {
  address: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onDeleted: () => void
}) {
  const stepUp = useStepUp()
  const [refusal, setRefusal] = React.useState<string | null>(null)
  useResetOnOpen(open, () => setRefusal(null))

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Delete ${address}?`}
      description={DELETE_EFFECT}
      confirmLabel="Delete team inbox"
      doneLabel="Deleted"
      confirmWord={address}
      onConfirm={async () => {
        setRefusal(null)
        if (!(await stepUp())) return false

        const result = await deleteTeamInbox(address, { leaving: true })
        if (!result.ok) {
          setRefusal(teamInboxRefusal(result, "delete"))
          return false
        }
        toastDone("Team inbox deleted", `${address} no longer accepts mail.`)
        setTimeout(onDeleted, OUTCOME_HOLD_MS)
        return true
      }}
    >
      {refusal && (
        <Alert tone="danger" title={refusalTitle("delete")}>
          {refusal}
        </Alert>
      )}
    </ConfirmDialog>
  )
}
