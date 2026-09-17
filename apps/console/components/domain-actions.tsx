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
import { deleteDomain } from "@/lib/actions"

/**
 * ⚠ DELETING A DOMAIN STOPS ITS MAIL, SO IT ASKS FOR THE NAME. This is not
 * ceremony: the domain list is a table of similar-looking rows and the delete
 * is in a menu next to them. Typing the name is the difference between losing a
 * staging domain and losing production — and it is the only confirmation that
 * actually requires reading which row you are on.
 */
export function DomainActions({ id, name }: { id: string; name: string }) {
  const router = useRouter()
  const [confirming, setConfirming] = React.useState(false)

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Domain actions">
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

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete ${name}?`}
        description="Mail can no longer be sent from this domain, and its DNS records stop being served if it was delegated. Messages already sent keep their history."
        confirmLabel="Delete domain"
        confirmWord={name}
        onConfirm={async () => {
          const result = await deleteDomain(id)
          if (!result.ok) {
            toast.error("Could not delete the domain", { description: result.error })
            return false
          }
          toast.success(`${name} deleted`)
          router.push("/domains")
          return true
        }}
      />
    </>
  )
}
