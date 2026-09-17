"use client"

import * as React from "react"
import { Plus } from "lucide-react"
import { Button } from "@repo/ui/components/button"
import { Input } from "@repo/ui/components/input"
import { Label } from "@repo/ui/components/label"
import { Textarea } from "@repo/ui/components/textarea"
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
      <div className="space-y-2">
        <Label htmlFor="segment-name">Name</Label>
        <Input
          id="segment-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Paying customers"
          autoComplete="off"
          required
          autoFocus
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="segment-description">Description</Label>
        <Textarea
          id="segment-description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Who is in this and why"
          rows={2}
        />
      </div>
    </FormDialog>
  )
}
