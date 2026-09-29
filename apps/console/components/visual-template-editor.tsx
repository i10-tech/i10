"use client"

import * as React from "react"
import dynamic from "next/dynamic"
import { useRouter } from "next/navigation"
import { Save, Send, Trash2 } from "lucide-react"
import { toast } from "sonner"
import type { EmailEditorRef } from "@react-email/editor"
import { ActionButton } from "@repo/ui/components/action-button"
import { Button } from "@repo/ui/components/button"
import { FloatingInput } from "@repo/ui/components/floating-field"
import { Swap } from "@repo/ui/components/swap"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { Time } from "@/components/time"
import {
  deleteTemplate,
  publishTemplate,
  updateTemplate,
  uploadTemplateImage,
} from "@/lib/actions"
import { OUTCOME_HOLD_MS, useOutcome } from "@/lib/outcome"
import type { TemplateRow } from "@/lib/types"

const Canvas = dynamic(() => import("@/components/visual-editor-canvas"), {
  ssr: false,
  loading: () => (
    <div className="min-h-[32rem] animate-pulse rounded-lg border bg-muted/30" />
  ),
})

/**
 * Editing a visual template (#243): the React Email editor, a subject, and
 * the same Save draft / Publish split as the HTML editor.
 *
 * ⚠ SAVING STORES THE DOCUMENT AND WHAT THE EDITOR EXPORTS FROM IT, TOGETHER.
 * The document is what reopens here; the HTML and text are what publishing
 * makes a version from, by finding `{{ name }}` exactly as for an HTML
 * template. Saving one without the other would publish something the editor
 * no longer shows.
 *
 * ⚠ VARIABLES ARE TYPED AS `{{ name }}`, in text and in link addresses, as in
 * the HTML editor - so a template moves between the two without its sends
 * changing, and the preview tab fills them exactly as a send will.
 */
export function VisualTemplateEditor({ template }: { template: TemplateRow }) {
  const router = useRouter()
  const editor = React.useRef<EmailEditorRef | null>(null)
  const [subject, setSubject] = React.useState(template.subject ?? "")
  const [bodyDirty, setBodyDirty] = React.useState(false)
  const saving = useOutcome()
  const publishing = useOutcome()
  const [deleting, setDeleting] = React.useState(false)

  const dirty = bodyDirty || subject !== (template.subject ?? "")
  const unpublished =
    template.published_at === null ||
    template.updated_at > template.published_at ||
    dirty

  async function save(): Promise<boolean> {
    const ref = editor.current
    if (!ref) return false
    const { html, text } = await ref.getEmail()
    const result = await updateTemplate(template.id, {
      subject: subject || null,
      /*
       * ⚠ A PLAIN JSON COPY, NOT THE EDITOR'S OBJECT. TipTap's attribute
       * objects are not plain objects, and a server action serializes those
       * as temporary references (`"$T"`) that arrive on the server as nothing
       * - every heading level, link and alignment silently dropped from the
       * saved document.
       */
      design: JSON.parse(JSON.stringify(ref.getJSON())) as Record<string, unknown>,
      html,
      text,
    })
    if (!result.ok) {
      toast.error("Could not save", { description: result.error })
      return false
    }
    setBodyDirty(false)
    return true
  }

  return (
    <div className="space-y-6">
      <FloatingInput
        label="Subject"
        id="template-subject"
        value={subject}
        onChange={(event) => setSubject(event.target.value)}
        hint="e.g. Welcome to Acme, {{ name }}"
      />

      <Canvas
        design={template.design ?? null}
        onReady={(ref) => (editor.current = ref)}
        onChange={(ref) => {
          editor.current = ref
          setBodyDirty(true)
        }}
        onUploadImage={async (file) => {
          const form = new FormData()
          form.append("file", file)
          const result = await uploadTemplateImage(form)
          if (!result.ok) {
            // ⚠ THROWN AFTER SAYING WHY: the editor removes the placeholder
            // it inserted for the upload when this rejects.
            toast.error("Could not add the image", { description: result.error })
            throw new Error(result.error)
          }
          return { url: result.data.url }
        }}
      />

      <div className="sticky bottom-0 flex flex-wrap items-center gap-2 border-t bg-background py-3">
        <ActionButton
          variant="outline"
          onClick={() => saving.state !== "pending" && saving.run(save)}
          state={saving.state}
          onReset={saving.reset}
          pendingLabel="Save draft"
          doneLabel="Saved"
          disabled={saving.state === "idle" && !dirty}
        >
          <Save />
          Save draft
        </ActionButton>

        <ActionButton
          onClick={() =>
            publishing.state !== "pending" &&
            publishing.run(async () => {
              // ⚠ SAVED FIRST: publishing copies what is stored.
              if (dirty && !(await save())) return false
              const result = await publishTemplate(template.id)
              if (!result.ok) {
                toast.error("Could not publish", { description: result.error })
                return false
              }
              return true
            })
          }
          state={publishing.state}
          onReset={publishing.reset}
          pendingLabel="Publish"
          doneLabel="Published"
          disabled={publishing.state === "idle" && !unpublished}
        >
          <Send />
          Publish
        </ActionButton>

        <Swap
          id={unpublished ? "draft" : `live-${template.version}`}
          className="text-xs text-muted-foreground"
        >
          {unpublished ? (
            <span className="text-warning">
              Unpublished changes - sends still use{" "}
              {template.published_at ? `v${template.version}` : "nothing"}
            </span>
          ) : (
            <>
              v{template.version} live since{" "}
              <Time iso={template.published_at!} mode="exact" />
            </>
          )}
        </Swap>

        <Button
          variant="ghost"
          size="sm"
          className="ml-auto text-muted-foreground"
          onClick={() => setDeleting(true)}
        >
          <Trash2 />
          Delete
        </Button>
      </div>

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${template.name}?`}
        description="Any send referencing this template id will start failing. Check your code before deleting it."
        confirmLabel="Delete template"
        doneLabel="Deleted"
        confirmWord={template.name}
        onConfirm={async () => {
          const result = await deleteTemplate(template.id)
          if (!result.ok) {
            toast.error("Could not delete the template", { description: result.error })
            return false
          }
          setTimeout(() => router.push("/templates"), OUTCOME_HOLD_MS)
          return true
        }}
      />
    </div>
  )
}
