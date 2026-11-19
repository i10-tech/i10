"use client"

import * as React from "react"
import { Layers, SearchX, Trash2, Users } from "lucide-react"
import { cn } from "cn"
import { Bone, BoneRegion, BoneScope } from "@repo/ui/components/bone/bone"
import { Badge } from "@repo/ui/components/badge/badge"
import { Button } from "@repo/ui/components/button/button"
import { Checkbox } from "@repo/ui/components/checkbox/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@repo/ui/components/i10/menu"
import {
  Page,
  PageActions,
  PageBody,
  PageDescription,
  PageHeader,
  PageHeaderRow,
  PageTitle,
  TITLE,
} from "@repo/ui/components/i10/page"
import { PlaceholderTitle } from "@repo/ui/components/i10/page-title"
import { ConfirmDialog, confirmWordFor } from "@/components/confirm-dialog"
import { EmptyState } from "@/components/empty-state"
import { ImportContactsButton } from "@/components/import-contacts"
import { BulkBar } from "@/components/list/bulk-bar"
import { RememberShape, useRememberedShape } from "@/components/list/remembered-shapes"
import {
  ListCell,
  ListHead,
  ListHeader,
  ListTable,
  rowClass,
} from "@/components/list/table"
import {
  ListToolbar,
  ListToolbarEnd,
  UrlFilterSelect,
  UrlListResults,
  UrlListSearch,
} from "@/components/list/toolbar"
import { ListRegion, UrlList, useUrlList } from "@/components/list/url-state"
import { LoadMore } from "@/components/load-more"
import { NewContactButton } from "@/components/new-contact"
import { PanelError } from "@/components/panel-error"
import { StatusDot } from "@/components/status"
import { Time } from "@/components/time"
import { addToSegment, deleteContacts } from "@/lib/actions"
import { PAGE_COPY } from "@/lib/page-copy"
import { useResetWhen, NONE } from "@/lib/react"
import {
  contactsShape,
  type ContactsData,
  type ContactsShape,
} from "@/lib/shapes/contacts"
import { toastDone, toastError } from "@/lib/toast"
import type { ContactRow } from "@/lib/types"

/** What loading.tsx renders: the view with the shape this workspace last had. */
export function ContactsLoading() {
  return <ContactsView shape={useRememberedShape(contactsShape)} />
}

const FILTERS = ["search", "status", "segment_id"]
const fullName = (c: ContactRow) =>
  [c.first_name, c.last_name].filter(Boolean).join(" ")
const EMAIL_WIDTHS = ["68%", "52%", "75%", "60%"]
const NAME_WIDTHS = ["50%", "40%", "65%", "45%"]

/**
 * The contact list, with selection.
 *
 * The contacts page, loaded and loading: ONE view, so the skeleton cannot drift
 * from the page (docs/decisions/skeletons.md).
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
export function ContactsView({
  shape,
  data,
}: {
  shape: ContactsShape
  data?: ContactsData
}) {
  const loading = data === undefined
  return (
    <BoneScope id="contacts" loading={loading}>
      <Page aria-busy={loading}>
        <PageHeader>
          <PageHeaderRow>
            {loading ? (
              <PlaceholderTitle text={PAGE_COPY.contacts.title} className={TITLE} />
            ) : (
              <PageTitle>{PAGE_COPY.contacts.title}</PageTitle>
            )}
            <PageActions>
              <ImportContactsButton />
              <NewContactButton />
            </PageActions>
          </PageHeaderRow>
          <PageDescription>{PAGE_COPY.contacts.description}</PageDescription>
        </PageHeader>

        <PageBody width="full">
          {data?.error !== undefined ? (
            <PanelError title="Could not load contacts" message={data.error} />
          ) : (
            <UrlList className="space-y-4">
              <ContactsContent shape={shape} data={data} loading={loading} />
            </UrlList>
          )}
        </PageBody>
      </Page>
    </BoneScope>
  )
}

function ContactsContent({
  shape,
  data,
  loading,
}: {
  shape: ContactsShape
  data?: ContactsData
  loading: boolean
}) {
  const { params, commit } = useUrlList()
  const filtered = FILTERS.some((f) => Boolean(params.get(f)))
  const contacts = data?.contacts ?? NONE
  const segments = data?.segments ?? NONE
  const hasRows = shape.rows > 0

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

  const rows: (ContactRow | undefined)[] = loading
    ? Array.from({ length: shape.rows }, () => undefined)
    : contacts

  if (!hasRows && !filtered) {
    return (
      <EmptyState
        icon={<Users />}
        title="No contacts yet"
        description="Import a CSV or add someone by hand. Custom columns become merge fields you can use in a broadcast."
      />
    )
  }

  return (
    <>
      <ListToolbar>
        <UrlListSearch
          placeholder="Search name or address"
          label="Search contacts"
        />
        {/* No total: only a page of contacts is loaded, so it is just Clear. */}
        <UrlListResults params={FILTERS} />
        <ListToolbarEnd>
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
          {shape.segments > 0 && (
            <UrlFilterSelect
              param="segment_id"
              label="Segment"
              allLabel="All segments"
              // Segment names come with the data: a fixed width, or the trigger
              // grows when they arrive (the widest is unknown while loading).
              triggerWidth={176}
              options={segments.map((segment) => ({
                value: segment.id,
                label: segment.name,
              }))}
            />
          )}
        </ListToolbarEnd>
      </ListToolbar>

      <ListRegion>
        <div className="space-y-4">
          <BoneRegion id="list">
            {!loading && contacts.length === 0 ? (
              <EmptyState
                icon={<SearchX />}
                title="No matching contacts"
                description="Try a different search, or clear the filters."
                secondary={
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => commit((p) => FILTERS.forEach((f) => p.delete(f)))}
                  >
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <ListTable>
                <ListHeader>
                  <th className="w-[4.25rem] py-2.5 pl-4">
                    <Bone
                      id="all"
                      shape="box"
                      width={36}
                      height={36}
                      inset={9}
                      radius={5}
                      inline
                    >
                      {!loading && (
                        <Checkbox
                          checked={
                            allOnPageSelected
                              ? true
                              : someSelected
                                ? "indeterminate"
                                : false
                          }
                          aria-label="Select all contacts on this page"
                          onCheckedChange={(checked) =>
                            setSelected(checked === true ? new Set(ids) : new Set())
                          }
                        />
                      )}
                    </Bone>
                  </th>
                  <ListHead>Email</ListHead>
                  <ListHead hideBelow="sm" className="w-[10rem]">
                    Name
                  </ListHead>
                  <ListHead className="w-[8.5rem]">Status</ListHead>
                  <ListHead className="w-[7.5rem] text-right">Added</ListHead>
                </ListHeader>
                <tbody className="divide-y">
                  {rows.map((contact, i) => {
                    const ticked = contact !== undefined && selected.has(contact.id)
                    return (
                      <BoneScope key={contact?.id ?? i} id={`row-${i}`} unit>
                        <tr
                          // A shift-click picks a range; without this it also selects text.
                          onMouseDown={(event) =>
                            contact && event.shiftKey && event.preventDefault()
                          }
                          onClick={(event) => {
                            if (!contact) return
                            if (
                              (event.target as HTMLElement).closest("button, a, input")
                            )
                              return
                            toggle(contact.id, event.shiftKey)
                          }}
                          className={cn(
                            rowClass,
                            "cursor-pointer",
                            ticked && "bg-primary/[0.05] hover:bg-primary/[0.08]",
                          )}
                        >
                          <td className="w-[4.25rem] py-3 pl-4">
                            <Bone
                              id="tick"
                              shape="box"
                              width={36}
                              height={36}
                              inset={9}
                              radius={5}
                              inline
                            >
                              {contact && (
                                <Checkbox
                                  checked={ticked}
                                  aria-label={`Select ${contact.email}`}
                                  onClick={(event) => {
                                    event.preventDefault()
                                    toggle(contact.id, event.shiftKey)
                                  }}
                                />
                              )}
                            </Bone>
                          </td>
                          <ListCell>
                            <Bone
                              id="email"
                              width={EMAIL_WIDTHS[i % EMAIL_WIDTHS.length]}
                              lineHeight={16}
                            >
                              {contact && (
                                <span
                                  className="block truncate font-mono text-xs"
                                  title={contact.email}
                                >
                                  {contact.email}
                                </span>
                              )}
                            </Bone>
                          </ListCell>
                          <ListCell hideBelow="sm">
                            <Bone
                              id="name"
                              width={NAME_WIDTHS[i % NAME_WIDTHS.length]}
                              lineHeight={20}
                            >
                              {contact && (
                                <span
                                  className="block truncate text-sm"
                                  title={fullName(contact)}
                                >
                                  {fullName(contact) || (
                                    <span className="text-muted-foreground">-</span>
                                  )}
                                </span>
                              )}
                            </Bone>
                          </ListCell>
                          <ListCell>
                            <Bone
                              id="status"
                              shape="box"
                              width={88}
                              height={20}
                              radius={9999}
                              inline
                            >
                              {contact && (
                                <Badge tone="neutral">
                                  {contact.unsubscribed ? "Unsubscribed" : "Subscribed"}
                                </Badge>
                              )}
                            </Bone>
                          </ListCell>
                          <ListCell className="text-right text-xs whitespace-nowrap text-muted-foreground">
                            <Bone id="added" width={64} lineHeight={16} align="end">
                              {contact && <Time iso={contact.created_at} />}
                            </Bone>
                          </ListCell>
                        </tr>
                      </BoneScope>
                    )
                  })}
                </tbody>
              </ListTable>
            )}
          </BoneRegion>

          <LoadMore cursor={data?.nextCursor} hasMore={shape.hasMore} />
        </div>
      </ListRegion>

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
        {shape.segments > 0 && segments.length > 0 && (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm">
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
                      toastError("Could not add them", {
                        description: result.error,
                      })
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
        <Button variant="danger" size="sm" onClick={() => setDeleting(true)}>
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
        // One contact: its address. Several: the bulk word (confirmWordFor).
        confirmWord={confirmWordFor(
          contacts.filter((c) => selected.has(c.id)).map((c) => c.email),
        )}
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
      {data && data.error === undefined && (
        <RememberShape
          def={contactsShape}
          shape={shape}
          skip={filtered || Boolean(params.get("cursor"))}
        />
      )}
    </>
  )
}
