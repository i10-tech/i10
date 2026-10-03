"use client"

import * as React from "react"
import { Trash2 } from "lucide-react"
import { DropdownMenuItem } from "@repo/ui/components/dropdown-menu"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { deleteSegment } from "@/lib/actions"
import { toastError } from "@/lib/toast"
import { RowMenu } from "@/components/list/row-menu"

/**
 * ⚠ DELETING A SEGMENT DELETES THE GROUPING, NOT THE PEOPLE. The dialog says so
 * explicitly, because "delete segment" reads to most people as "delete these
 * 4,000 contacts" - and hesitating over that is the correct instinct to reward
 * with an answer rather than to punish with ambiguity.
 */
export function SegmentActions({ id, name }: { id: string; name: string }) {
  const [confirming, setConfirming] = React.useState(false)

  return (
    <>
      <RowMenu label={name}>
        <DropdownMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
          <Trash2 />
          Delete segment
        </DropdownMenuItem>
      </RowMenu>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete ${name}?`}
        description="The contacts in it are not deleted - only the grouping. Any broadcast already sent to this segment keeps its record."
        confirmLabel="Delete segment"
        doneLabel="Deleted"
        confirmWord={name}
        onConfirm={async () => {
          const result = await deleteSegment(id)
          if (!result.ok) {
            toastError("Could not delete the segment", { description: result.error })
            return false
          }
          return true
        }}
      />
    </>
  )
}
