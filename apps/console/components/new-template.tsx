"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Plus } from "lucide-react"
import { Button } from "@repo/ui/components/button"
import { FloatingInput } from "@repo/ui/components/floating-field"
import { FormDialog } from "@/components/form-dialog"
import { createTemplate } from "@/lib/actions"
import { useResetOnOpen } from "@/lib/react"

/**
 * ⚠ THE FOLDER IS A PATH TYPED BY HAND, NOT A PICKER. Folders here are a flat
 * string column rendered as a tree — there is nothing to create and nothing to
 * choose from until one exists. A picker would have to offer "new folder…" as
 * its first option, which is a text field with extra steps.
 */
export function NewTemplateButton() {
  const router = useRouter()
  const [name, setName] = React.useState("")
  const [folder, setFolder] = React.useState("")
  const [open, setOpen] = React.useState(false)

  // ⚠ CLEARED WHEN IT OPENS, NOT WHEN IT CLOSES — emptying the fields on
  // close does it while the dialog is still animating out, which reads as
  // the input being wiped from under you. Adjusted during render rather
  // than in an effect; see lib/react.ts.
  useResetOnOpen(open, () => {
    setName("")
    setFolder("")
  })

  return (
    <FormDialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button size="sm">
          <Plus />
          New template
        </Button>
      }
      title="New template"
      description="Names are unique within a workspace — your code references this one by id, not by name."
      submitLabel="Create"
      canSubmit={name.trim().length > 0}
      onSubmit={() =>
        createTemplate({ name: name.trim(), folder: folder.trim() || null })
      }
      onSuccess={(template) => router.push(`/templates/${template.id}`)}
    >
      <FloatingInput
        label="Name"
        id="template-name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        autoComplete="off"
        className="font-mono text-xs"
        required
        autoFocus
        hint="e.g. password-reset"
      />
      <FloatingInput
        label="Folder"
        id="template-folder"
        value={folder}
        onChange={(event) => setFolder(event.target.value)}
        autoComplete="off"
        className="font-mono text-xs"
        hint="Optional. Use slashes to nest — it is only a label for the list."
      />
    </FormDialog>
  )
}
