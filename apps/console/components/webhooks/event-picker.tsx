"use client"

import * as React from "react"
import { ChevronRight } from "lucide-react"
import { Checkbox } from "@repo/ui/components/checkbox"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@repo/ui/components/tabs"
import { cn } from "cn"
import { CodeBlock } from "@/components/webhooks/code-block"
import { prettyJson } from "@/lib/webhooks"
import type { WebhookEventType } from "@/lib/types"

/**
 * Which events an endpoint is subscribed to, from the catalog (#283).
 *
 * ⚠ THE CATALOG IS THE API'S, NOT A LIST IN THIS APP. It used to be six
 * hand-copied names while the API accepted twelve, so opens, clicks and the
 * endpoint's own health events could not be chosen here at all.
 *
 * ⚠ GROUPED BY WHAT THE EVENT IS ABOUT. Mail events and the events about your
 * own endpoints answer different questions, and the second group belongs on
 * a separate endpoint - an endpoint is never sent events about itself.
 *
 * ⚠ EACH ONE OPENS ON ITS SCHEMA AND AN EXAMPLE, because "what will my handler
 * receive" is the next question after "which events", and the answer is here
 * rather than in the docs.
 */
export function EventPicker({
  catalog,
  value,
  onChange,
  disabled = false,
}: {
  catalog: WebhookEventType[]
  value: string[]
  onChange: (next: string[]) => void
  disabled?: boolean
}) {
  const [open, setOpen] = React.useState<string | null>(null)
  const groups = [
    {
      label: "Email",
      types: catalog.filter((t) => t.type.startsWith("email.")),
    },
    {
      label: "Your endpoints",
      types: catalog.filter((t) => !t.type.startsWith("email.")),
    },
  ].filter((g) => g.types.length > 0)

  const toggle = (type: string, on: boolean) =>
    onChange(on ? [...value, type] : value.filter((v) => v !== type))

  return (
    <div className="space-y-4">
      {groups.map((group) => {
        const all = group.types.every((t) => value.includes(t.type))
        return (
          <fieldset key={group.label} className="overflow-hidden rounded-xl border">
            <legend className="sr-only">{group.label}</legend>
            <label className="flex cursor-pointer items-center gap-2.5 border-b bg-muted/30 px-3 py-2">
              <Checkbox
                checked={all}
                disabled={disabled}
                onCheckedChange={(checked) => {
                  const names = group.types.map((t) => t.type)
                  onChange(
                    checked
                      ? [...new Set([...value, ...names])]
                      : value.filter((v) => !names.includes(v)),
                  )
                }}
              />
              <span className="text-xs font-medium">{group.label}</span>
              <span className="tabular ml-auto text-2xs text-muted-foreground">
                {group.types.filter((t) => value.includes(t.type)).length} of{" "}
                {group.types.length}
              </span>
            </label>
            <ul className="divide-y">
              {group.types.map((t) => {
                const expanded = open === t.type
                return (
                  <li key={t.type}>
                    <div className="flex items-start gap-2.5 px-3 py-2.5">
                      <Checkbox
                        id={`event-${t.type}`}
                        checked={value.includes(t.type)}
                        disabled={disabled}
                        onCheckedChange={(checked) => toggle(t.type, checked === true)}
                        className="mt-0.5"
                      />
                      <label
                        htmlFor={`event-${t.type}`}
                        className="min-w-0 flex-1 cursor-pointer"
                      >
                        <span className="block font-mono text-xs">{t.type}</span>
                        <span className="block text-xs text-muted-foreground">
                          {t.description}
                        </span>
                      </label>
                      <button
                        type="button"
                        onClick={() => setOpen(expanded ? null : t.type)}
                        aria-expanded={expanded}
                        aria-label={`${expanded ? "Hide" : "Show"} the schema for ${t.type}`}
                        className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        v{t.version}
                        <ChevronRight
                          className={cn(
                            "size-3 transition-transform duration-200",
                            expanded && "rotate-90",
                          )}
                        />
                      </button>
                    </div>
                    {expanded && <EventDetail type={t} />}
                  </li>
                )
              })}
            </ul>
          </fieldset>
        )
      })}
    </div>
  )
}

function EventDetail({ type }: { type: WebhookEventType }) {
  return (
    <Tabs
      defaultValue="example"
      className="border-t bg-muted/20 px-3 pt-2 pb-3 animate-in fade-in-0"
    >
      <TabsList variant="pill" className="mb-2">
        <TabsTrigger value="example">Example</TabsTrigger>
        <TabsTrigger value="schema">Schema</TabsTrigger>
      </TabsList>
      <TabsContent value="example" className="m-0">
        <CodeBlock value={prettyJson(type.example)} label={`${type.type} example`} />
      </TabsContent>
      <TabsContent value="schema" className="m-0">
        <CodeBlock value={prettyJson(type.schema)} label={`${type.type} schema`} />
      </TabsContent>
    </Tabs>
  )
}
