"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Trash2 } from "lucide-react"
import { Button } from "@repo/ui/components/button"
import { DeleteDomainDialog } from "@/components/delete-domain-dialog"

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
      {/*
       * ⚠ THE BORDER IS THE WHOLE SIGNAL, AND THE BOX IS NOT FILLED RED. A
       * panel flooded with colour reads as an error the page is currently in —
       * something has gone wrong — rather than as a control that is dangerous
       * to press. The border and the button carry the warning; the box itself
       * stays the same surface as every other section on the page.
       */}
      <div className="flex flex-col gap-4 rounded-xl border border-destructive/30 p-4 sm:flex-row sm:items-center sm:justify-between">
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
