"use client"

import * as React from "react"
import { Play } from "lucide-react"
import { ActionButton } from "@repo/ui/components/action-button"
import { Button } from "@repo/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/ui/components/dropdown-menu"
import { Label } from "@repo/ui/components/label"
import {
  Section,
  SectionContent,
  SectionDescription,
  SectionTitle,
} from "@repo/ui/components/page"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select"
import { Spinner } from "@repo/ui/components/spinner"
import { Switch } from "@repo/ui/components/switch"
import { CodeEditor } from "@/components/template-editor/code-editor"
import { CodeBlock, HeaderList } from "@/components/webhooks/code-block"
import { tryWebhookTransformation, updateWebhook } from "@/lib/actions"
import { useOutcome } from "@/lib/outcome"
import { toastError } from "@/lib/toast"
import {
  TRANSFORMATION_STARTERS,
  prettyBody,
  starterFor,
  type StarterName,
} from "@/lib/webhooks"
import type { WebhookEndpoint, WebhookTransformationResult } from "@/lib/types"

/**
 * A function that reshapes each webhook before it is signed and sent (#302),
 * and a place to try it on an example before saving.
 *
 * ⚠ "TRY IT" SAVES NOTHING AND SENDS NOTHING. It runs the code in the same
 * sandbox the worker uses, on the catalog's example of the chosen event, and
 * shows exactly the request that would go out - or why it would not.
 *
 * ⚠ SAVING TRIES THE CODE TOO, on the API's side: code the worker would
 * refuse is refused here, with the same reason, rather than failing every
 * delivery after it is saved.
 *
 * ⚠ OFF KEEPS THE CODE. Turning a transformation off sends webhooks as they
 * are without losing what was written; removing it is a separate act.
 */
export function TransformationPanel({ endpoint }: { endpoint: WebhookEndpoint }) {
  const saved = endpoint.transformation
  const [code, setCode] = React.useState(
    saved?.code ?? TRANSFORMATION_STARTERS[starterFor(endpoint.url)].code,
  )
  const [enabled, setEnabled] = React.useState(saved?.enabled ?? true)
  const [eventType, setEventType] = React.useState(
    endpoint.events[0] ?? "email.delivered",
  )
  const [trying, setTrying] = React.useState(false)
  const [result, setResult] = React.useState<WebhookTransformationResult | null>(null)
  const [unavailable, setUnavailable] = React.useState<string | null>(null)
  const [editorKey, setEditorKey] = React.useState(0)
  const save = useOutcome()
  const remove = useOutcome()

  const dirty = !saved || saved.code !== code || saved.enabled !== enabled
  const suggested = starterFor(endpoint.url)

  async function tryIt() {
    setTrying(true)
    setUnavailable(null)
    const r = await tryWebhookTransformation(endpoint.id, {
      code,
      event_type: eventType,
    })
    setTrying(false)
    if (!r.ok) {
      // ⚠ A 503 IS OUR SANDBOX, NOT THEIR CODE, and says so in place of a result.
      if (r.status === 503) setUnavailable(r.error)
      else toastError("Could not try the transformation", { description: r.error })
      setResult(null)
      return
    }
    setResult(r.data)
  }

  function start(name: StarterName) {
    setCode(TRANSFORMATION_STARTERS[name].code)
    // The editor owns its document while typing; a new key starts it afresh.
    setEditorKey((k) => k + 1)
    setResult(null)
  }

  return (
    <div className="space-y-8">
      <Section className="pt-0">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <SectionTitle className="m-0">Transformation</SectionTitle>
            <SectionDescription className="max-w-2xl">
              A function that receives{" "}
              <code className="font-mono text-xs">
                {"{ payload, method, url, headers }"}
              </code>{" "}
              and returns it changed. It may change the payload, the method (POST, PUT
              or PATCH), the path and query, and your own headers. It runs with no
              network and 50ms of CPU, and the request is signed after it.
            </SectionDescription>
          </div>
          <label className="flex shrink-0 items-center gap-2 text-sm">
            <Switch checked={enabled} onCheckedChange={setEnabled} />
            {enabled ? "On" : "Off"}
          </label>
        </div>

        <SectionContent className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            {!saved && suggested !== "reshape" ? (
              <p className="text-xs text-muted-foreground">
                This URL looks like {suggested === "slack" ? "Slack" : "Discord"}, so
                the editor starts from a{" "}
                {TRANSFORMATION_STARTERS[suggested].label.toLowerCase()}.
              </p>
            ) : (
              <span />
            )}
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm">
                  Start from
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {(Object.keys(TRANSFORMATION_STARTERS) as StarterName[]).map((name) => (
                  <DropdownMenuItem key={name} onSelect={() => start(name)}>
                    {TRANSFORMATION_STARTERS[name].label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="i10-code h-80 overflow-hidden rounded-xl border bg-muted/20">
            <CodeEditor
              key={editorKey}
              value={code}
              onChange={setCode}
              language="javascript"
              label="Transformation code"
              hint="export default function handler(webhook) { return webhook }"
              className="h-full"
            />
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2">
            {saved && (
              <ActionButton
                variant="ghost"
                state={remove.state}
                onReset={remove.reset}
                pendingLabel="Remove"
                doneLabel="Removed"
                onClick={() =>
                  void remove.run(async () => {
                    const r = await updateWebhook(endpoint.id, { transformation: null })
                    if (!r.ok) {
                      toastError("Could not remove the transformation", {
                        description: r.error,
                      })
                      return false
                    }
                    return true
                  })
                }
              >
                Remove
              </ActionButton>
            )}
            <ActionButton
              state={save.state}
              onReset={save.reset}
              pendingLabel="Save"
              doneLabel="Saved"
              disabled={save.state === "idle" && (!dirty || code.trim() === "")}
              onClick={() =>
                void save.run(async () => {
                  const r = await updateWebhook(endpoint.id, {
                    transformation: { code, enabled },
                  })
                  if (!r.ok) {
                    toastError("Could not save the transformation", {
                      description: r.error,
                    })
                    return false
                  }
                  return true
                })
              }
            >
              Save
            </ActionButton>
          </div>
        </SectionContent>
      </Section>

      <Section>
        <SectionTitle>Try it</SectionTitle>
        <SectionDescription>
          Runs the code above on an example event and shows the request that would be
          sent. Nothing is saved or sent.
        </SectionDescription>
        <SectionContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-56 flex-1 space-y-1.5 sm:max-w-xs">
              <Label htmlFor="transform-event">Example event</Label>
              <Select value={eventType} onValueChange={setEventType}>
                <SelectTrigger
                  id="transform-event"
                  className="w-full font-mono text-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {endpoint.events.map((t) => (
                    <SelectItem key={t} value={t} className="font-mono text-xs">
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button onClick={tryIt} disabled={trying || code.trim() === ""}>
              {trying ? <Spinner /> : <Play />}
              Try it
            </Button>
          </div>

          {unavailable && (
            <p className="rounded-lg border border-warning/25 bg-warning/5 px-3 py-2 text-xs">
              {unavailable}
            </p>
          )}

          {result &&
            (result.ok ? (
              <div className="space-y-3 animate-in fade-in-0">
                <p className="flex flex-wrap items-baseline gap-2 font-mono text-xs">
                  <span className="rounded-md bg-success/10 px-1.5 py-0.5 font-medium text-success">
                    {result.request.method}
                  </span>
                  <span className="break-all">{result.request.url}</span>
                </p>
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground">Headers</p>
                  <HeaderList
                    headers={result.request.headers}
                    empty="No custom headers. The signing headers are added after."
                  />
                </div>
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground">Body</p>
                  <CodeBlock value={prettyBody(result.request.body)} label="body" />
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-danger/25 bg-danger/5 px-3 py-2 animate-in fade-in-0">
                <p className="text-xs font-medium text-danger">
                  This would fail the delivery
                </p>
                <pre className="mt-1 font-mono text-2xs whitespace-pre-wrap break-all">
                  {result.error}
                </pre>
              </div>
            ))}
        </SectionContent>
      </Section>
    </div>
  )
}
