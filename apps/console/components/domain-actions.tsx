"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Copy, SquareArrowOutUpRight, Trash2 } from "lucide-react"
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@repo/ui/components/dropdown-menu"
import { DeleteDomainDialog } from "@/components/delete-domain-dialog"
import { toastDone, toastError } from "@/lib/toast"
import { RowMenu } from "@/components/list/row-menu"

/**
 * Deleting a domain without opening it first.
 *
 * ⚠ THE SAME DROPDOWN-AND-CONFIRM AS EVERY OTHER LIST IN THIS CONSOLE. Topics
 * and segments already end their rows this way; a domain row that invented its
 * own affordance - an inline red button, a hover-revealed ✕ - would be a third
 * spelling of a thing people have already learned twice.
 *
 * ⚠ THE HIGHLIGHT ON THE ITEM USED TO BE A DIFFERENT SHAPE FROM THE PANEL
 * AROUND IT, AND IT WAS FIXED IN THE COMPONENT RATHER THAN HERE. A one-item
 * menu puts a 10px highlight inside an 18px panel with nothing between them,
 * which is where the mismatch became obvious - but it was wrong in every menu.
 * See dropdown-menu.tsx.
 *
 * ⚠ AND IT DELEGATES THE WHOLE DELETE TO THE SHARED DIALOG rather than
 * repeating it. A domain is not a topic: deleting one wants a step-up
 * re-authentication and a decision about the keys scoped to it, and a row menu
 * that quietly skipped either would be a cheaper delete reachable from a place
 * that takes less thought to get to. See delete-domain-dialog.tsx.
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
      <RowMenu label={name}>
        <DropdownMenuItem onSelect={() => router.push(`/domains/${id}`)}>
          <SquareArrowOutUpRight />
          Open
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() =>
            void navigator.clipboard.writeText(id).then(
              () => toastDone("Domain ID copied"),
              () => toastError("Could not copy the ID"),
            )
          }
        >
          <Copy />
          Copy ID
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
          <Trash2 />
          Delete domain
        </DropdownMenuItem>
      </RowMenu>

      <DeleteDomainDialog
        id={id}
        name={name}
        scopedKeys={scopedKeys}
        open={confirming}
        onOpenChange={setConfirming}
        // ⚠ NO `onDeleted`: THE LIST STAYS PUT. `deleteDomain` revalidates
        // `/domains`, so the row is already gone behind the dialog by the time
        // it closes - there is nowhere to go and nothing to re-read.
      />
    </>
  )
}
