"use client"

import * as React from "react"
import { ValidatedInput } from "@repo/ui/components/validated-field"
import { FormDialog } from "@/components/form-dialog"
import { addressOf, fromProblem } from "@/components/template-editor/fields"
import { sendTemplateTest } from "@/lib/actions"
import { useResetOnOpen } from "@/lib/react"

/**
 * "Test email": the draft, to somebody's own inbox, through the real send
 * path - so it is signed, logged and checked like any send.
 *
 * ⚠ THE DRAFT, NOT WHAT IS LIVE: a test is how somebody checks what they are
 * about to publish. Variables get their fallbacks, or show as `{{ name }}`.
 *
 * ⚠ IT SAVES FIRST. A test of the draft as it was a second ago is a test of
 * the wrong email.
 */
export function TestEmailDialog({
  open,
  onOpenChange,
  templateId,
  defaultTo,
  templateFrom,
  verified,
  beforeSend,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  templateId: string
  defaultTo: string | null
  /** The template's own sender, used when it is valid. */
  templateFrom: string
  verified: string[]
  /** Saves the draft; false when it could not be saved. */
  beforeSend: () => Promise<boolean>
}) {
  const [to, setTo] = React.useState(defaultTo ?? "")
  const [from, setFrom] = React.useState("")
  const templateFromOk =
    templateFrom.trim() !== "" && fromProblem(templateFrom, verified) === null
  useResetOnOpen(open, () => {
    setTo(defaultTo ?? "")
    setFrom(templateFromOk ? templateFrom : "")
  })

  const list = to
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  const toProblem = (value: string) => {
    const items = value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    const bad = items.find((a) => addressOf(a) === null)
    if (bad) return `${bad} is not an email address.`
    if (items.length > 5) return "A test goes to at most five addresses."
    return null
  }
  const senderProblem = (value: string) => fromProblem(value, verified)

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Send a test email"
      description="The draft as it is now, with each variable's fallback filled in. It counts as a send."
      submitLabel="Send test"
      doneLabel="Sent"
      canSubmit={
        list.length > 0 &&
        toProblem(to) === null &&
        from.trim() !== "" &&
        senderProblem(from) === null
      }
      onSubmit={async () => {
        if (!(await beforeSend())) {
          return {
            ok: false as const,
            error: "The draft could not be saved, so no test was sent.",
            name: "save_failed",
            status: 0,
          }
        }
        return sendTemplateTest(templateId, {
          to: list,
          ...(from.trim() !== templateFrom.trim() ? { from: from.trim() } : {}),
        })
      }}
    >
      <ValidatedInput
        label="To"
        id="test-to"
        value={to}
        onChange={(e) => setTo(e.target.value)}
        autoComplete="email"
        autoFocus
        required="Who should the test go to?"
        check={toProblem}
        hint="Up to five addresses, separated by commas."
      />
      <ValidatedInput
        label="From"
        id="test-from"
        value={from}
        onChange={(e) => setFrom(e.target.value)}
        autoComplete="off"
        required="A test needs a sender on a verified domain."
        check={senderProblem}
        hint={
          templateFromOk
            ? "The template's sender."
            : templateFrom.trim()
              ? "The template's sender is not on a verified domain; this one is used for the test only."
              : "The template has no sender yet; this one is used for the test only."
        }
      />
    </FormDialog>
  )
}
