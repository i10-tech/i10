"use client"

import * as React from "react"
import { MoreHorizontal, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@repo/ui/components/button"
import { rowMenuClass } from "@/components/list/table"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/ui/components/dropdown-menu"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { deleteTopic } from "@/lib/actions"
import type { TopicRow } from "@/lib/types"

/**
 * ⚠ DELETING A TOPIC DESTROYS EVERY PREFERENCE RECORDED AGAINST IT, AND THAT IS
 * WHAT THE DIALOG LEADS WITH. Those rows are people's explicit answers; once
 * they are gone there is no way to prove somebody opted out, and re-creating a
 * topic with the same name starts everyone at the default again. This is the
 * one delete in the marketing section with a compliance consequence.
 */
export function TopicActions({ topic }: { topic: TopicRow }) {
  const [confirming, setConfirming] = React.useState(false)

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className={rowMenuClass}
            aria-label={`Actions for ${topic.name}`}
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
            <Trash2 />
            Delete topic
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete ${topic.name}?`}
        description="Every preference recorded against this topic is deleted with it - including the explicit opt-outs. You will have no record that those people asked not to receive it."
        confirmLabel="Delete topic"
        doneLabel="Deleted"
        confirmWord={topic.name}
        onConfirm={async () => {
          const result = await deleteTopic(topic.id)
          if (!result.ok) {
            toast.error("Could not delete the topic", { description: result.error })
            return false
          }
          return true
        }}
      />
    </>
  )
}
