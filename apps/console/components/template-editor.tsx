"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Save, Send, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { ActionButton } from "@repo/ui/components/action-button"
import { Button } from "@repo/ui/components/button"
import { Label } from "@repo/ui/components/label"
import { Swap } from "@repo/ui/components/swap"
import { FloatingInput } from "@repo/ui/components/floating-field"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { HtmlEditor } from "@/components/html-editor"
import { deleteTemplate, publishTemplate, updateTemplate } from "@/lib/actions"
import { OUTCOME_HOLD_MS, useOutcome } from "@/lib/outcome"
import type { TemplateRow } from "@/lib/types"
import { Time } from "@/components/time"

/**
 * Editing a template.
 *
 * ⚠ SAVE AND PUBLISH ARE TWO DIFFERENT BUTTONS, AND THAT IS THE WHOLE DESIGN OF
 * THIS RESOURCE. A template is referenced by id from production code that is
 * sending mail right now; a single "save" that also went live would mean every
 * half-finished edit reaching customers. `html` is what this editor shows and
 * `published_html` is what a send renders - publishing is the one operation
 * that copies one to the other.
 *
 * ⚠ AND THE STATE BETWEEN THEM IS MADE VISIBLE. "Unpublished changes" is the
 * condition somebody forgets they are in - they edit, save, close the tab, and
 * wonder for a week why the email has not changed.
 */
export function TemplateEditor({ template }: { template: TemplateRow }) {
  const router = useRouter()

  const [subject, setSubject] = React.useState(template.subject ?? "")
  const [html, setHtml] = React.useState(template.html ?? "")
  const [text, setText] = React.useState(template.text ?? "")
  const saving = useOutcome()
  const publishing = useOutcome()
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

  /*
   * ⚠ BOTH ANSWER IN THE BUTTON, AND THE STATUS LINE BESIDE THEM SAYS THE REST.
   * "Saved as draft - your live template has not changed yet" was a toast
   * restating what the line next to the button already reads: "Unpublished
   * changes - sends still use v3". Publishing is the same: the line flips to
   * "v4 live since …" as the tick lands. See lib/outcome.ts.
   */
  async function save() {
    if (saving.state === "pending") return
    await saving.run(async () => {
      const result = await updateTemplate(template.id, {
        subject: subject || null,
        html: html || null,
        text: text || null,
      })
      if (!result.ok) {
        toast.error("Could not save", { description: result.error })
        return false
      }
      return true
    })
  }

  async function publish() {
    if (publishing.state === "pending") return

    // ⚠ SAVED FIRST, BECAUSE PUBLISH COPIES WHAT IS STORED. Publishing with
    // unsaved edits in the textarea would push the PREVIOUS draft live and tell
    // the person it worked - the worst kind of success.
    await publishing.run(async () => {
      if (dirty) {
        const saved = await updateTemplate(template.id, {
          subject: subject || null,
          html: html || null,
          text: text || null,
        })
        if (!saved.ok) {
          toast.error("Could not save before publishing", { description: saved.error })
          return false
        }
      }

      const result = await publishTemplate(template.id)
      if (!result.ok) {
        toast.error("Could not publish", { description: result.error })
        return false
      }
      return true
    })
  }

  return (
    <div className="space-y-6">
      <FloatingInput
        label="Subject"
        id="template-subject"
        value={subject}
        onChange={(event) => setSubject(event.target.value)}
        hint="e.g. Reset your password"
      />

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
        {/*
         * ⚠ "DONE" OUTRANKS "NOTHING TO SAVE". The save lands, `dirty` goes
         * false, and a button disabled by it would grey out underneath its
         * own tick - the confirmation drawn as if it were unavailable.
         */}
        <ActionButton
          variant="outline"
          onClick={save}
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
          onClick={publish}
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
          // ⚠ THE NAVIGATION IS THE CONFIRMATION'S EXIT, NOT A SECOND ONE. The
          // tick holds, then this page - dialog and all - is replaced by the
          // list without it. A toast on top would announce what the list shows.
          setTimeout(() => router.push("/templates"), OUTCOME_HOLD_MS)
          return true
        }}
      />
    </div>
  )
}
