"use client"

import * as React from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { Layers, Search, Trash2, X } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@repo/ui/components/badge"
import { Button } from "@repo/ui/components/button"
import { Checkbox } from "@repo/ui/components/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/ui/components/dropdown-menu"
import { Input } from "@repo/ui/components/input"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { EmptyState } from "@/components/empty-state"
import { LoadMore } from "@/components/load-more"
import { addToSegment, deleteContacts } from "@/lib/actions"
import type { ContactRow, SegmentRow } from "@/lib/types"
import { useResetWhen, useSyncedState } from "@/lib/react"
import { Time } from "@/components/time"

/**
 * The contact list, with selection.
 *
 * ⚠ SELECTION IS PER PAGE AND THE UI SAYS SO. "Select all" here means the fifty
 * rows on screen, not the forty thousand behind the cursor — and a bulk delete
 * that silently meant the latter would be catastrophic and irreversible. The
 * count on the action bar is the honest number.
 *
 * ⚠ AND SELECTION IS CLEARED WHEN THE FILTER CHANGES. Keeping ids across a
 * filter change means the action bar says "12 selected" while showing a list
 * none of them are in, and the delete that follows removes twelve rows the
 * person cannot see.
 */
export function ContactsTable({
  contacts,
  nextCursor,
  segments,
}: {
  contacts: ContactRow[]
  nextCursor: string | null
  segments: SegmentRow[]
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [deleting, setDeleting] = React.useState(false)

  const urlSearch = searchParams.get("search") ?? ""
  const segmentId = searchParams.get("segment_id")

  // Local while typing, follows the URL when it changes elsewhere.
  const [search, setSearch] = useSyncedState(urlSearch)

  // ⚠ SELECTION IS DROPPED WHENEVER THE FILTER MOVES. See the block comment:
  // keeping ids across a filter change means the action bar says "12 selected"
  // over a list none of them are in, and the delete that follows removes twelve
  // rows the person cannot see. The token is both filters joined, so either one
  // changing clears it.
  useResetWhen(`${urlSearch}\u0000${segmentId ?? ""}`, () => setSelected(new Set()))

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

  const activeSegment = segments.find((segment) => segment.id === segmentId)

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const allOnPageSelected =
    contacts.length > 0 && contacts.every((contact) => selected.has(contact.id))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search name or address"
            className="h-8 pl-8 text-sm"
            aria-label="Search contacts"
          />
        </div>

        {activeSegment && (
          <Badge variant="secondary" className="gap-1">
            <Layers className="size-3" />
            {activeSegment.name}
            <button
              type="button"
              aria-label="Clear segment filter"
              className="cursor-pointer"
              onClick={() => {
                const params = new URLSearchParams(searchParams.toString())
                params.delete("segment_id")
                params.delete("cursor")
                router.push(`${pathname}?${params.toString()}`, { scroll: false })
              }}
            >
              <X className="size-3" />
            </button>
          </Badge>
        )}
      </div>

      {selected.size > 0 && (
        /*
         * ⚠ THE ACTION BAR REPLACES NOTHING AND PUSHES NOTHING DOWN. It appears
         * above the table in the space the filters already occupy, so selecting
         * a row does not make the row you were aiming at move.
         */
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
          <span className="tabular text-sm">
            {selected.size} selected{" "}
            <span className="text-muted-foreground">on this page</span>
          </span>

          <div className="ml-auto flex items-center gap-2">
            {segments.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm">
                    <Layers />
                    Add to segment
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel>Add to</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {segments.map((segment) => (
                    <DropdownMenuItem
                      key={segment.id}
                      onSelect={async () => {
                        const result = await addToSegment(segment.id, [...selected])
                        if (!result.ok) {
                          toast.error("Could not add them", {
                            description: result.error,
                          })
                          return
                        }
                        toast.success(
                          `Added ${result.data.added} to ${segment.name}`,
                          result.data.added < selected.size
                            ? {
                                description: `${selected.size - result.data.added} were already in it.`,
                              }
                            : undefined,
                        )
                        setSelected(new Set())
                        router.refresh()
                      }}
                    >
                      {segment.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            <Button variant="outline" size="sm" onClick={() => setDeleting(true)}>
              <Trash2 />
              Delete
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </div>
        </div>
      )}

      {contacts.length === 0 ? (
        <EmptyState
          title={urlSearch || segmentId ? "No matching contacts" : "No contacts yet"}
          description={
            urlSearch || segmentId
              ? "Try a different search, or clear the segment filter."
              : "Import a CSV or add someone by hand. Custom columns become merge fields you can use in a broadcast."
          }
        />
      ) : (
        <>
          <div className="overflow-hidden rounded-lg border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/30 text-left">
                  <th className="w-10 px-3 py-2">
                    <Checkbox
                      checked={allOnPageSelected}
                      aria-label="Select all contacts on this page"
                      onCheckedChange={(checked) =>
                        setSelected(
                          checked
                            ? new Set(contacts.map((contact) => contact.id))
                            : new Set(),
                        )
                      }
                    />
                  </th>
                  <th className="px-3 py-2 text-xs font-medium text-muted-foreground">
                    Email
                  </th>
                  <th className="hidden px-3 py-2 text-xs font-medium text-muted-foreground md:table-cell">
                    Name
                  </th>
                  <th className="w-[9rem] px-3 py-2 text-xs font-medium text-muted-foreground">
                    Status
                  </th>
                  <th className="w-[9rem] px-3 py-2 text-right text-xs font-medium text-muted-foreground">
                    Added
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {contacts.map((contact) => (
                  <tr key={contact.id} className="hover:bg-muted/20">
                    <td className="px-3 py-2.5">
                      <Checkbox
                        checked={selected.has(contact.id)}
                        aria-label={`Select ${contact.email}`}
                        onCheckedChange={() => toggle(contact.id)}
                      />
                    </td>
                    <td className="max-w-0 px-3 py-2.5">
                      <span className="block truncate font-mono text-xs">
                        {contact.email}
                      </span>
                    </td>
                    <td className="hidden max-w-0 px-3 py-2.5 md:table-cell">
                      <span className="block truncate text-sm">
                        {[contact.first_name, contact.last_name]
                          .filter(Boolean)
                          .join(" ") || (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      {contact.unsubscribed ? (
                        <Badge variant="outline">Unsubscribed</Badge>
                      ) : (
                        <Badge variant="secondary">Subscribed</Badge>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right text-xs whitespace-nowrap text-muted-foreground">
                      <Time iso={contact.created_at} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <LoadMore cursor={nextCursor} />
        </>
      )}

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${selected.size} ${selected.size === 1 ? "contact" : "contacts"}?`}
        description="They are removed from every segment and their topic preferences go with them. If any of them had unsubscribed, that record is lost — re-importing the same address would start sending to them again."
        confirmLabel="Delete"
        onConfirm={async () => {
          const result = await deleteContacts([...selected])
          if (!result.ok) {
            toast.error("Could not delete them", { description: result.error })
            return false
          }
          toast.success(`Deleted ${result.data.deleted}`)
          setSelected(new Set())
          setDeleting(false)
          router.refresh()
          return true
        }}
      />
    </div>
  )
}
