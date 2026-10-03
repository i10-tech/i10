"use client"

import * as React from "react"
import { Layers, SearchX, Trash2, Users } from "lucide-react"
import { cn } from "cn"
import { Badge } from "@repo/ui/components/badge"
import { Button } from "@repo/ui/components/button"
import { Checkbox } from "@repo/ui/components/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@repo/ui/components/dropdown-menu"
import { BULK_CONFIRM_WORD, ConfirmDialog } from "@/components/confirm-dialog"
import { EmptyState } from "@/components/empty-state"
import { BulkBar } from "@/components/list/bulk-bar"
import {
  ListCell,
  ListHead,
  ListHeader,
  ListTable,
  rowClass,
} from "@/components/list/table"
import {
  ListToolbar,
  UrlClearFilters,
  UrlFilterSelect,
  UrlSearchField,
} from "@/components/list/toolbar"
import { ListRegion, UrlList, useUrlList } from "@/components/list/url-state"
import { LoadMore } from "@/components/load-more"
import { StatusDot } from "@/components/status"
import { addToSegment, deleteContacts } from "@/lib/actions"
import type { ContactRow, SegmentRow } from "@/lib/types"
import { useResetWhen } from "@/lib/react"
import { Time } from "@/components/time"
import { toastDone, toastError } from "@/lib/toast"

const FILTERS = ["search", "status", "segment_id"]

/**
 * The contact list, with selection.
 *
 * ⚠ SELECTION IS PER PAGE AND THE UI SAYS SO. "Select all" here means the fifty
 * rows on screen, not the forty thousand behind the cursor - and a bulk delete
 * that silently meant the latter would be catastrophic and irreversible. The
 * count on the action bar is the honest number.
 *
 * ⚠ THE BAR FOR WHAT IS TICKED FLOATS OVER THE TABLE, so ticking a row never
 * moves the rows under the pointer.
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
  return (
    <UrlList className="space-y-4">
      <ListToolbar>
        <UrlSearchField placeholder="Search name or address" label="Search contacts" />
        <UrlFilterSelect
          param="status"
          label="Subscription"
          allLabel="All contacts"
          options={[
            {
              value: "subscribed",
              label: "Subscribed",
              icon: <StatusDot tone="success" />,
            },
            {
              value: "unsubscribed",
              label: "Unsubscribed",
              icon: <StatusDot tone="neutral" />,
            },
          ]}
        />
        {segments.length > 0 && (
          <UrlFilterSelect
            param="segment_id"
            label="Segment"
            allLabel="All segments"
            options={segments.map((segment) => ({
              value: segment.id,
              label: segment.name,
            }))}
          />
        )}
        <UrlClearFilters params={FILTERS} />
      </ListToolbar>
      <ListRegion>
        <ContactRows contacts={contacts} nextCursor={nextCursor} segments={segments} />
      </ListRegion>
    </UrlList>
  )
}

function ContactRows({
  contacts,
  nextCursor,
  segments,
}: {
  contacts: ContactRow[]
  nextCursor: string | null
  segments: SegmentRow[]
}) {
  const { params, commit } = useUrlList()
  const filtered = FILTERS.some((f) => params.get(f))
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [deleting, setDeleting] = React.useState(false)
  const doneDeleting = React.useRef(false)
  const [anchor, setAnchor] = React.useState<string | null>(null)

  // ⚠ SELECTION IS DROPPED WHENEVER THE FILTER MOVES, and when a new page of
  // rows arrives: ids from the old list are not rows on screen.
  useResetWhen(contacts, () => setSelected(new Set()))

  const clear = React.useCallback(() => setSelected(new Set()), [])
  const ids = contacts.map((contact) => contact.id)

  function toggle(id: string, shiftKey: boolean) {
    setSelected((prev) => {
      const next = new Set(prev)
      const on = !prev.has(id)
      if (shiftKey && anchor && ids.includes(anchor)) {
        const a = ids.indexOf(anchor)
        const b = ids.indexOf(id)
        for (const x of ids.slice(Math.min(a, b), Math.max(a, b) + 1)) {
          if (on) next.add(x)
          else next.delete(x)
        }
      } else if (on) next.add(id)
      else next.delete(id)
      return next
    })
    setAnchor(id)
  }

  const allOnPageSelected =
    contacts.length > 0 && contacts.every((contact) => selected.has(contact.id))
  const someSelected = selected.size > 0

  return (
    <div className="space-y-4">
      {contacts.length === 0 ? (
        <EmptyState
          icon={filtered ? <SearchX /> : <Users />}
          title={filtered ? "No matching contacts" : "No contacts yet"}
          description={
            filtered
              ? "Try a different search, or clear the filters."
              : "Import a CSV or add someone by hand. Custom columns become merge fields you can use in a broadcast."
          }
          secondary={
            filtered ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => commit((p) => FILTERS.forEach((f) => p.delete(f)))}
              >
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <ListTable>
            <ListHeader>
              <th className="w-10 py-2.5 pl-4">
                <Checkbox
                  checked={
                    allOnPageSelected ? true : someSelected ? "indeterminate" : false
                  }
                  aria-label="Select all contacts on this page"
                  onCheckedChange={(checked) =>
                    setSelected(checked === true ? new Set(ids) : new Set())
                  }
                />
              </th>
              <ListHead>Email</ListHead>
              <ListHead className="hidden md:table-cell">Name</ListHead>
              <ListHead className="w-[9rem]">Status</ListHead>
              <ListHead className="w-[9rem] text-right">Added</ListHead>
            </ListHeader>
            <tbody className="divide-y">
              {contacts.map((contact) => {
                const ticked = selected.has(contact.id)
                return (
                  <tr
                    key={contact.id}
                    // A shift-click picks a range; without this it also selects text.
                    onMouseDown={(event) => event.shiftKey && event.preventDefault()}
                    onClick={(event) => {
                      if ((event.target as HTMLElement).closest("button, a, input"))
                        return
                      toggle(contact.id, event.shiftKey)
                    }}
                    className={cn(
                      rowClass,
                      "cursor-pointer animate-in fade-in-0 duration-300",
                      ticked && "bg-primary/[0.05] hover:bg-primary/[0.08]",
                    )}
                  >
                    <td className="w-10 py-3 pl-4">
                      <Checkbox
                        checked={ticked}
                        aria-label={`Select ${contact.email}`}
                        onClick={(event) => {
                          event.preventDefault()
                          toggle(contact.id, event.shiftKey)
                        }}
                      />
                    </td>
                    <ListCell className="max-w-0">
                      <span className="block truncate font-mono text-xs">
                        {contact.email}
                      </span>
                    </ListCell>
                    <ListCell className="hidden max-w-0 md:table-cell">
                      <span className="block truncate text-sm">
                        {[contact.first_name, contact.last_name]
                          .filter(Boolean)
                          .join(" ") || (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </span>
                    </ListCell>
                    <ListCell>
                      {contact.unsubscribed ? (
                        <Badge variant="outline">Unsubscribed</Badge>
                      ) : (
                        <Badge variant="secondary">Subscribed</Badge>
                      )}
                    </ListCell>
                    <ListCell className="text-right text-xs whitespace-nowrap text-muted-foreground">
                      <Time iso={contact.created_at} />
                    </ListCell>
                  </tr>
                )
              })}
            </tbody>
          </ListTable>

          <LoadMore cursor={nextCursor} />
        </>
      )}

      {/*
       * ⚠ SELECTION IS PER PAGE AND THE BAR SAYS SO: "select all" means the
       * rows on screen, never the thousands behind the cursor.
       */}
      <BulkBar
        count={selected.size}
        onClear={clear}
        label="Selected contacts"
        note="on this page"
      >
        {segments.length > 0 && (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="rounded-xl">
                <Layers />
                Add to segment
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side="top"
              align="center"
              className="max-h-80 w-56 overflow-y-auto"
            >
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Add to
              </DropdownMenuLabel>
              {segments.map((segment) => (
                <DropdownMenuItem
                  key={segment.id}
                  onSelect={async () => {
                    const picked = [...selected]
                    const result = await addToSegment(segment.id, picked)
                    if (!result.ok) {
                      toastError("Could not add them", { description: result.error })
                      return
                    }
                    toastDone(
                      `Added ${result.data.added} to ${segment.name}`,
                      result.data.added < picked.length
                        ? {
                            description: `${picked.length - result.data.added} were already in it.`,
                          }
                        : undefined,
                    )
                    // No refresh: `addToSegment` re-renders this page in its
                    // own response. See `run` in lib/actions.ts.
                    setSelected(new Set())
                  }}
                >
                  <span className="truncate">{segment.name}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="rounded-xl text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={() => setDeleting(true)}
        >
          <Trash2 />
          Delete
        </Button>
      </BulkBar>

      <ConfirmDialog
        open={deleting}
        onOpenChange={(open) => {
          setDeleting(open)
          // ⚠ THE SELECTION IS CLEARED WHEN THE DIALOG CLOSES, NOT WHEN THE
          // DELETE RETURNS. Clearing it inside `onConfirm` retitled the dialog
          // "Delete 0 contacts?" under its own "Deleted" tick.
          if (!open && doneDeleting.current) {
            doneDeleting.current = false
            setSelected(new Set())
          }
        }}
        title={`Delete ${selected.size} ${selected.size === 1 ? "contact" : "contacts"}?`}
        description="They are removed from every segment and their topic preferences go with them. If any of them had unsubscribed, that record is lost - re-importing the same address would start sending to them again."
        confirmLabel="Delete"
        doneLabel="Deleted"
        // ⚠ `DELETE` FOR EVERY BULK DELETE. There is no single name to type, and
        // the count is already in the title where it is read.
        confirmWord={BULK_CONFIRM_WORD}
        onConfirm={async () => {
          const result = await deleteContacts([...selected])
          if (!result.ok) {
            toastError("Could not delete them", { description: result.error })
            return false
          }
          doneDeleting.current = true
          return true
        }}
      />
    </div>
  )
}
