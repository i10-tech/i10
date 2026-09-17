"use client"

import * as React from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { Button } from "@repo/ui/components/button"
import { cn } from "cn"
import { EmptyState } from "@/components/empty-state"
import { LoadMore } from "@/components/load-more"
import { formatDuration } from "@/lib/format"
import type { RequestRow } from "@/lib/types"
import { Time } from "@/components/time"

/**
 * The API request log.
 *
 * ⚠ THE DURATION COLUMN IS WHY THIS PAGE EARNS ITS PLACE. "The API is slow" is
 * the hardest report to act on, and the answer is almost always either a cold
 * key verification or a caller in another region. Per-request timings turn it
 * into a number somebody can argue with.
 *
 * ⚠ AND THE STATUS FILTER IS THREE STATES, NOT A DROPDOWN OF CODES. In practice
 * the question is "show me the failures"; filtering to a specific 429 is a
 * refinement almost nobody needs and every extra control costs a glance.
 */
export function LogsTable({
  rows,
  nextCursor,
  status,
}: {
  rows: RequestRow[]
  nextCursor: string | null
  status?: "ok" | "error"
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  function filter(next?: "ok" | "error") {
    const params = new URLSearchParams(searchParams.toString())
    if (next) params.set("status", next)
    else params.delete("status")
    // ⚠ THE CURSOR IS DROPPED. It points into the previous result set; carrying
    // it would start the filtered list part-way down and look like missing rows.
    params.delete("cursor")
    router.push(`${pathname}?${params.toString()}`, { scroll: false })
  }

  return (
    <div className="space-y-4">
      <div className="inline-flex items-center gap-0.5 rounded-md border p-0.5">
        {[
          { label: "All", value: undefined },
          { label: "Successes", value: "ok" as const },
          { label: "Errors", value: "error" as const },
        ].map((option) => (
          <button
            key={option.label}
            type="button"
            onClick={() => filter(option.value)}
            aria-pressed={status === option.value}
            className={cn(
              "cursor-pointer rounded-sm px-2 py-1 text-xs font-medium transition-colors",
              "duration-(--duration-instant) ease-(--ease-linear)",
              status === option.value
                ? "bg-secondary text-secondary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title={status ? "Nothing matches that filter" : "No requests yet"}
          description={
            status
              ? "Try clearing the filter."
              : "Calls your servers make to the API appear here, with the status and timing we answered with."
          }
          secondary={
            status ? (
              <Button variant="outline" size="sm" onClick={() => filter(undefined)}>
                Clear filter
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <div className="overflow-hidden rounded-lg border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/30 text-left">
                  <th className="w-[5rem] px-3 py-2 text-xs font-medium text-muted-foreground">
                    Method
                  </th>
                  <th className="px-3 py-2 text-xs font-medium text-muted-foreground">
                    Path
                  </th>
                  <th className="w-[5rem] px-3 py-2 text-xs font-medium text-muted-foreground">
                    Status
                  </th>
                  <th className="w-[6rem] px-3 py-2 text-right text-xs font-medium text-muted-foreground">
                    Duration
                  </th>
                  <th className="hidden px-3 py-2 text-xs font-medium text-muted-foreground lg:table-cell">
                    Client
                  </th>
                  <th className="w-[9rem] px-3 py-2 text-right text-xs font-medium text-muted-foreground">
                    When
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((row) => (
                  <tr key={row.id} className="hover:bg-muted/20">
                    <td className="px-3 py-2">
                      <span className="font-mono text-2xs font-medium text-muted-foreground">
                        {row.method}
                      </span>
                    </td>
                    <td className="max-w-0 px-3 py-2">
                      <span className="block truncate font-mono text-xs">
                        {row.path}
                      </span>
                      {row.error_name && (
                        <span className="text-2xs text-danger">{row.error_name}</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={cn(
                          "tabular font-mono text-xs",
                          row.status >= 500 && "text-danger",
                          row.status >= 400 && row.status < 500 && "text-warning",
                          row.status < 300 && "text-success",
                        )}
                      >
                        {row.status}
                      </span>
                    </td>
                    <td className="tabular px-3 py-2 text-right text-xs text-muted-foreground">
                      {formatDuration(row.duration_ms)}
                    </td>
                    <td className="hidden max-w-0 px-3 py-2 lg:table-cell">
                      <span
                        className="block truncate text-xs text-muted-foreground"
                        title={row.user_agent ?? undefined}
                      >
                        {row.user_agent ?? "—"}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right text-xs whitespace-nowrap text-muted-foreground">
                      <Time iso={row.occurred_at} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <LoadMore cursor={nextCursor} />
        </>
      )}
    </div>
  )
}
