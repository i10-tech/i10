"use client"

import * as React from "react"
import { Plus } from "lucide-react"
import { Button } from "@repo/ui/components/button"
import { FloatingTextarea } from "@repo/ui/components/floating-field"
import { ValidatedInput } from "@repo/ui/components/validated-field"
import { FormDialog } from "@/components/form-dialog"
import { createSegment } from "@/lib/actions"
import { useResetOnOpen } from "@/lib/react"

export function NewSegmentButton() {
  const [name, setName] = React.useState("")
  const [description, setDescription] = React.useState("")
  const [open, setOpen] = React.useState(false)

  // ⚠ CLEARED WHEN IT OPENS, NOT WHEN IT CLOSES — emptying the fields on
  // close does it while the dialog is still animating out, which reads as
  // the input being wiped from under you. Adjusted during render rather
  // than in an effect; see lib/react.ts.
  useResetOnOpen(open, () => {
    setName("")
    setDescription("")
  })

  return (
    <FormDialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button size="sm">
          <Plus />
          New segment
        </Button>
      }
      title="Create a segment"
      description="An internal grouping. Recipients never see it — use a topic for anything they should be able to opt out of."
      canSubmit={name.trim().length > 0}
      successMessage="Segment created"
      onSubmit={() =>
        createSegment({ name: name.trim(), description: description.trim() })
      }
    >
      <ValidatedInput
        label="Name"
        id="segment-name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        autoComplete="off"
        required="Name this segment."
        autoFocus
        hint="e.g. Paying customers"
      />
      <FloatingTextarea
        label="Description"
        id="segment-description"
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        rows={2}
        hint="e.g. Who is in this and why"
      />
    </FormDialog>
  )
}
