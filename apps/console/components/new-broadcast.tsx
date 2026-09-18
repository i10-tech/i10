"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Plus } from "lucide-react"
import { Button } from "@repo/ui/components/button"
import { FloatingInput } from "@repo/ui/components/floating-field"
import { FormDialog } from "@/components/form-dialog"
import { createBroadcast } from "@/lib/actions"
import { useResetOnOpen } from "@/lib/react"

/**
 * ⚠ IT ASKS FOR A NAME AND NOTHING ELSE, THEN OPENS THE EDITOR. A create dialog
 * that collected the subject, the segment, the from address and the body would
 * be the editor — in a box, with no preview, that loses everything if you press
 * escape. The name is the only field needed to have something to save.
 */
export function NewBroadcastButton() {
  const router = useRouter()
  const [name, setName] = React.useState("")
  const [open, setOpen] = React.useState(false)

  // ⚠ CLEARED WHEN IT OPENS, NOT WHEN IT CLOSES — emptying the fields on
  // close does it while the dialog is still animating out, which reads as
  // the input being wiped from under you. Adjusted during render rather
  // than in an effect; see lib/react.ts.
  useResetOnOpen(open, () => {})

  return (
    <FormDialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button size="sm">
          <Plus />
          New broadcast
        </Button>
      }
      title="New broadcast"
      description="An internal name, so you can find it later. Recipients never see it."
      submitLabel="Create draft"
      canSubmit={name.trim().length > 0}
      onSubmit={() => createBroadcast({ name: name.trim() })}
      onSuccess={(broadcast) => router.push(`/broadcasts/${broadcast.id}`)}
    >
      <FloatingInput
        label="Name"
        id="broadcast-name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        autoComplete="off"
        required
        autoFocus
        hint="e.g. March product update"
      />
    </FormDialog>
  )
}
