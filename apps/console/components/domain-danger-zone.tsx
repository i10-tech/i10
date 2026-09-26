"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { ArrowRightLeft, Trash2 } from "lucide-react"
import { Button } from "@repo/ui/components/button"
import { DeleteDomainDialog } from "@/components/delete-domain-dialog"
import { TransferDomainDialog } from "@/components/transfer-domain-dialog"
import { cancelTransfer } from "@/lib/actions"
import { formatExact } from "@/lib/format"
import type { TransferOffer } from "@/lib/types"
import type { KeyImpact } from "@/components/transfer-domain-dialog"
import { toast } from "sonner"

/**
 * ⚠ IT IS A ZONE AT THE FOOT OF THE PAGE, NOT A ✕✕✕ MENU IN THE HEADER, AND
 * THE MENU IS WHY THIS EXISTS. One destructive item behind an unlabelled
 * affordance, sitting inches from "Verify", is a control somebody opens to see
 * what is in it — and the only thing in it deletes their mail. Putting it at
 * the bottom, behind its own heading, in its own red-bordered box, means
 * nobody arrives at it by browsing: reaching it takes scrolling past everything
 * the page is actually for, which is the correct amount of friction for the
 * one action here that cannot be undone.
 *
 * ⚠ THE LIST NOW HAS A ROW MENU THAT DELETES TOO, AND THAT DOES NOT CONTRADICT
 * THE PARAGRAPH ABOVE. The objection there is to an unlabelled menu next to
 * the page's primary action, where the only thing inside it is destructive; a
 * row menu in a table is a different affordance in a different place, and it
 * is how every other list in this console already offers a delete. Both go
 * through the same dialog, so the friction that matters — typing the name,
 * proving who you are, being asked about the keys — is identical either way.
 *
 * ⚠ AND EVERYTHING THAT MAKES THE DELETE SAFE MOVED TO THAT DIALOG rather than
 * being copied into the row menu. See delete-domain-dialog.tsx.
 */
export function DomainDangerZone({
  id,
  name,
  scopedKeys = [],
  keyImpact = [],
  ownEmails = [],
  offer = null,
}: {
  id: string
  name: string
  /** The live keys that can ONLY send from this domain. Filtered by the page. */
  scopedKeys?: { id: string; name: string }[]
  /** Every live key whose scope includes this domain, and what it would keep. */
  keyImpact?: KeyImpact[]
  /** The person's verified addresses, which the transfer dialog refuses. */
  ownEmails?: string[]
  /** The open transfer offer for this domain, if one has been made. */
  offer?: TransferOffer | null
}) {
  const router = useRouter()
  const [confirming, setConfirming] = React.useState(false)
  const [transferring, setTransferring] = React.useState(false)
  const [withdrawing, setWithdrawing] = React.useState(false)

  async function withdraw() {
    setWithdrawing(true)
    const result = await cancelTransfer(id)
    setWithdrawing(false)
    if (!result.ok) {
      toast.error("Could not withdraw the offer", { description: result.error })
      return
    }
    toast.success("Offer withdrawn")
    router.refresh()
  }

  return (
    <>
      {/*
       * ⚠ THE BORDER IS THE WHOLE SIGNAL, AND THE BOX IS NOT FILLED RED. A
       * panel flooded with colour reads as an error the page is currently in —
       * something has gone wrong — rather than as a control that is dangerous
       * to press. The border and the button carry the warning; the box itself
       * stays the same surface as every other section on the page.
       */}
      <div className="divide-y divide-destructive/20 rounded-xl border border-destructive/30">
        {/*
         * ⚠ TRANSFER FIRST, DELETE LAST. Both remove the domain from this
         * workspace; transfer is the one that keeps it working somewhere, so it
         * is the one reached first, and the irreversible one stays at the foot.
         */}
        <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
          {/*
           * ⚠ AN OPEN OFFER REPLACES THE BUTTON RATHER THAN SITTING BESIDE IT.
           * Making a second offer withdraws the first, so "Transfer" next to a
           * pending offer would be a way to cancel it without saying so.
           */}
          {offer ? (
            <>
              <div className="space-y-1">
                <p className="text-sm font-medium">Transfer pending</p>
                <p className="text-sm text-muted-foreground">
                  Offered to{" "}
                  <span className="font-mono text-foreground">
                    {offer.recipient_email}
                  </span>
                  . It keeps sending from here until they accept; the offer expires on{" "}
                  {formatExact(offer.expires_at)}.
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0 self-start sm:self-auto"
                onClick={withdraw}
                disabled={withdrawing}
              >
                Withdraw offer
              </Button>
            </>
          ) : (
            <>
              <div className="space-y-1">
                <p className="text-sm font-medium">Transfer this domain</p>
                <p className="text-sm text-muted-foreground">
                  Offer <span className="font-mono text-foreground">{name}</span> to
                  someone by email — in this workspace or any other. Its records and
                  verification go with it, so your DNS does not change; it stops sending
                  from here once they accept.
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0 self-start sm:self-auto"
                onClick={() => setTransferring(true)}
              >
                <ArrowRightLeft aria-hidden="true" />
                Transfer
              </Button>
            </>
          )}
        </div>

        <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <p className="text-sm font-medium">Delete this domain</p>
            <p className="text-sm text-muted-foreground">
              Mail can no longer be sent from{" "}
              <span className="font-mono text-foreground">{name}</span>, and its DNS
              records stop being served if it was delegated. Messages already sent keep
              their history. This cannot be undone.
            </p>
          </div>
          <Button
            variant="destructive"
            size="sm"
            className="shrink-0 self-start sm:self-auto"
            onClick={() => setConfirming(true)}
          >
            <Trash2 aria-hidden="true" />
            Delete domain
          </Button>
        </div>
      </div>

      <TransferDomainDialog
        id={id}
        name={name}
        keys={keyImpact}
        ownEmails={ownEmails}
        open={transferring}
        onOpenChange={setTransferring}
        // ⚠ THE PAGE STAYS. Nothing has moved yet; it re-reads to show the
        // pending offer in place of the button.
        onOffered={() => router.refresh()}
      />

      <DeleteDomainDialog
        id={id}
        name={name}
        scopedKeys={scopedKeys}
        open={confirming}
        onOpenChange={setConfirming}
        // ⚠ THE PAGE HAS TO LEAVE. It is a page about a domain that no longer
        // exists; refreshing it in place would render its own 404.
        onDeleted={() => router.push("/domains")}
      />
    </>
  )
}
