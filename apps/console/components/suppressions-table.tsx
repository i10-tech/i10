"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Search, Undo2 } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@repo/ui/components/badge"
import { Button } from "@repo/ui/components/button"
import { Input } from "@repo/ui/components/input"
import { usePathname, useSearchParams } from "next/navigation"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { EmptyState } from "@/components/empty-state"
import { LoadMore } from "@/components/load-more"
import { removeSuppression } from "@/lib/actions"
import type { SuppressionRow } from "@/lib/types"
import { useSyncedState } from "@/lib/react"
import { Time } from "@/components/time"

/**
 * The suppression list.
 *
 * ⚠ REMOVING AN ENTRY IS CONFIRMED, AND THE CONFIRMATION SAYS WHAT IT DOES NOT
 * DO. Removing an address does not guarantee delivery — if it bounces again it
 * is suppressed again automatically, and every attempt in between counts
 * against the account's reputation with that receiving network. People remove
 * entries expecting the mail to start arriving; the dialog is the one chance to
 * say that is not how it works.
 *
 * ⚠ AND THE REASON COLUMN IS NOT DECORATION. `hard_bounce` means the address
 * does not exist and never will; `complaint` means a real person pressed "this
 * is spam", and removing that one is a decision with legal weight in several
 * jurisdictions. They are not interchangeable and the UI does not treat them as
 * such.
 */
const REASON_COPY: Record<string, { label: string; detail: string }> = {
  hard_bounce: {
    label: "Hard bounce",
    detail: "The receiving server said this address does not exist.",
  },
  complaint: {
    label: "Complaint",
    detail: "The recipient marked a message as spam.",
  },
  manual: { label: "Added by hand", detail: "Somebody on your team added this." },
  unsubscribe: {
    label: "Unsubscribed",
    detail: "The recipient used an unsubscribe link.",
  },
}

export function SuppressionsTable({
  rows,
  nextCursor,
}: {
  rows: SuppressionRow[]
  nextCursor: string | null
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [removing, setRemoving] = React.useState<SuppressionRow | null>(null)

  const urlSearch = searchParams.get("search") ?? ""
  // Local while typing, but follows the URL when that changes elsewhere — see
  // lib/react.ts on why this is not an effect.
  const [search, setSearch] = useSyncedState(urlSearch)

  React.useEffect(() => {
    if (search === urlSearch) return
    const timer = setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString())
      if (search) params.set("search", search)
      else params.delete("search")
      params.delete("cursor")
      router.push(`${pathname}?${params.toString()}`, { scroll: false })
    }, 350)
    return () => clearTimeout(timer)
  }, [search, urlSearch, pathname, router, searchParams])

  return (
    <div className="space-y-4">
      <div className="relative max-w-xs">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search addresses"
          className="h-8 pl-8 text-sm"
          aria-label="Search suppressed addresses"
        />
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title={urlSearch ? "No matching addresses" : "Nothing suppressed"}
          description={
            urlSearch
              ? "Try a different search."
              : "Addresses that hard-bounce or complain land here automatically. An empty list is a good sign."
          }
        />
      ) : (
        <>
          <div className="overflow-hidden rounded-lg border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/30 text-left">
                  <th className="px-3 py-2 text-xs font-medium text-muted-foreground">
                    Address
                  </th>
                  <th className="w-[12rem] px-3 py-2 text-xs font-medium text-muted-foreground">
                    Reason
                  </th>
                  <th className="hidden w-[9rem] px-3 py-2 text-xs font-medium text-muted-foreground md:table-cell">
                    Message
                  </th>
                  <th className="w-[9rem] px-3 py-2 text-right text-xs font-medium text-muted-foreground">
                    Added
                  </th>
                  <th className="w-12" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((row) => {
                  const reason = REASON_COPY[row.reason] ?? {
                    label: row.reason,
                    detail: "",
                  }
                  return (
                    <tr key={row.address} className="hover:bg-muted/20">
                      <td className="max-w-0 px-3 py-2.5">
                        <span className="block truncate font-mono text-xs select-all">
                          {row.address}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        <Badge variant="outline" title={reason.detail}>
                          {reason.label}
                        </Badge>
                      </td>
                      <td className="hidden px-3 py-2.5 md:table-cell">
                        {row.message_id ? (
                          <Link
                            href={`/emails/${row.message_id}`}
                            className="font-mono text-xs text-muted-foreground underline-offset-4 hover:underline"
                          >
                            View
                          </Link>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right text-xs whitespace-nowrap text-muted-foreground">
                        <Time iso={row.created_at} />
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Remove ${row.address} from the suppression list`}
                          onClick={() => setRemoving(row)}
                        >
                          <Undo2 />
                        </Button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <LoadMore cursor={nextCursor} />
        </>
      )}

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title="Remove this suppression?"
        description={
          removing?.reason === "complaint"
            ? "This recipient marked a message as spam. Sending to them again risks your reputation and, in some jurisdictions, breaks the law. If they bounce or complain again they are suppressed again automatically."
            : "We will start sending to this address again. If it bounces again it is suppressed again automatically — removing it does not guarantee delivery."
        }
        confirmLabel="Remove"
        destructive={false}
        onConfirm={async () => {
          if (!removing) return false
          const result = await removeSuppression(removing.address)
          if (!result.ok) {
            toast.error("Could not remove it", { description: result.error })
            return false
          }
          toast.success(`${removing.address} removed`)
          setRemoving(null)
          router.refresh()
          return true
        }}
      />
    </div>
  )
}
