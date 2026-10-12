"use client"

import { useRef, type ComponentProps, type ReactNode } from "react"
import { cn } from "cn"
import { CopyButton } from "../copy-button/copy-button"

/**
 * A value somebody copies into another screen: an API key, a DNS record, an
 * id. The value sits on Arc's muted surface; the copy control is Arc's
 * CopyButton, which confirms "Copied" in place.
 *
 * Mono by default: values are compared by eye, and in a proportional face
 * `l`, `1` and `I` are one glyph.
 *
 * ⚠ THE VALUE ITSELF COPIES TOO (2026-10-12). Clicking the text is where
 * people aim; it presses the copy button, so the same "Copied" tick answers.
 * Selecting part of it with a drag still selects instead of copying.
 */
export function CopyField({
  value,
  display,
  label = "Copy",
  className,
  mono = true,
  truncate = true,
  ...props
}: Omit<ComponentProps<"div">, "children"> & {
  value: string
  display?: ReactNode
  label?: string
  mono?: boolean
  truncate?: boolean
}) {
  const box = useRef<HTMLDivElement>(null)
  return (
    <div
      ref={box}
      data-slot="copy-field"
      className={cn(
        "flex min-w-0 items-center gap-1 rounded-lg border border-border bg-muted py-1 pr-1 pl-3",
        className,
      )}
      {...props}
    >
      <span
        onClick={() => {
          // A drag that selected some of it is a selection, not a copy.
          if (window.getSelection()?.toString()) return
          box.current?.querySelector("button")?.click()
        }}
        className={cn(
          "min-w-0 flex-1 cursor-pointer text-sm text-foreground",
          mono && "font-mono text-xs",
          truncate && "truncate",
        )}
        title={typeof display === "string" || display === undefined ? value : undefined}
      >
        {display ?? value}
      </span>
      <CopyButton value={value} label={label} iconOnly variant="plain" />
    </div>
  )
}
