"use client"

import { useEffect, useRef, useState } from "react"
import { cn } from "cn"

/*
 * Copies `value` and confirms in place: the two glyphs cross-fade and scale,
 * so the button never changes size and the confirmation is where the eye
 * already is. Resets after 1.6s.
 */
export function CopyButton({
  value,
  className,
  label = "Copy",
}: {
  value: string
  className?: string
  label?: string
}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1600)
    } catch {
      /* Clipboard can be refused (insecure context, permissions); the value is on screen to select by hand. */
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? "Copied" : label}
      className={cn(
        "relative inline-grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-fg-3 transition-colors duration-150 hover:bg-white/[0.06] hover:text-fg",
        className,
      )}
    >
      <svg
        viewBox="0 0 16 16"
        width="14"
        height="14"
        aria-hidden
        className={cn(
          "col-start-1 row-start-1 transition-[opacity,transform] duration-200",
          copied ? "scale-50 opacity-0" : "scale-100 opacity-100",
        )}
      >
        <rect
          x="5.25"
          y="5.25"
          width="8"
          height="8"
          rx="1.75"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
        />
        <path
          d="M10.5 3.5v-.25A1.75 1.75 0 0 0 8.75 1.5h-5.5A1.75 1.75 0 0 0 1.5 3.25v5.5c0 .97.78 1.75 1.75 1.75h.25"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
        />
      </svg>
      <svg
        viewBox="0 0 16 16"
        width="14"
        height="14"
        aria-hidden
        className={cn(
          "col-start-1 row-start-1 text-delivered transition-[opacity,transform] duration-200",
          copied ? "scale-100 opacity-100" : "scale-50 opacity-0",
        )}
      >
        <path
          d="m3.5 8.5 3 3 6-7"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  )
}
