"use client"

import * as React from "react"
import { Send } from "lucide-react"
import { ActionButton } from "@repo/ui/components/action-button"
import { FloatingInput } from "@repo/ui/components/floating-field"
import { publishTemplate, updateTemplate } from "@/lib/actions"
import { useOutcome } from "@/lib/outcome"
import type { TemplateRow } from "@/lib/types"
import { toastError } from "@/lib/toast"

/**
 * The subject of a React Email template, which the file may not carry.
 *
 * ⚠ PUBLISHING A SUBJECT MAKES A VERSION WITHOUT THE SANDBOX. The new version
 * reuses the live rendering under the new subject (see `publish` in the API's
 * templates/store.ts), so it is instant and runs no code. A file that exports
 * `subject` sets it on its next upload or push, which is where a GitHub
 * template's subject is best kept.
 */
export function TemplateSubject({ template }: { template: TemplateRow }) {
  const [subject, setSubject] = React.useState(template.subject ?? "")
  const publishing = useOutcome()
  const dirty = subject !== (template.subject ?? "")

  async function publish() {
    if (publishing.state === "pending") return
    await publishing.run(async () => {
      const saved = await updateTemplate(template.id, { subject: subject || null })
      if (!saved.ok) {
        toastError("Could not save the subject", { description: saved.error })
        return false
      }
      const published = await publishTemplate(template.id)
      if (!published.ok) {
        toastError("Could not publish", { description: published.error })
        return false
      }
      return true
    })
  }

  return (
    <div className="flex max-w-2xl items-start gap-2">
      <FloatingInput
        label="Subject"
        id="template-subject"
        className="flex-1"
        value={subject}
        onChange={(event) => setSubject(event.target.value)}
        hint={
          template.source === "github"
            ? "Kept in the repository when the file exports `subject`; set here, it lasts until a push changes it."
            : "Use {{{ name }}} for variables. Or export `subject` from the file."
        }
      />
      <ActionButton
        variant="outline"
        className="mt-1"
        onClick={publish}
        state={publishing.state}
        onReset={publishing.reset}
        pendingLabel="Publish"
        doneLabel="Published"
        disabled={publishing.state === "idle" && !dirty}
      >
        <Send />
        Publish
      </ActionButton>
    </div>
  )
}
