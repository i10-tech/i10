"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Trash2 } from "lucide-react"
import { Button } from "@repo/ui/components/button"
import { DeleteDomainDialog } from "@/components/delete-domain-dialog"

/**
 * Deleting a domain without opening it first.
 *
 * ⚠ IT WAS A ✕✕✕ MENU AND THE MENU IS GONE, BECAUSE A ONE-ITEM MENU LOOKS LIKE
 * A MISTAKE. The item takes `bg-destructive/20` on focus, so a panel holding
 * nothing else renders as a solid red pill hanging off the row — the shape of
 * an error, not of a control. The menu was there for consistency with topics
 * and segments; those have the same single item and the same problem, and
 * matching them was not worth shipping a row that reads as broken.
 *
 * ⚠ THE ICON IS MUTED UNTIL IT IS TOUCHED. Destructive red in every row of a
 * table is a warning that is always on, which is a warning nobody reads; it
 * earns the colour on hover and focus, at the moment somebody is about to
 * press it.
 *
 * ⚠ AND IT DELEGATES THE WHOLE DELETE TO THE SHARED DIALOG rather than
 * repeating it. A domain is not a topic: deleting one wants a step-up
 * re-authentication and a decision about the keys scoped to it, and a row
 * control that quietly skipped either would be a cheaper delete reachable from
 * a place that takes less thought to get to. See delete-domain-dialog.tsx.
 */
export function DomainActions({
  id,
  name,
  scopedKeys = [],
}: {
  id: string
  name: string
  /** The live keys that can ONLY send from this domain. Filtered by the page. */
  scopedKeys?: { id: string; name: string }[]
}) {
  const router = useRouter()
  const [confirming, setConfirming] = React.useState(false)

  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        /*
         * ⚠ THE LABEL NAMES THE DOMAIN AND THE ACTION. There is one of these
         * per row: "Delete" repeated nine times tells a screen reader nothing
         * about which row it is on, and an icon alone tells it nothing at all.
         */
        aria-label={`Delete ${name}`}
        title={`Delete ${name}`}
        className="text-muted-foreground hover:text-destructive focus-visible:text-destructive"
        onClick={() => setConfirming(true)}
      >
        <Trash2 />
      </Button>

      <DeleteDomainDialog
        id={id}
        name={name}
        scopedKeys={scopedKeys}
        open={confirming}
        onOpenChange={setConfirming}
        // ⚠ THE LIST STAYS PUT AND RE-READS ITSELF. Unlike the domain page,
        // there is nowhere to go — the row simply stops being there.
        onDeleted={() => router.refresh()}
      />
    </>
  )
}
