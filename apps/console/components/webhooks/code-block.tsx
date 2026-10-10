import { CopyButton } from "@repo/ui/components/copy"
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
export function CodeBlock({
  value,
  label,
  className,
  empty = "Empty",
}: {
  value: string
  /** What is being copied, for the button's name. */
  label: string
  className?: string
  empty?: string
}) {
  if (!value) {
    return (
      <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
        {empty}
      </p>
    )
  }
  return (
    <div
      className={cn(
        "group/code relative min-w-0 rounded-lg border bg-muted/30",
        className,
      )}
    >
      <pre className="max-h-96 overflow-auto px-3 py-2.5 pr-10 font-mono text-2xs leading-relaxed whitespace-pre-wrap break-all">
        {value}
      </pre>
      <CopyButton
        value={value}
        label={`Copy ${label}`}
        className="absolute top-1.5 right-1.5"
      />
    </div>
  )
}

/** Header names and values, one per line, the way they went over the wire. */
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
