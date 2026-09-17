"use client"

import * as React from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { Search, X } from "lucide-react"
import { Button } from "@repo/ui/components/button"
import { Input } from "@repo/ui/components/input"
import { StatusDot, describeStatus } from "@/components/status"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/ui/components/dropdown-menu"
import { cn } from "cn"
import { useSyncedState } from "@/lib/react"

/**
 * Filtering the delivery log.
 *
 * ⚠ EVERY CONTROL WRITES TO THE URL AND NOTHING IS HELD IN REACT STATE EXCEPT
 * THE SEARCH BOX'S UNCOMMITTED TEXT. The page is a server component that reads
 * the query string, so a filter that lived in component state would have
 * nothing to fetch with. It also means back and forward work, and a filtered
 * view is a link somebody can paste into an incident channel.
 *
 * ⚠ THE SEARCH INPUT IS DEBOUNCED AND THE DEBOUNCE IS NOT OPTIONAL. Each commit
 * is a server round trip and an `ILIKE` across a partitioned table; firing one
 * per keystroke would issue a dozen expensive queries to render the result of
 * the last one. 350ms is long enough to swallow typing and short enough that
 * nobody notices waiting.
 */
/*
 * ⚠ THIS LIST IS EXACTLY WHAT `lastEvent` CAN RETURN, AND NOTHING ELSE. The
 * filter is applied against `last_event`, which is either the worst event by
 * severity (send/lookup.ts: `SEVERITY`) or, when there are no events yet, the
 * row's own `message_status` — with `queued` + a future `scheduled_at`
 * reported as `scheduled`. So the list is the severity table, plus the row
 * statuses that can survive to the fallback.
 *
 * ⚠ `sending` WAS MISSING, AND IT IS A REAL STATE A MESSAGE SITS IN. A worker
 * has claimed it and SES has not answered yet; leaving it out of the menu meant
 * there was no way to ask "what is in flight right now", which is the first
 * question during an incident.
 *
 * ⚠ AND `opened` AND `clicked` ARE DELIBERATELY ABSENT. They are not in
 * `SEVERITY`, so they can never BE a `last_event` — a message that was opened
 * is still `delivered`. Offering them here would be a filter that matches
 * nothing, every time, which reads as tracking being broken. Filtering by
 * engagement is a different query against `message_events` and is written up in
 * docs/decisions/console.md §7.
 */
const STATUSES = [
  "delivered",
  "sent",
  "sending",
  "bounced",
  "complained",
  "delivery_delayed",
  "failed",
  "queued",
  "scheduled",
  "canceled",
] as const

export function EmailFilters() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const activeStatuses = React.useMemo(
    () => new Set((searchParams.get("status") ?? "").split(",").filter(Boolean)),
    [searchParams],
  )

  const urlSearch = searchParams.get("search") ?? ""

  /*
   * ⚠ LOCAL, BUT IT FOLLOWS THE URL WHEN THAT CHANGES FROM SOMEWHERE ELSE —
   * pressing back, or the "clear filters" button in the empty state. Without
   * that the input keeps showing the old text after the results have changed
   * underneath it, which reads as the filter having stuck. Adjusted during
   * render rather than in an effect; see lib/react.ts.
   */
  const [search, setSearch] = useSyncedState(urlSearch)

  const commit = React.useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(searchParams.toString())
      mutate(params)
      /*
       * ⚠ THE CURSOR IS ALWAYS DROPPED WHEN A FILTER CHANGES. A cursor points
       * at a position in the PREVIOUS result set; carrying it across a filter
       * change starts the new list part-way down, so the first page of a fresh
       * search silently begins in the middle and looks like missing rows.
       */
      params.delete("cursor")
      router.push(`${pathname}?${params.toString()}`, { scroll: false })
    },
    [pathname, router, searchParams],
  )

  React.useEffect(() => {
    if (search === urlSearch) return
    const timer = setTimeout(() => {
      commit((params) => {
        if (search) params.set("search", search)
        else params.delete("search")
      })
    }, 350)
    return () => clearTimeout(timer)
  }, [search, urlSearch, commit])

  function toggleStatus(status: string) {
    commit((params) => {
      const next = new Set(activeStatuses)
      if (next.has(status)) next.delete(status)
      else next.add(status)
      if (next.size === 0) params.delete("status")
      else params.set("status", [...next].join(","))
    })
  }

  const hasFilters = activeStatuses.size > 0 || urlSearch.length > 0

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-0 flex-1 sm:max-w-xs">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search subject or recipient"
          className="h-8 pl-8 text-sm"
          aria-label="Search emails"
        />
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="gap-1.5">
            Status
            {activeStatuses.size > 0 && (
              <span className="tabular rounded-sm bg-secondary px-1 text-2xs">
                {activeStatuses.size}
              </span>
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-48">
          <DropdownMenuLabel>Delivery state</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {STATUSES.map((status) => {
            const described = describeStatus(status)
            return (
              <DropdownMenuCheckboxItem
                key={status}
                checked={activeStatuses.has(status)}
                // ⚠ `onSelect` IS PREVENTED SO THE MENU STAYS OPEN. Choosing
                // three states out of nine would otherwise mean reopening the
                // menu three times.
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={() => toggleStatus(status)}
              >
                <span className="flex items-center gap-2">
                  <StatusDot tone={described.tone} />
                  {described.label}
                </span>
              </DropdownMenuCheckboxItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      {hasFilters && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            commit((params) => {
              params.delete("status")
              params.delete("search")
            })
          }
          className={cn("text-muted-foreground")}
        >
          <X />
          Clear
        </Button>
      )}
    </div>
  )
}
