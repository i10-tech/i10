"use client"

import * as React from "react"
import { CodeBlock as ArcCodeBlock } from "@repo/ui/components/code-block/code-block"
import { JsonViewer } from "@repo/ui/components/json-viewer/json-viewer"
import { Bone } from "@repo/ui/components/bone/bone"
import { cn } from "cn"

/**
 * A payload, a header dump or a response body, as text with a copy button.
 *
 * ⚠ ALWAYS TEXT. Every one of these is the customer's data or their
 * receiver's answer, so it goes into a `<pre>` and never near `innerHTML`.
 *
 * ⚠ CAPPED IN HEIGHT AND SCROLLED INSIDE. A 20KB response body would
 * otherwise push the attempts below it off the page.
 */
/**
 * A payload, a schema or a receiver's answer. JSON (the common case) opens in
 * Arc's JsonViewer: collapsible, searchable, copy a value or its path. Anything
 * else is shown verbatim in Arc's CodeBlock. Both render text as text, never
 * as markup, which matters for a receiver's response body.
 */
export function CodeBlock({
  value,
  label,
  className,
  empty = "Empty",
  loading = false,
}: {
  value: string
  label: string
  className?: string
  empty?: string
  loading?: boolean
}) {
  const parsed = React.useMemo(() => {
    if (loading) return undefined
    const text = value.trim()
    if (!text.startsWith("{") && !text.startsWith("[")) return undefined
    try {
      return { data: JSON.parse(text) as unknown }
    } catch {
      return undefined
    }
  }, [value, loading])

  // ⚠ THE WHOLE BLOCK IS THE BONE, empty state included: what it holds (a viewer, a
  // code block, "Empty") is the data's, and a skeleton cannot know which.
  return (
    <Bone
      id={`code-${label}`}
      as="div"
      shape="box"
      width="100%"
      height={160}
      radius={8}
      loading={loading || undefined}
    >
      {!value ? (
        <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
          {empty}
        </p>
      ) : (
        <div className={cn("min-w-0", className)}>
          {parsed ? (
            <JsonViewer
              data={parsed.data}
              label={label}
              rootName={label}
              maxHeight={384}
            />
          ) : (
            <ArcCodeBlock code={value} filename={label} language="text" maxLines={24} />
          )}
        </div>
      )}
    </Bone>
  )
}

export function HeaderList({
  headers,
  empty = "No headers",
}: {
  headers: Record<string, string> | null
  empty?: string
}) {
  const entries = Object.entries(headers ?? {})
  if (entries.length === 0) {
    return <p className="text-xs text-muted-foreground">{empty}</p>
  }
  return (
    <dl className="divide-y overflow-hidden rounded-lg border font-mono text-2xs">
      {entries.map(([name, value]) => (
        <div
          key={name}
          className="grid gap-x-4 px-3 py-1.5 sm:grid-cols-[minmax(0,14rem)_1fr]"
        >
          <dt className="truncate text-muted-foreground" title={name}>
            {name}
          </dt>
          <dd className="min-w-0 break-all">{value}</dd>
        </div>
      ))}
    </dl>
  )
}
