"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Folder, LayoutTemplate, Loader2, Plus, Upload } from "lucide-react"
import { Button } from "@repo/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@repo/ui/components/dropdown-menu"
import { NameDialog } from "@/components/templates/name-dialog"
import { UploadTemplatesDialog } from "@/components/upload-templates"
import { createTemplate, createTemplateFolder } from "@/lib/actions"
import { toastFailure } from "@/lib/toast"

/**
 * "New": a template, a folder, or files - Resend's menu, plus our upload.
 *
 * ⚠ A TEMPLATE OPENS THE EDITOR AT ONCE, with no dialog first. Resend's
 * "New -> Template" does the same: naming something you have not written yet
 * is a question nobody can answer well, and the editor's title is one click
 * away. Inside a folder, the template is made in that folder.
 *
 * ⚠ UPLOAD STAYS, AS ITS OWN ITEM, because it takes a whole folder of React
 * Email files at once - which the editor's "Upload HTML" (one email's HTML)
 * does not.
 */
export function NewTemplateMenu({ folderId = null }: { folderId?: string | null }) {
  const router = useRouter()
  const [creating, setCreating] = React.useState(false)
  const [folderOpen, setFolderOpen] = React.useState(false)
  const [uploadOpen, setUploadOpen] = React.useState(false)

  async function newTemplate() {
    if (creating) return
    setCreating(true)
    const result = await createTemplate({ kind: "visual", folder_id: folderId })
    if (!result.ok) {
      setCreating(false)
      toastFailure(result)
      return
    }
    router.push(`/templates/${encodeURIComponent(result.data.id)}/editor`)
  }

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button size="sm" disabled={creating}>
            {creating ? <Loader2 className="animate-spin" /> : <Plus />}
            New
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onSelect={() => void newTemplate()}>
            <LayoutTemplate />
            Template
            <DropdownMenuShortcut>T</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setFolderOpen(true)}>
            <Folder />
            Folder
            <DropdownMenuShortcut>F</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setUploadOpen(true)}>
            <Upload />
            Upload files…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <NewFolderDialog open={folderOpen} onOpenChange={setFolderOpen} />
      <UploadTemplatesDialog open={uploadOpen} onOpenChange={setUploadOpen} />
      <NewShortcuts
        onTemplate={() => void newTemplate()}
        onFolder={() => setFolderOpen(true)}
      />
    </>
  )
}

/**
 * `T` for a new template, `F` for a new folder, as the menu says - only when
 * nothing is being typed into and no dialog is open.
 */
function NewShortcuts({
  onTemplate,
  onFolder,
}: {
  onTemplate: () => void
  onFolder: () => void
}) {
  React.useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return
      const target = event.target as HTMLElement | null
      if (
        target?.closest(
          "input, textarea, select, [contenteditable=true], [role=dialog], [role=menu]",
        )
      )
        return
      if (document.querySelector("[role=dialog]")) return
      if (event.key === "t" || event.key === "T") {
        event.preventDefault()
        onTemplate()
      } else if (event.key === "f" || event.key === "F") {
        event.preventDefault()
        onFolder()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onTemplate, onFolder])
  return null
}

/** "Create folder": a name, then the folder opens. */
export function NewFolderDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: (id: string) => void
}) {
  return (
    <NameDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Create folder"
      description="Folders keep templates organised. Sends name a template by its id or alias, so moving one never changes what is sent."
      placeholder="e.g. Onboarding"
      submitLabel="Create folder"
      doneLabel="Created"
      onSubmit={(name) => createTemplateFolder(name)}
      onSuccess={(folder) => {
        onOpenChange(false)
        onCreated?.(folder.id)
      }}
    />
  )
}
