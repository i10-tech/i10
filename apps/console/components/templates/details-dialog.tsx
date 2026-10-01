"use client"

import * as React from "react"
import { Badge } from "@repo/ui/components/badge"
import { CopyField } from "@repo/ui/components/copy"
import { ValidatedInput } from "@repo/ui/components/validated-field"
import { FormDialog } from "@/components/form-dialog"
import { Time } from "@/components/time"
import { updateTemplate } from "@/lib/actions"
import { useResetOnOpen } from "@/lib/react"
import { STATUS_LABEL, statusOf } from "@/lib/templates"
import type { DeclaredVariable, TemplateFolder, TemplateSummary } from "@/lib/types"

/** What an alias may be; the API holds the same rule. */
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * "View details": what a template is called, how code reaches it, and where
 * it stands - with the title and alias editable in place.
 *
 * ⚠ THE ALIAS CAN BREAK SENDS AND THE DIALOG SAYS SO. Code sends by id or by
 * alias; changing the alias is a rename of something production may name.
 */
export function TemplateDetailsDialog({
  template,
  folders,
  variables = [],
  open,
  onOpenChange,
  onSaved,
}: {
  template: TemplateSummary
  folders: TemplateFolder[]
  variables?: DeclaredVariable[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved?: (patch: { title: string | null; name: string }) => void
}) {
  const [title, setTitle] = React.useState(template.title ?? "")
  const [alias, setAlias] = React.useState(template.name)
  useResetOnOpen(open, () => {
    setTitle(template.title ?? "")
    setAlias(template.name)
  })

  const aliasProblem = (value: string) =>
    !ALIAS.test(value) || UUID_SHAPE.test(value)
      ? "Letters, digits, dots, dashes and underscores, like password-reset."
      : null
  const changed =
    title.trim() !== (template.title ?? "").trim() || alias.trim() !== template.name
  const status = statusOf(template)
  const folder = folders.find((f) => f.id === template.folder_id)

  const sample = Object.fromEntries(
    variables.map((v) => [v.name, v.type === "number" ? 0 : (v.fallback ?? "")]),
  )
  const snippet = [
    `import { I10 } from "@i10/node"`,
    ``,
    `const i10 = new I10(process.env.I10_API_KEY)`,
    ``,
    `await i10.emails.send({`,
    `  to: "ada@example.com",`,
    `  template: {`,
    `    id: ${JSON.stringify(alias.trim() || template.name)},`,
    ...(variables.length > 0
      ? [`    variables: ${JSON.stringify(sample, null, 2).replace(/\n/g, "\n    ")},`]
      : []),
    `  },`,
    `})`,
  ].join("\n")

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Template details"
      submitLabel="Save"
      doneLabel="Saved"
      canSubmit={changed && alias.trim() !== "" && aliasProblem(alias.trim()) === null}
      onSubmit={async () => {
        const patch = {
          title: title.trim() || null,
          ...(alias.trim() !== template.name ? { name: alias.trim() } : {}),
        }
        const result = await updateTemplate(template.id, patch)
        if (result.ok) onSaved?.({ title: patch.title, name: alias.trim() })
        return result
      }}
    >
      <ValidatedInput
        label="Name"
        id="details-title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        autoComplete="off"
        hint="What the team calls it. Change it any time."
      />
      <ValidatedInput
        label="Alias"
        id="details-alias"
        value={alias}
        onChange={(event) => setAlias(event.target.value)}
        autoComplete="off"
        className="font-mono text-xs"
        required="The alias cannot be empty."
        check={aliasProblem}
        hint={
          alias.trim() !== template.name
            ? "Code sending by the old alias will stop finding this template."
            : "Sends may name the template by this instead of its id."
        }
      />

      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">Template ID</p>
        <CopyField value={template.id} />
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-xs">
        <dt className="text-muted-foreground">Status</dt>
        <dd>
          <Badge variant={status === "published" ? "default" : "secondary"}>
            {STATUS_LABEL[status]}
          </Badge>
          {template.version > 0 && (
            <span className="ml-2 font-mono text-muted-foreground">
              v{template.version} live
            </span>
          )}
        </dd>
        <dt className="text-muted-foreground">Folder</dt>
        <dd>{folder?.name ?? "All templates"}</dd>
        <dt className="text-muted-foreground">Created</dt>
        <dd>
          <Time iso={template.created_at} mode="exact" />
        </dd>
        <dt className="text-muted-foreground">Last edited</dt>
        <dd>
          <Time iso={template.updated_at} mode="exact" />
        </dd>
      </dl>

      <div className="space-y-1.5">
        <p className="text-xs text-muted-foreground">Send it</p>
        <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
          {snippet}
        </pre>
      </div>
    </FormDialog>
  )
}
