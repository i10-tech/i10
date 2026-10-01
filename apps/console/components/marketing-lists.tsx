"use client"

import * as React from "react"
import Link from "next/link"
import { Layers, Megaphone, SearchX, Tag, Users } from "lucide-react"
import { Badge } from "@repo/ui/components/badge"
import { Button } from "@repo/ui/components/button"
import { EmptyState } from "@/components/empty-state"
import { ListCard, ListGrid, MotionBody, MotionRow } from "@/components/list/motion"
import { ListCell, ListHead, ListHeader, ListTable } from "@/components/list/table"
import {
  FilterSelect,
  ListToolbar,
  ResultsLine,
  SearchField,
  ViewToggle,
  useRememberedView,
} from "@/components/list/toolbar"
import { SegmentActions } from "@/components/segment-actions"
import { Status, StatusDot, describeStatus } from "@/components/status"
import { TopicActions } from "@/components/topic-actions"
import { formatNumber, formatRelative } from "@/lib/format"
import type { BroadcastSummary, SegmentRow, TopicRow } from "@/lib/types"

/**
 * Broadcasts, segments and topics, in the shape every list in the console
 * shares: search, the filters that matter for each, grid or table.
 *
 * ⚠ FILTERED IN THE BROWSER. These lists come back whole from the API and run
 * to tens of rows, so a round trip per keystroke would only add latency.
 */

function NoMatch({ onClear }: { onClear: () => void }) {
  return (
    <EmptyState
      icon={<SearchX />}
      title="Nothing matches"
      description="Try another search, or clear the filters."
      secondary={
        <Button size="sm" variant="outline" onClick={onClear}>
          Clear filters
        </Button>
      }
    />
  )
}

const includes = (q: string, ...values: (string | null | undefined)[]) =>
  !q || values.some((v) => v?.toLowerCase().includes(q))

// ── Broadcasts ─────────────────────────────────────────────────────────────

/** A broadcast's state, in the delivery log's vocabulary of dots. */
const broadcastTone = (status: string) =>
  status === "draft"
    ? "queued"
    : status === "canceled"
      ? "canceled"
      : status === "sent"
        ? "delivered"
        : status === "scheduled"
          ? "scheduled"
          : "sending"

const BROADCAST_STATUS: Record<string, string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  sending: "Sending",
  sent: "Sent",
  canceled: "Canceled",
}

export function BroadcastsList({ broadcasts }: { broadcasts: BroadcastSummary[] }) {
  const [query, setQuery] = React.useState("")
  const [status, setStatus] = React.useState("")
  const [segment, setSegment] = React.useState("")
  const [view, setView] = useRememberedView("broadcasts", "table")

  const statuses = [...new Set(broadcasts.map((b) => b.status))]
  const segments = [
    ...new Map(
      broadcasts
        .filter((b) => b.segment_id)
        .map((b) => [b.segment_id!, b.segment_name ?? "Segment"]),
    ),
  ]
  const q = query.trim().toLowerCase()
  const shown = broadcasts.filter(
    (b) =>
      includes(q, b.name, b.subject, b.segment_name, b.from) &&
      (!status || b.status === status) &&
      (!segment || b.segment_id === segment),
  )
  const clear = () => {
    setQuery("")
    setStatus("")
    setSegment("")
  }

  return (
    <div>
      <ListToolbar>
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Search broadcasts"
          label="Search broadcasts"
        />
        {statuses.length > 1 && (
          <FilterSelect
            value={status}
            onValueChange={setStatus}
            label="Status"
            allLabel="All statuses"
            options={statuses.map((s) => ({
              value: s,
              label: BROADCAST_STATUS[s] ?? s,
              icon: <StatusDot tone={describeStatus(broadcastTone(s)).tone} />,
            }))}
          />
        )}
        {segments.length > 1 && (
          <FilterSelect
            value={segment}
            onValueChange={setSegment}
            label="Segment"
            allLabel="All segments"
            options={segments.map(([value, label]) => ({ value, label }))}
          />
        )}
        <ViewToggle value={view} onChange={setView} />
      </ListToolbar>
      <ResultsLine
        count={shown.length}
        query={query}
        filtered={status !== "" || segment !== ""}
        noun={["broadcast", "broadcasts"]}
        onClear={clear}
      />

      <div className="pt-4">
        {shown.length === 0 ? (
          <NoMatch onClear={clear} />
        ) : view === "grid" ? (
          <ListGrid>
            {shown.map((b) => (
              <ListCard key={b.id} id={b.id} href={`/broadcasts/${b.id}`}>
                <div className="flex items-center gap-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-xl border bg-muted/50 text-muted-foreground transition-colors group-hover:text-foreground">
                    <Megaphone className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate font-medium">{b.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {b.subject || <em>No subject yet</em>}
                    </p>
                  </div>
                </div>
                <Status
                  status={broadcastTone(b.status)}
                  label={BROADCAST_STATUS[b.status] ?? b.status}
                />
                <div className="mt-auto flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span className="flex min-w-0 items-center gap-1.5 truncate">
                    <Layers className="size-3.5 shrink-0" />
                    <span className="truncate">{b.segment_name ?? "No segment"}</span>
                  </span>
                  <span className="shrink-0" title={b.sent_at ?? b.created_at}>
                    {b.recipient_count !== null &&
                      `${formatNumber(b.recipient_count)} · `}
                    {formatRelative(b.sent_at ?? b.created_at)}
                  </span>
                </div>
              </ListCard>
            ))}
          </ListGrid>
        ) : (
          <ListTable>
            <ListHeader>
              <ListHead>Name</ListHead>
              <ListHead className="w-[9rem]">Status</ListHead>
              <ListHead className="hidden w-[12rem] md:table-cell">Segment</ListHead>
              <ListHead className="hidden w-[8rem] text-right sm:table-cell">
                Recipients
              </ListHead>
              <ListHead className="w-[9rem] text-right">Updated</ListHead>
            </ListHeader>
            <MotionBody>
              {shown.map((b) => (
                <MotionRow key={b.id} href={`/broadcasts/${b.id}`}>
                  <ListCell className="max-w-0">
                    <Link
                      href={`/broadcasts/${b.id}`}
                      className="block truncate font-medium outline-none hover:underline focus-visible:underline"
                    >
                      {b.name}
                    </Link>
                    <p className="truncate text-xs text-muted-foreground">
                      {b.subject || <em>No subject yet</em>}
                    </p>
                  </ListCell>
                  <ListCell>
                    <Status
                      status={broadcastTone(b.status)}
                      label={BROADCAST_STATUS[b.status] ?? b.status}
                    />
                  </ListCell>
                  <ListCell className="hidden max-w-0 md:table-cell">
                    <span className="block truncate text-xs text-muted-foreground">
                      {b.segment_name ?? "-"}
                    </span>
                  </ListCell>
                  <ListCell className="tabular hidden text-right text-xs text-muted-foreground sm:table-cell">
                    {b.recipient_count === null ? "-" : formatNumber(b.recipient_count)}
                  </ListCell>
                  <ListCell
                    className="text-right text-xs whitespace-nowrap text-muted-foreground"
                    title={b.sent_at ?? b.created_at}
                  >
                    {formatRelative(b.sent_at ?? b.created_at)}
                  </ListCell>
                </MotionRow>
              ))}
            </MotionBody>
          </ListTable>
        )}
      </div>
    </div>
  )
}

// ── Segments ───────────────────────────────────────────────────────────────

export function SegmentsList({ segments }: { segments: SegmentRow[] }) {
  const [query, setQuery] = React.useState("")
  const [view, setView] = useRememberedView("segments", "grid")
  const q = query.trim().toLowerCase()
  const shown = segments.filter((s) => includes(q, s.name, s.description))
  const clear = () => setQuery("")
  const href = (s: SegmentRow) => `/contacts?segment_id=${s.id}`

  return (
    <div>
      <ListToolbar>
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Search segments"
          label="Search segments"
        />
        <ViewToggle value={view} onChange={setView} />
      </ListToolbar>
      <ResultsLine
        count={shown.length}
        query={query}
        filtered={false}
        noun={["segment", "segments"]}
        onClear={clear}
      />

      <div className="pt-4">
        {shown.length === 0 ? (
          <NoMatch onClear={clear} />
        ) : view === "grid" ? (
          <ListGrid>
            {shown.map((s) => (
              <ListCard
                key={s.id}
                id={s.id}
                href={href(s)}
                menu={<SegmentActions id={s.id} name={s.name} />}
              >
                <div className="flex items-center gap-3 pr-8">
                  <span className="grid size-9 shrink-0 place-items-center rounded-xl border bg-muted/50 text-muted-foreground transition-colors group-hover:text-foreground">
                    <Layers className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate font-medium">{s.name}</p>
                    {s.description && (
                      <p className="truncate text-xs text-muted-foreground">
                        {s.description}
                      </p>
                    )}
                  </div>
                </div>
                <div className="mt-auto flex items-end justify-between gap-2">
                  <p>
                    <span className="tabular text-2xl font-semibold tracking-tight">
                      {formatNumber(s.contact_count)}
                    </span>{" "}
                    <span className="text-xs text-muted-foreground">
                      {s.contact_count === 1 ? "contact" : "contacts"}
                    </span>
                  </p>
                  <span className="text-xs text-muted-foreground" title={s.created_at}>
                    {formatRelative(s.created_at)}
                  </span>
                </div>
              </ListCard>
            ))}
          </ListGrid>
        ) : (
          <ListTable>
            <ListHeader>
              <ListHead>Name</ListHead>
              <ListHead className="w-[9rem] text-right">Contacts</ListHead>
              <ListHead className="w-[9rem] text-right">Created</ListHead>
              <ListHead className="w-12">
                <span className="sr-only">Actions</span>
              </ListHead>
            </ListHeader>
            <MotionBody>
              {shown.map((s) => (
                <MotionRow key={s.id} href={href(s)}>
                  <ListCell className="max-w-0">
                    <Link
                      href={href(s)}
                      className="block truncate font-medium outline-none hover:underline focus-visible:underline"
                    >
                      {s.name}
                    </Link>
                    {s.description && (
                      <p className="truncate text-xs text-muted-foreground">
                        {s.description}
                      </p>
                    )}
                  </ListCell>
                  <ListCell className="tabular text-right">
                    {formatNumber(s.contact_count)}
                  </ListCell>
                  <ListCell
                    className="text-right text-xs whitespace-nowrap text-muted-foreground"
                    title={s.created_at}
                  >
                    {formatRelative(s.created_at)}
                  </ListCell>
                  <ListCell className="py-1.5 text-right">
                    <SegmentActions id={s.id} name={s.name} />
                  </ListCell>
                </MotionRow>
              ))}
            </MotionBody>
          </ListTable>
        )}
      </div>
    </div>
  )
}

// ── Topics ─────────────────────────────────────────────────────────────────

const DEFAULT_LABEL: Record<string, string> = {
  opt_in: "Opt-out by default",
  opt_out: "Opt-in required",
}

export function TopicsList({ topics }: { topics: TopicRow[] }) {
  const [query, setQuery] = React.useState("")
  const [visibility, setVisibility] = React.useState("")
  const [view, setView] = useRememberedView("topics", "table")
  const q = query.trim().toLowerCase()
  const shown = topics.filter(
    (t) =>
      includes(q, t.name, t.description) &&
      (!visibility || t.visibility === visibility),
  )
  const clear = () => {
    setQuery("")
    setVisibility("")
  }
  const defaultLabel = (t: TopicRow) =>
    DEFAULT_LABEL[t.default_subscription] ?? "Opt-in required"

  return (
    <div>
      <ListToolbar>
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Search topics"
          label="Search topics"
        />
        <FilterSelect
          value={visibility}
          onValueChange={setVisibility}
          label="Visibility"
          allLabel="All visibilities"
          options={[
            { value: "public", label: "Public" },
            { value: "private", label: "Private" },
          ]}
        />
        <ViewToggle value={view} onChange={setView} />
      </ListToolbar>
      <ResultsLine
        count={shown.length}
        query={query}
        filtered={visibility !== ""}
        noun={["topic", "topics"]}
        onClear={clear}
      />

      <div className="pt-4">
        {shown.length === 0 ? (
          <NoMatch onClear={clear} />
        ) : view === "grid" ? (
          <ListGrid>
            {shown.map((t) => (
              <ListCard key={t.id} id={t.id} menu={<TopicActions topic={t} />}>
                <div className="flex items-center gap-3 pr-8">
                  <span className="grid size-9 shrink-0 place-items-center rounded-xl border bg-muted/50 text-muted-foreground transition-colors group-hover:text-foreground">
                    <Tag className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate font-medium">{t.name}</p>
                    {t.description && (
                      <p className="truncate text-xs text-muted-foreground">
                        {t.description}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="outline">{defaultLabel(t)}</Badge>
                  <Badge
                    variant={t.visibility === "public" ? "secondary" : "outline"}
                    className="capitalize"
                  >
                    {t.visibility}
                  </Badge>
                </div>
                <p className="mt-auto flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Users className="size-3.5" />
                  <span className="tabular text-foreground">
                    {formatNumber(t.subscriber_count)}
                  </span>
                  {t.subscriber_count === 1 ? "subscriber" : "subscribers"}
                </p>
              </ListCard>
            ))}
          </ListGrid>
        ) : (
          <ListTable>
            <ListHeader>
              <ListHead>Name</ListHead>
              <ListHead className="hidden w-[11rem] md:table-cell">Default</ListHead>
              <ListHead className="w-[8rem]">Visibility</ListHead>
              <ListHead className="w-[9rem] text-right">Subscribers</ListHead>
              <ListHead className="w-12">
                <span className="sr-only">Actions</span>
              </ListHead>
            </ListHeader>
            <MotionBody>
              {shown.map((t) => (
                <MotionRow key={t.id}>
                  <ListCell className="max-w-0">
                    <p className="truncate font-medium">{t.name}</p>
                    {t.description && (
                      <p className="truncate text-xs text-muted-foreground">
                        {t.description}
                      </p>
                    )}
                  </ListCell>
                  <ListCell className="hidden md:table-cell">
                    <Badge variant="outline">{defaultLabel(t)}</Badge>
                  </ListCell>
                  <ListCell>
                    <Badge
                      variant={t.visibility === "public" ? "secondary" : "outline"}
                      className="capitalize"
                    >
                      {t.visibility}
                    </Badge>
                  </ListCell>
                  <ListCell className="tabular text-right">
                    {formatNumber(t.subscriber_count)}
                  </ListCell>
                  <ListCell className="py-1.5 text-right">
                    <TopicActions topic={t} />
                  </ListCell>
                </MotionRow>
              ))}
            </MotionBody>
          </ListTable>
        )}
      </div>
    </div>
  )
}
