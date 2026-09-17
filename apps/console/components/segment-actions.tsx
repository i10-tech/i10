"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { MoreHorizontal, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@repo/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/ui/components/dropdown-menu"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { deleteSegment } from "@/lib/actions"

/**
 * ⚠ DELETING A SEGMENT DELETES THE GROUPING, NOT THE PEOPLE. The dialog says so
 * explicitly, because "delete segment" reads to most people as "delete these
 * 4,000 contacts" — and hesitating over that is the correct instinct to reward
 * with an answer rather than to punish with ambiguity.
 */
export function SegmentActions({ id, name }: { id: string; name: string }) {
  const router = useRouter()
  const [confirming, setConfirming] = React.useState(false)

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${name}`}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
            <Trash2 />
            Delete segment
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete ${name}?`}
        description="The contacts in it are not deleted — only the grouping. Any broadcast already sent to this segment keeps its record."
        confirmLabel="Delete segment"
        onConfirm={async () => {
          const result = await deleteSegment(id)
          if (!result.ok) {
            toast.error("Could not delete the segment", { description: result.error })
            return false
          }
          toast.success(`${name} deleted`)
          router.refresh()
          return true
        }}
      />
    </>
  )
}
