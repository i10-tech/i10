"use client"

import { useState, useTransition } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import SegmentedControl from "@repo/ui/components/segmented-control/segmented-control"
import { WINDOWS, type WindowValue } from "@/lib/webhooks"

/**
 * 24 hours / 7 days / 30 days, as `?window=`. The same Arc segmented control
 * as the overview's range picker (components/range-picker): the pill slides at
 * once and the page follows when the server has the new window.
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
  const [chosen, setChosen] = useState<WindowValue>(value)
  const [seen, setSeen] = useState(value)
  if (value !== seen) {
    setSeen(value)
    setChosen(value)
  }

  function select(next: WindowValue) {
    setChosen(next)
    const params = new URLSearchParams(searchParams.toString())
    if (next === "24h") params.delete("window")
    else params.set("window", next)
    const query = params.toString()
    start(() =>
      router.push(query ? `${pathname}?${query}` : pathname, { scroll: false }),
    )
  }

  return (
    <div aria-busy={pending || undefined}>
      <SegmentedControl
        label="Window"
        value={chosen}
        onValueChange={(v) => select(v as WindowValue)}
        options={WINDOWS.map((w) => ({ value: w.value, label: w.label }))}
      />
    </div>
  )
}
