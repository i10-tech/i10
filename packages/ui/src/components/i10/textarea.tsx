"use client"

import * as React from "react"
import { cn } from "cn"
import { mergeRefs, ResizeGrip } from "./resize-grip"

/**
 * A plain textarea - for code and other text that has no floating label. Forms
 * want `FloatingTextarea`.
 *
 * ⚠ IT RESIZES WITH `ResizeGrip`, NOT THE BROWSER'S GRIP, which hangs outside a
 * rounded corner - see resize-grip.tsx. `resizable={false}` drops it, for a box
 * inside something else that owns the layout (`InputGroupTextarea`).
 *
 * ⚠ AND IT HAS A CEILING AS WELL AS A FLOOR. It grows with its content, and
 * without `max-h-80` a pasted template made a box taller than the screen; past
 * the ceiling it scrolls. Callers that want a taller editor raise both.
 */
function Textarea({
  className,
  resizable = true,
  ref,
  ...props
}: React.ComponentProps<"textarea"> & { resizable?: boolean }) {
  const own = React.useRef<HTMLTextAreaElement>(null)

  const textarea = (
    <textarea
      ref={mergeRefs(own, ref)}
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 max-h-80 w-full resize-none rounded-xl border border-input bg-transparent px-3 py-2 text-base shadow-xs transition-[color,border-color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger in-data-[outcome=done]:border-success! md:text-sm",
        className,
      )}
      {...props}
    />
  )

  if (!resizable) return textarea
  return (
    <div className="relative w-full">
      {textarea}
      <ResizeGrip targetRef={own} />
    </div>
  )
}

export { Textarea }
