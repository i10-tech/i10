"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { MoreHorizontal, Trash2 } from "lucide-react"
import { Button } from "@repo/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/ui/components/dropdown-menu"
import { DeleteDomainDialog } from "@/components/delete-domain-dialog"

/**
 * Deleting a domain without opening it first.
 *
 * ⚠ THE SAME DROPDOWN-AND-CONFIRM AS EVERY OTHER LIST IN THIS CONSOLE. Topics
 * and segments already end their rows this way; a domain row that invented its
 * own affordance — an inline red button, a hover-revealed ✕ — would be a third
 * spelling of a thing people have already learned twice.
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
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {/*
           * ⚠ THE LABEL NAMES THE DOMAIN, because there is one of these per
           * row and "Actions" repeated nine times tells a screen reader
           * nothing about which row it is on.
           */}
          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${name}`}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
            <Trash2 />
            Delete domain
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

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
