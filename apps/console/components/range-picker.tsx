"use client"

import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { cn } from "cn"

/**
 * 7 / 14 / 30 / 90 days.
 *
 * ⚠ THE RANGE LIVES IN THE URL, NOT IN COMPONENT STATE, AND THAT IS THE WHOLE
 * DESIGN. The page is a server component that queries by `days`; holding the
 * range in React would mean fetching on the client, which means a loading
 * spinner where there is currently server-rendered HTML. In the URL it is also
 * shareable, bookmarkable and survives a reload — somebody looking at a bad
 * week can send the link.
 *
 * ⚠ AND IT PRESERVES THE OTHER PARAMETERS. Building the query from scratch
 * would silently drop the status filter and the search term the moment somebody
 * changed the date range, which is the exact combination they are most likely
 * to want.
 */
const OPTIONS = [7, 14, 30, 90] as const

export function RangePicker({ value }: { value: number }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  function select(days: number) {
    const next = new URLSearchParams(searchParams.toString())
    next.set("days", String(days))
    // ⚠ THE CURSOR GOES, FOR THE SAME REASON IT DOES IN `EmailFilters`. A
    // cursor points into the PREVIOUS result set; carrying one across a range
    // change starts the new list part-way down, so a fresh view silently begins
    // in the middle and reads as missing rows. The overview has no cursor today
    // — this is here so that the first paginated page to reuse this control
    // does not have to rediscover the rule.
    next.delete("cursor")
    // ⚠ `scroll: false`, because this is a filter and not a navigation. Jumping
    // to the top of the page when somebody changes the range moves the chart
    // they were looking at out from under the cursor.
    router.push(`${pathname}?${next.toString()}`, { scroll: false })
  }

  return (
    <div
      className="inline-flex items-center gap-0.5 rounded-md border p-0.5"
      role="group"
      aria-label="Date range"
    >
      {OPTIONS.map((days) => (
        <button
          key={days}
          type="button"
          onClick={() => select(days)}
          aria-pressed={days === value}
          className={cn(
            "cursor-pointer rounded-sm px-2 py-1 text-xs font-medium transition-colors",
            "duration-(--duration-instant) ease-(--ease-linear)",
            days === value
              ? "bg-secondary text-secondary-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {days}d
        </button>
      ))}
    </div>
  )
}
