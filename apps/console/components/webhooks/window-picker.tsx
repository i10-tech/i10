"use client"

import { useTransition } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { motion } from "motion/react"
import { cn } from "cn"
import { WINDOWS, type WindowValue } from "@/lib/webhooks"

/**
 * 24 hours / 7 days / 30 days, as `?window=`.
 *
 * ⚠ IN THE URL FOR THE SAME REASONS AS THE OVERVIEW'S RANGE PICKER: the page
 * reads the stats on the server, and a link to a bad week should open on it.
 * The tab and the other parameters are kept.
 */
export function WindowPicker({ value }: { value: WindowValue }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [pending, start] = useTransition()

  function select(next: WindowValue) {
    const params = new URLSearchParams(searchParams.toString())
    if (next === "24h") params.delete("window")
    else params.set("window", next)
    const query = params.toString()
    start(() =>
      router.push(query ? `${pathname}?${query}` : pathname, { scroll: false }),
    )
  }

  return (
    <div
      className={cn(
        "inline-flex h-9 items-center gap-0.5 rounded-xl border p-0.5 transition-opacity",
        pending && "opacity-70",
      )}
      role="group"
      aria-label="Window"
      aria-busy={pending || undefined}
    >
      {WINDOWS.map((w) => (
        <button
          key={w.value}
          type="button"
          onClick={() => select(w.value)}
          aria-pressed={w.value === value}
          className={cn(
            "relative h-8 cursor-pointer rounded-lg px-2.5 text-xs font-medium transition-colors",
            w.value === value
              ? "text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {w.value === value && (
            <motion.span
              layoutId="webhook-window-active"
              className="absolute inset-0 rounded-lg bg-muted shadow-xs ring-1 ring-border"
              transition={{ type: "spring", stiffness: 500, damping: 38 }}
            />
          )}
          <span className="relative">{w.value}</span>
        </button>
      ))}
    </div>
  )
}
