"use client"

import * as React from "react"
import { CopyButton } from "@repo/ui/components/copy"
import { cn } from "cn"
import { templateVersion } from "@/lib/actions"
import type { TemplateVersionDetail } from "@/lib/types"

/**
 * The files a React Email version was made from: its entry and everything it
 * imports, as they were when the version was made.
 *
 * ⚠ THE SNAPSHOT, NOT THE REPOSITORY. A GitHub template's repository can be
 * force-pushed or deleted, and an upload has no other copy; what is shown here
 * is what the version stored, which is what rendered the email that went out.
 */
export function TemplateFiles({
  templateId,
  number,
}: {
  templateId: string
  number: number
}) {
  const [version, setVersion] = React.useState<TemplateVersionDetail | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [open, setOpen] = React.useState<string | null>(null)

  React.useEffect(() => {
    let current = true
    void templateVersion(templateId, number).then((result) => {
      if (!current) return
      if (result.ok) {
        setVersion(result.data)
        setOpen(result.data.path ?? "template.tsx")
      } else setError(result.error)
    })
    return () => {
      current = false
    }
  }, [templateId, number])

  if (error) return <p className="text-sm text-destructive">{error}</p>
  if (!version) return <div className="h-64 animate-pulse rounded-lg bg-muted/30" />

  const entry = version.path ?? "template.tsx"
  const files: Record<string, string> = {
    [entry]: version.source ?? "",
    ...version.files,
  }
  const paths = [entry, ...Object.keys(version.files ?? {}).sort()]
  const text = files[open ?? entry] ?? ""

  return (
    <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
      <ul className="space-y-0.5">
        {paths.map((path) => (
          <li key={path}>
            <button
              type="button"
              onClick={() => setOpen(path)}
              className={cn(
                "w-full truncate rounded-md px-2 py-1.5 text-left font-mono text-xs transition-colors duration-(--duration-instant) ease-(--ease-linear) hover:bg-muted/50",
                open === path && "bg-muted font-medium",
              )}
              title={path}
            >
              {path}
              {path === entry && (
                <span className="ml-2 text-2xs text-muted-foreground">entry</span>
              )}
            </button>
          </li>
        ))}
        {version.runtime && (
          <li className="px-2 pt-3 font-mono text-2xs break-all text-muted-foreground">
            Rendered with {version.runtime}
          </li>
        )}
      </ul>
      <div className="min-w-0 overflow-hidden rounded-2xl border">
        <div className="flex items-center justify-between border-b px-3 py-1.5">
          <p className="truncate font-mono text-xs">{open}</p>
          <CopyButton value={text} label="Copy" />
        </div>
        <pre className="max-h-[40rem] overflow-auto bg-muted/30 px-4 py-3 font-mono text-xs leading-relaxed">
          {text}
        </pre>
      </div>
    </div>
  )
}
