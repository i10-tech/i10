"use client"

import * as React from "react"
import { toast } from "sonner"
import { ShieldCheck, Undo2 } from "lucide-react"
import { Button } from "@repo/ui/components/button"
import { FloatingInput, FloatingTextarea } from "@repo/ui/components/floating-field"
import { ValidatedInput } from "@repo/ui/components/validated-field"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { FormDialog } from "@/components/form-dialog"
import { submitTrustedTemplate, withdrawTrustedTemplate } from "@/lib/actions"
import { useResetOnOpen } from "@/lib/react"

/** Every `{{name}}` in the bodies, in order, once each. */
function placeholders(...bodies: string[]): string[] {
  const names = new Set<string>()
  for (const body of bodies)
    for (const m of body.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_.-]{0,63})\s*\}\}/g))
      names.add(m[1]!)
  return [...names]
}

/** `name=max, other=max` as the API's `holes`, or the first bad entry. */
function parseLimits(raw: string): Record<string, number> | { bad: string } {
  const out: Record<string, number> = {}
  for (const part of raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)) {
    const [name, max] = part.split("=").map((x) => x?.trim())
    if (!name || !max || !/^\d+$/.test(max)) return { bad: part }
    out[name] = Number(max)
  }
  return out
}

/**
 * Submitting a template for review (#222).
 *
 * ⚠ THE BODY IS PASTED AS IT IS SENT, WITH `{{name}}` WHERE VALUES GO. What
 * staff approve is everything else, byte for byte; the dialog says so, because
 * the commonest way to waste a review is to submit the template source (JSX,
 * Handlebars) instead of the HTML that actually goes out.
 *
 * ⚠ AND IT SAYS WHAT APPROVAL DOES NOT DO before anybody submits: bounces and
 * complaints still count, and bad ones take the approval away.
 */
export function SubmitTrustedTemplateButton() {
  const [open, setOpen] = React.useState(false)
  const [name, setName] = React.useState("")
  const [html, setHtml] = React.useState("")
  const [text, setText] = React.useState("")
  const [limits, setLimits] = React.useState("")

  useResetOnOpen(open, () => {
    setName("")
    setHtml("")
    setText("")
    setLimits("")
  })

  const found = placeholders(html, text)
  const parsed = parseLimits(limits)

  return (
    <FormDialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button size="sm" variant="outline">
          <ShieldCheck />
          Submit for review
        </Button>
      }
      title="Submit a template for review"
      description="Paste the email exactly as you send it, with {{name}} wherever a value goes. Once approved, mail that matches it exactly stops counting as repeated content. Bounces and spam complaints still count, and too many of them withdraw the approval."
      submitLabel="Submit"
      doneLabel="Submitted"
      canSubmit={name.trim().length > 0 && (html.trim() !== "" || text.trim() !== "")}
      onSubmit={async () => {
        if ("bad" in parsed) {
          return {
            ok: false,
            error: `"${parsed.bad}" is not name=number.`,
            name: "validation_error",
            status: 422,
          }
        }
        return submitTrustedTemplate({
          name: name.trim(),
          html: html === "" ? null : html,
          text: text === "" ? null : text,
          holes: parsed,
        })
      }}
    >
      <ValidatedInput
        label="Name"
        id="trusted-name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        autoComplete="off"
        required="Name this template."
        autoFocus
        hint="e.g. Password reset"
      />
      <FloatingTextarea
        label="HTML"
        id="trusted-html"
        value={html}
        onChange={(event) => setHtml(event.target.value)}
        rows={6}
        className="font-mono text-xs"
        hint="The rendered HTML, not the template source."
      />
      <FloatingTextarea
        label="Plain text"
        id="trusted-text"
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={3}
        className="font-mono text-xs"
        hint="Optional, if you send a text part."
      />
      <FloatingInput
        label="Longest value per placeholder"
        id="trusted-limits"
        value={limits}
        onChange={(event) => setLimits(event.target.value)}
        autoComplete="off"
        className="font-mono text-xs"
        state={"bad" in parsed ? "invalid" : "idle"}
        hint={
          found.length === 0
            ? "No {{placeholders}} yet: the whole email would be fixed."
            : `${found.map((n) => `{{${n}}}`).join(", ")} - 100 characters each unless set here, e.g. ${found[0]}=40`
        }
      />
    </FormDialog>
  )
}

/** Withdrawing a submission or an approval. */
export function WithdrawTrustedTemplate({ id, name }: { id: string; name: string }) {
  const [confirming, setConfirming] = React.useState(false)
  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Withdraw ${name}`}
        onClick={() => setConfirming(true)}
      >
        <Undo2 />
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Withdraw ${name}?`}
        description="Mail matching it is then treated like any other mail. To have it reviewed again, submit it again."
        confirmLabel="Withdraw"
        doneLabel="Withdrawn"
        onConfirm={async () => {
          const result = await withdrawTrustedTemplate(id)
          if (!result.ok) {
            toast.error("Could not withdraw the template", {
              description: result.error,
            })
            return false
          }
          return true
        }}
      />
    </>
  )
}
