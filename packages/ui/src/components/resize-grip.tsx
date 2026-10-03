"use client"

import * as React from "react"
import { cn } from "cn"

/**
 * A drag handle that resizes a textarea vertically, drawn inside its rounded
 * corner.
 *
 * ⚠ THE BROWSER'S OWN GRIP CANNOT BE USED ON A ROUNDED BOX. It is painted at
 * the textarea's square corner, which is outside the arc of a `rounded-xl`
 * border, so it hangs off the edge of the field; WebKit and Chrome also draw it
 * differently, and neither lets it be moved. So the textarea is `resize-none`
 * and this sits inside the curve instead.
 *
 * ⚠ THE LIMITS ARE THE TEXTAREA'S OWN `min-height` AND `max-height`. This only
 * writes `style.height`; CSS clamps it. Whoever renders the textarea decides
 * how small and how tall it may go, and dragging past either simply stops.
 *
 * ⚠ NOT FOCUSABLE AND HIDDEN FROM ASSISTIVE TECHNOLOGY. It is a pointer
 * convenience: the textarea scrolls, so nothing in it is unreachable without
 * dragging, and a tab stop on every text box would be one more for everybody.
 */
export function ResizeGrip({
  targetRef,
  className,
}: {
  targetRef: React.RefObject<HTMLTextAreaElement | null>
  className?: string
}) {
  const startRef = React.useRef<{ y: number; height: number } | null>(null)

  return (
    <span
      aria-hidden="true"
      className={cn(
        "absolute end-2 bottom-2 z-10 grid size-5 cursor-ns-resize touch-none place-items-center",
        "text-muted-foreground/60 transition-colors duration-(--duration-instant) ease-(--ease-linear) hover:text-foreground",
        className,
      )}
      onPointerDown={(event) => {
        const el = targetRef.current
        if (!el || event.button !== 0) return
        // Without this a drag selects the text it passes over.
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        startRef.current = {
          y: event.clientY,
          height: el.getBoundingClientRect().height,
        }
      }}
      onPointerMove={(event) => {
        const el = targetRef.current
        if (!el || !startRef.current) return
        // ⚠ NEVER NEGATIVE: a negative height is invalid CSS, so the browser
        // drops it and the box stays at its last size instead of stopping at
        // `min-height`. Zero is valid, and CSS clamps it up to the floor.
        const height = startRef.current.height + event.clientY - startRef.current.y
        el.style.height = `${Math.max(0, height)}px`
      }}
      onPointerUp={() => (startRef.current = null)}
      onPointerCancel={() => (startRef.current = null)}
    >
      <svg viewBox="0 0 10 10" className="size-2.5" fill="none">
        <path
          d="M9 1 1 9M9 5 5 9"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeLinecap="round"
        />
      </svg>
    </span>
  )
}

/** Both refs, so a component can keep its own while honouring the caller's. */
export function mergeRefs<T>(
  ...refs: (React.Ref<T> | undefined)[]
): React.RefCallback<T> {
  return (node) => {
    for (const ref of refs) {
      if (typeof ref === "function") ref(node)
      else if (ref) ref.current = node
    }
  }
}
