"use client"

import { useState, useTransition } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import SegmentedControl from "@repo/ui/components/segmented-control/segmented-control"

const OPTIONS = [7, 14, 30, 90] as const

/**
 * The date range a page is narrowed to, as `?days=`. Arc's segmented control:
 * a view of the same data, so the pill slides at once and the page follows
 * when the server has the new range.
 */
export function RangePicker({ value }: { value: number }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [pending, start] = useTransition()
  const [chosen, setChosen] = useState(value)
  const [seen, setSeen] = useState(value)
  if (value !== seen) {
    setSeen(value)
    setChosen(value)
  }

  function select(days: number) {
    setChosen(days)
    const next = new URLSearchParams(searchParams.toString())
    next.set("days", String(days))
    next.delete("cursor")
    start(() => router.push(`${pathname}?${next.toString()}`, { scroll: false }))
  }

  return (
    <div aria-busy={pending || undefined}>
      <SegmentedControl
        label="Date range"
        value={String(chosen)}
        onValueChange={(v) => select(Number(v))}
        options={OPTIONS.map((days) => ({
          value: String(days),
          label: `${days} days`,
        }))}
      />
    </div>
  )
}
