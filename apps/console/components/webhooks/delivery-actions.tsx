"use client"

import * as React from "react"
import { Eraser, RotateCcw } from "lucide-react"
import { ActionButton } from "@repo/ui/components/action-button"
import { Button } from "@repo/ui/components/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@repo/ui/components/tooltip"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { expungeWebhookPayload, resendWebhookDelivery } from "@/lib/actions"
import { useOutcome } from "@/lib/outcome"
import { useStepUp } from "@/lib/step-up"
import { toastError } from "@/lib/toast"
import type { WebhookDeliveryDetail } from "@/lib/types"

/**
 * Resend this delivery, or remove what it carried.
 *
 * ⚠ RESEND IS ONE MORE ATTEMPT OF THE SAME DELIVERY, same `webhook-id`, so a
 * receiver that deduplicates sees a retry rather than a new event. It is
 * refused while the delivery is still being attempted.
 *
 * ⚠ EXPUNGING IS FOR GOOD AND BEHIND A FRESH SIGN-IN. It empties the payload
 * and what a transformation made of it; the attempts and their responses
 * stay, so the history still explains what happened.
 */
export function DeliveryActions({
  delivery,
  polling,
}: {
  delivery: WebhookDeliveryDetail
  /** A polling endpoint's events are read again from an older cursor instead. */
  polling: boolean
}) {
  const stepUp = useStepUp()
  const resend = useOutcome()
  const [expunging, setExpunging] = React.useState(false)
  const pending = delivery.status === "pending"
  const expunged = delivery.payload_expunged_at !== null
  const why = pending
    ? "Still being attempted. Resend once it has finished."
    : expunged
      ? "Its payload was expunged, so there is nothing to send."
      : null

  const resendButton = (
    <ActionButton
      size="sm"
      state={resend.state}
      onReset={resend.reset}
      pendingLabel="Resend"
      doneLabel="Sent"
      disabled={why !== null}
      onClick={() =>
        void resend.run(async () => {
          const r = await resendWebhookDelivery(delivery.id)
          if (!r.ok) {
            toastError("Could not resend it", { description: r.error })
            return false
          }
          // ⚠ ONE MORE ATTEMPT ON THIS SAME DELIVERY, so the page re-reads
          // itself and the attempt appears at the top of the log.
          return true
        })
      }
    >
      <RotateCcw />
      Resend
    </ActionButton>
  )

  return (
    <>
      {polling ? null : why ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0}>{resendButton}</span>
          </TooltipTrigger>
          <TooltipContent>{why}</TooltipContent>
        </Tooltip>
      ) : (
        resendButton
      )}
      {!expunged && !pending && (
        <Button size="sm" variant="outline" onClick={() => setExpunging(true)}>
          <Eraser />
          <span className="hidden sm:inline">Expunge payload</span>
        </Button>
      )}

      <ConfirmDialog
        open={expunging}
        onOpenChange={setExpunging}
        title="Expunge this payload?"
        description="The event's data and what was sent are removed for good. The attempts and your receiver's responses stay, and it can no longer be resent."
        confirmLabel="Expunge payload"
        doneLabel="Expunged"
        onConfirm={async () => {
          if (!(await stepUp())) return false
          const r = await expungeWebhookPayload(delivery.id)
          if (!r.ok) {
            toastError("Could not expunge the payload", { description: r.error })
            return false
          }
          return true
        }}
      />
    </>
  )
}
