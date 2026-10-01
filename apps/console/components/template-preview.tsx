"use client"

import * as React from "react"
import { RotateCcw } from "lucide-react"
import { Button } from "@repo/ui/components/button"
import { FloatingInput } from "@repo/ui/components/floating-field"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@repo/ui/components/tabs"
import { EmailFrame } from "@/components/email-frame"
import { previewTemplateVersion } from "@/lib/actions"
import { nest } from "@/lib/template-variables"
import type { TemplatePreview, TemplateVersionSummary } from "@/lib/types"

/**
 * A version as a send would produce it, with sample values somebody can edit.
 *
 * ⚠ THE PREVIEW IS THE SEND PATH, NOT A LOOKALIKE. The API fills the stored
 * skeleton with these values exactly as `POST /emails` would - same escaping,
 * same blocked URLs - so what is on screen is the email, not a re-render that
 * might differ from it.
 *
 * ⚠ THE VALUES ARE NOT SAVED. They are samples for looking; the version's own
 * samples (its `PreviewProps`, or the placeholders' names) come back with one
 * click, and nothing here changes what is sent.
 */
export function TemplatePreviewPanel({
  templateId,
  history,
  imagesFrom = null,
}: {
  templateId: string
  history: TemplateVersionSummary[]
  imagesFrom?: string | null
}) {
  const live = history.find((v) => v.live) ?? history[0]
  const [number, setNumber] = React.useState(live?.number ?? 0)
  const version = history.find((v) => v.number === number)
  const samples = React.useMemo(() => samplesOf(version), [version])
  const [values, setValues] = React.useState<Record<string, string>>(samples)
  const [preview, setPreview] = React.useState<TemplatePreview | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  // New version, new samples. Adjusted during render; see lib/react.ts.
  const [seen, setSeen] = React.useState(number)
  if (seen !== number) {
    setSeen(number)
    setValues(samples)
  }

  React.useEffect(() => {
    if (!version) return
    let current = true
    // ⚠ DEBOUNCED: one request per pause in typing, not per keystroke.
    const timer = setTimeout(async () => {
      const result = await previewTemplateVersion(
        templateId,
        version.number,
        nest(values),
      )
      if (!current) return
      if (result.ok) {
        setPreview(result.data)
        setError(null)
      } else setError(result.error)
    }, 250)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [templateId, version, values])

  if (!version) {
    return (
      <p className="rounded-lg border border-dashed px-4 py-12 text-center text-sm text-muted-foreground">
        Nothing to preview until there is a version.
      </p>
    )
  }

  const edited = Object.keys(samples).some((k) => values[k] !== samples[k])

  return (
    <div className="grid gap-6 lg:grid-cols-[18rem_1fr]">
      <aside className="space-y-4">
        <Select value={String(number)} onValueChange={(v) => setNumber(Number(v))}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {history.map((v) => (
              <SelectItem key={v.number} value={String(v.number)}>
                v{v.number}
                {v.live ? " · live" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {version.variables.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            This version takes no variables: every send is the same email.
          </p>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium">Variables</p>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-muted-foreground"
                onClick={() => setValues(samples)}
                disabled={!edited}
              >
                <RotateCcw />
                Samples
              </Button>
            </div>
            {version.variables.map((v) => (
              <FloatingInput
                key={v.path}
                id={`var-${v.path}`}
                label={v.path}
                className="font-mono text-xs"
                value={values[v.path] ?? ""}
                onChange={(event) =>
                  setValues((old) => ({ ...old, [v.path]: event.target.value }))
                }
                autoComplete="off"
              />
            ))}
          </div>
        )}
      </aside>

      <section className="min-w-0 overflow-hidden rounded-2xl border">
        <div className="border-b px-4 py-2.5">
          <p className="text-2xs text-muted-foreground">Subject</p>
          <p className="truncate text-sm">
            {preview?.subject || (
              <em className="text-muted-foreground">No subject: sends must give one</em>
            )}
          </p>
        </div>
        {error ? (
          <p className="px-4 py-12 text-center text-sm text-destructive">{error}</p>
        ) : (
          <Tabs
            defaultValue={
              version.kind === "html" && !preview?.html ? "text" : "preview"
            }
          >
            <div className="border-b px-2 py-1.5">
              <TabsList className="bg-transparent p-0">
                <TabsTrigger value="preview" disabled={!preview?.html}>
                  Preview
                </TabsTrigger>
                <TabsTrigger value="text" disabled={!preview?.text}>
                  Plain text
                </TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="preview" className="m-0">
              {preview?.html ? (
                <EmailFrame
                  imagesFrom={imagesFrom}
                  html={preview.html}
                  title={`v${number} preview`}
                  className="h-[36rem]"
                />
              ) : (
                <div className="h-[36rem] animate-pulse bg-muted/30" />
              )}
            </TabsContent>
            <TabsContent value="text" className="m-0">
              <pre className="max-h-[36rem] overflow-auto bg-muted/30 px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
                {preview?.text ?? ""}
              </pre>
            </TabsContent>
          </Tabs>
        )}
      </section>
    </div>
  )
}

/** A version's sample values, flat by dotted path. */
function samplesOf(v: TemplateVersionSummary | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const variable of v?.variables ?? [])
    out[variable.path] = variable.preview || variable.path
  return out
}
