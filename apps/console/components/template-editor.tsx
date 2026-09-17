"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Save, Send, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@repo/ui/components/button"
import { Input } from "@repo/ui/components/input"
import { Label } from "@repo/ui/components/label"
import { Spinner } from "@repo/ui/components/spinner"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { HtmlEditor } from "@/components/html-editor"
import { deleteTemplate, publishTemplate, updateTemplate } from "@/lib/actions"
import type { TemplateRow } from "@/lib/types"
import { Time } from "@/components/time"

/**
 * Editing a template.
 *
 * ⚠ SAVE AND PUBLISH ARE TWO DIFFERENT BUTTONS, AND THAT IS THE WHOLE DESIGN OF
 * THIS RESOURCE. A template is referenced by id from production code that is
 * sending mail right now; a single "save" that also went live would mean every
 * half-finished edit reaching customers. `html` is what this editor shows and
 * `published_html` is what a send renders — publishing is the one operation
 * that copies one to the other.
 *
 * ⚠ AND THE STATE BETWEEN THEM IS MADE VISIBLE. "Unpublished changes" is the
 * condition somebody forgets they are in — they edit, save, close the tab, and
 * wonder for a week why the email has not changed.
 */
export function TemplateEditor({ template }: { template: TemplateRow }) {
  const router = useRouter()

  const [subject, setSubject] = React.useState(template.subject ?? "")
  const [html, setHtml] = React.useState(template.html ?? "")
  const [text, setText] = React.useState(template.text ?? "")
  const [saving, setSaving] = React.useState(false)
  const [publishing, setPublishing] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)

  const dirty =
    subject !== (template.subject ?? "") ||
    html !== (template.html ?? "") ||
    text !== (template.text ?? "")

  /*
   * ⚠ COMPARED AS ISO STRINGS, WHICH SORT LEXICOGRAPHICALLY AND CORRECTLY.
   * `Date.parse` on both sides would be equivalent and slower; what would NOT
   * work is comparing the rendered, localised forms, which is the version that
   * looks obviously right and silently is not.
   */
  const unpublished =
    template.published_at === null ||
    template.updated_at > template.published_at ||
    dirty

  async function save() {
    if (saving) return
    setSaving(true)
    const result = await updateTemplate(template.id, {
      subject: subject || null,
      html: html || null,
      text: text || null,
    })
    setSaving(false)

    if (!result.ok) {
      toast.error("Could not save", { description: result.error })
      return
    }
    toast.success("Saved as draft", {
      description: "Your live template has not changed yet.",
    })
    router.refresh()
  }

  async function publish() {
    if (publishing) return

    // ⚠ SAVED FIRST, BECAUSE PUBLISH COPIES WHAT IS STORED. Publishing with
    // unsaved edits in the textarea would push the PREVIOUS draft live and tell
    // the person it worked — the worst kind of success.
    if (dirty) {
      const saved = await updateTemplate(template.id, {
        subject: subject || null,
        html: html || null,
        text: text || null,
      })
      if (!saved.ok) {
        toast.error("Could not save before publishing", { description: saved.error })
        return
      }
    }

    setPublishing(true)
    const result = await publishTemplate(template.id)
    setPublishing(false)

    if (!result.ok) {
      toast.error("Could not publish", { description: result.error })
      return
    }

    toast.success(`Published v${result.data.version}`, {
      description: "Sends referencing this template now use the new content.",
    })
    router.refresh()
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="template-subject">Subject</Label>
        <Input
          id="template-subject"
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
          placeholder="Reset your password"
        />
      </div>

      <div className="space-y-2">
        <Label>Body</Label>
        <HtmlEditor
          html={html}
          text={text}
          onHtmlChange={setHtml}
          onTextChange={setText}
        />
      </div>

      <div className="sticky bottom-0 flex flex-wrap items-center gap-2 border-t bg-background py-3">
        <Button variant="outline" onClick={save} disabled={saving || !dirty}>
          {saving ? <Spinner /> : <Save />}
          Save draft
        </Button>

        <Button onClick={publish} disabled={publishing || !unpublished}>
          {publishing ? <Spinner /> : <Send />}
          Publish
        </Button>

        <span className="text-xs text-muted-foreground">
          {unpublished ? (
            <span className="text-warning">
              Unpublished changes — sends still use{" "}
              {template.published_at ? `v${template.version}` : "nothing"}
            </span>
          ) : (
            <>
              v{template.version} live since{" "}
              <Time iso={template.published_at!} mode="exact" />
            </>
          )}
        </span>

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
        confirmWord={template.name}
        onConfirm={async () => {
          const result = await deleteTemplate(template.id)
          if (!result.ok) {
            toast.error("Could not delete the template", { description: result.error })
            return false
          }
          toast.success(`${template.name} deleted`)
          router.push("/templates")
          return true
        }}
      />
    </div>
  )
}
