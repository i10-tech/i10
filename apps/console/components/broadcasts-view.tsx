"use client"

import * as React from "react"
import { NONE } from "@/lib/react"
import Link from "next/link"
import { Layers, Megaphone, SearchX } from "lucide-react"
import { Bone, BoneRegion, BoneScope } from "@repo/ui/components/bone/bone"
import { Button } from "@repo/ui/components/button/button"
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
import { EmptyState } from "@/components/empty-state"
import {
  ListCard,
  ListGrid,
  MotionBody,
  MotionRow,
  StaticCard,
  StaticGrid,
} from "@/components/list/motion"
import {
  RememberShape,
  seedShape,
  useRememberedShape,
} from "@/components/list/remembered-shapes"
import {
  ListCell,
  ListHead,
  ListHeader,
  ListRow,
  ListBody,
  ListTable,
} from "@/components/list/table"
import {
  FilterSelect,
  ListResults,
  ListSearch,
  ListToolbar,
  ListToolbarEnd,
  ViewToggle,
  useRememberedView,
} from "@/components/list/toolbar"
import { NewBroadcastButton } from "@/components/new-broadcast"
import { PanelError } from "@/components/panel-error"
import { Status, StatusDot, describeStatus } from "@/components/status"
import { formatNumber } from "@/lib/format"
import { PAGE_COPY } from "@/lib/page-copy"
import {
  broadcastSeed,
  broadcastShape,
  type BroadcastStatus,
} from "@/lib/shapes/broadcast"
import {
  broadcastsShape,
  type BroadcastsData,
  type BroadcastsShape,
} from "@/lib/shapes/broadcasts"
import type { BroadcastSummary } from "@/lib/types"
import { Time } from "@/components/time"

/** What loading.tsx renders: the view with the shape this workspace last had. */
export function BroadcastsLoading() {
  return <BroadcastsView shape={useRememberedShape(broadcastsShape)} />
}

const NAME_WIDTHS = ["62%", "48%", "72%", "55%"]
const SUBJ_WIDTHS = ["45%", "60%", "38%", "52%"]

function NoMatch({ onClear }: { onClear: () => void }) {
  return (
    <EmptyState
      icon={<SearchX />}
      title="Nothing matches"
      description="Try another search, or clear the filters."
      secondary={
        <Button size="sm" variant="secondary" onClick={onClear}>
          Clear filters
        </Button>
      }
    />
  )
}

const includes = (q: string, ...values: (string | null | undefined)[]) =>
  !q || values.some((v) => v?.toLowerCase().includes(q))

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

const STATUSES = Object.keys(BROADCAST_STATUS)

/**
 * The broadcasts page, loaded and loading: ONE view, so the skeleton cannot drift
 * from the page (docs/decisions/skeletons.md).
 *
 * ⚠ STRUCTURE COMES FROM THE SHAPE ALONE (header action, empty state or list,
 * the filters); `data` only fills the bones. The same file draws both.
 *
 * ⚠ FILTERED IN THE BROWSER. These lists come back whole from the API and run
 * to tens of rows, so a round trip per keystroke would only add latency.
 */
export function BroadcastsView({
  shape,
  data,
}: {
  shape: BroadcastsShape
  data?: BroadcastsData
}) {
  const loading = data === undefined
  const broadcasts = data?.broadcasts ?? NONE

  const [query, setQuery] = React.useState("")
  const [status, setStatus] = React.useState("")
  const [segment, setSegment] = React.useState("")
  const [view, setView] = useRememberedView("broadcasts", shape.view)

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
  const isFiltered = status !== "" || segment !== "" || q.length > 0
  const clear = () => {
    setQuery("")
    setStatus("")
    setSegment("")
  }

  const rows: (BroadcastSummary | undefined)[] = loading
    ? Array.from({ length: shape.rows }, () => undefined)
    : shown
  const hasRows = shape.rows > 0
  const Grid = loading ? StaticGrid : ListGrid
  const Body = loading ? ListBody : MotionBody
  const RowEl = loading ? ListRow : MotionRow

  return (
    <BoneScope id="broadcasts" loading={loading}>
      <Page aria-busy={loading}>
        <PageHeader>
          <PageHeaderRow>
            {loading ? (
              <PlaceholderTitle text={PAGE_COPY.broadcasts.title} className={TITLE} />
            ) : (
              <PageTitle>{PAGE_COPY.broadcasts.title}</PageTitle>
            )}
            {/*
             * ⚠ HIDDEN WHILE THE LIST IS EMPTY, BECAUSE THE EMPTY STATE ALREADY
             * CARRIES THIS ACTION. Two buttons for one action, eight inches
             * apart, reads as two different things - and the one in the header is
             * the smaller and less explained of the two, so it wins attention it
             * has not earned. The empty state's version says what will happen;
             * this one just says a noun.
             */}
            {hasRows && (
              <PageActions>
                <NewBroadcastButton />
              </PageActions>
            )}
          </PageHeaderRow>
          <PageDescription>{PAGE_COPY.broadcasts.description}</PageDescription>
        </PageHeader>

        <PageBody>
          {data?.error !== undefined ? (
            <PanelError title="Could not load broadcasts" message={data.error} />
          ) : !hasRows ? (
            <EmptyState
              icon={<Megaphone />}
              title="No broadcasts yet"
              description="Write one, point it at a segment, and send it. Drafts are safe to leave lying around."
              secondary={<NewBroadcastButton />}
            />
          ) : (
            <div>
              <ListToolbar>
                <ListSearch
                  value={query}
                  onChange={setQuery}
                  placeholder="Search broadcasts"
                  label="Search broadcasts"
                />
                <ListResults
                  count={shown.length}
                  query={query}
                  filtered={status !== "" || segment !== ""}
                  noun={["broadcast", "broadcasts"]}
                  onClear={clear}
                />
                <ListToolbarEnd>
                  {shape.statusFilter && (
                    <FilterSelect
                      value={status}
                      onValueChange={setStatus}
                      label="Status"
                      allLabel="All statuses"
                      options={STATUSES.map((s) => ({
                        value: s,
                        label: BROADCAST_STATUS[s] ?? s,
                        icon: <StatusDot tone={describeStatus(broadcastTone(s)).tone} />,
                      }))}
                    />
                  )}
                  {shape.segmentFilter && (
                    <FilterSelect
                      value={segment}
                      onValueChange={setSegment}
                      label="Segment"
                      allLabel="All segments"
                      triggerWidth={176}
                      options={segments.map(([val, lbl]) => ({ value: val, label: lbl }))}
                    />
                  )}
                  <ViewToggle value={view} onChange={setView} />
                </ListToolbarEnd>
              </ListToolbar>

              <div className="pt-4">
                <BoneRegion id="list">
                  {!loading && shown.length === 0 ? (
                    <NoMatch onClear={clear} />
                  ) : view === "grid" ? (
                    <Grid>
                      {rows.map((b, i) => {
                        const seed = () =>
                          b &&
                          seedShape(
                            broadcastShape,
                            b.id,
                            broadcastSeed(b.status as BroadcastStatus),
                          )
                        const body = (
                          <>
                            <div className="flex items-center gap-3">
                              <span className="grid size-9 shrink-0 place-items-center rounded-xl border bg-muted/50 text-muted-foreground transition-colors group-hover:text-foreground">
                                <Megaphone className="size-4" />
                              </span>
                              <div className="min-w-0 flex-1">
                                <Bone
                                  id="name"
                                  width={NAME_WIDTHS[i % NAME_WIDTHS.length]}
                                  lineHeight={24}
                                >
                                  {b && (
                                    <p className="truncate font-medium">{b.name}</p>
                                  )}
                                </Bone>
                                <Bone
                                  id="subject"
                                  width={SUBJ_WIDTHS[i % SUBJ_WIDTHS.length]}
                                  lineHeight={16}
                                >
                                  {b && (
                                    <p className="truncate text-xs text-muted-foreground">
                                      {b.subject || <em>No subject yet</em>}
                                    </p>
                                  )}
                                </Bone>
                              </div>
                            </div>
                            <Bone
                              id="status"
                              shape="box"
                              width={76}
                              height={20}
                              radius={9999}
                              inline
                            >
                              {b && (
                                <Status
                                  status={broadcastTone(b.status)}
                                  label={BROADCAST_STATUS[b.status] ?? b.status}
                                />
                              )}
                            </Bone>
                            <div className="mt-auto flex items-center justify-between gap-2 text-xs text-muted-foreground">
                              <Bone id="segment" width={80} lineHeight={16}>
                                {b && (
                                  <span className="flex min-w-0 items-center gap-1.5 truncate">
                                    <Layers className="size-3.5 shrink-0" />
                                    <span className="truncate">
                                      {b.segment_name ?? "No segment"}
                                    </span>
                                  </span>
                                )}
                              </Bone>
                              <Bone id="updated" width={72} lineHeight={16} align="end">
                                {b && (
                                  <span
                                    className="shrink-0"
                                    title={b.sent_at ?? b.created_at}
                                  >
                                    {b.recipient_count !== null &&
                                      `${formatNumber(b.recipient_count)} · `}
                                    <Time iso={b.sent_at ?? b.created_at} />
                                  </span>
                                )}
                              </Bone>
                            </div>
                          </>
                        )
                        return (
                          <BoneScope key={b?.id ?? i} id={`row-${i}`} unit>
                            <div
                              onMouseEnter={seed}
                              onFocus={seed}
                              onClick={seed}
                              className="h-full"
                            >
                              {b ? (
                                <ListCard id={b.id} href={`/broadcasts/${b.id}`}>
                                  {body}
                                </ListCard>
                              ) : (
                                <StaticCard>{body}</StaticCard>
                              )}
                            </div>
                          </BoneScope>
                        )
                      })}
                    </Grid>
                  ) : (
                    <ListTable>
                      <ListHeader>
                        <ListHead>Name</ListHead>
                        {/* F = 216 (Status 120, Updated 96): Recipients 104 -> 540 and Segment 128 -> 668, both under sm (704). */}
                        <ListHead className="w-[7.5rem]">Status</ListHead>
                        <ListHead hideBelow="sm" className="w-[8rem]">
                          Segment
                        </ListHead>
                        <ListHead hideBelow="sm" className="w-[6.5rem] text-right">
                          Recipients
                        </ListHead>
                        <ListHead className="w-[6rem] text-right">Updated</ListHead>
                      </ListHeader>
                      <Body>
                        {rows.map((b, i) => {
                          const seed = () =>
                            b &&
                            seedShape(
                              broadcastShape,
                              b.id,
                              broadcastSeed(b.status as BroadcastStatus),
                            )
                          return (
                            <BoneScope key={b?.id ?? i} id={`row-${i}`} unit>
                              <RowEl
                                {...(b
                                  ? { href: `/broadcasts/${b.id}`, onClick: seed }
                                  : {})}
                                clickable
                              >
                                <ListCell>
                                  <Bone
                                    id="name"
                                    width={NAME_WIDTHS[i % NAME_WIDTHS.length]}
                                    lineHeight={20}
                                  >
                                    {b && (
                                      <Link
                                        href={`/broadcasts/${b.id}`}
                                        onMouseEnter={seed}
                                        onFocus={seed}
                                        onClick={seed}
                                        title={b.name}
                                        className="block truncate font-medium outline-none hover:underline focus-visible:underline"
                                      >
                                        {b.name}
                                      </Link>
                                    )}
                                  </Bone>
                                  <Bone
                                    id="subject"
                                    width={SUBJ_WIDTHS[i % SUBJ_WIDTHS.length]}
                                    lineHeight={16}
                                  >
                                    {b && (
                                      <p
                                        className="truncate text-xs text-muted-foreground"
                                        title={b.subject || undefined}
                                      >
                                        {b.subject || <em>No subject yet</em>}
                                      </p>
                                    )}
                                  </Bone>
                                </ListCell>
                                <ListCell>
                                  <Bone
                                    id="status"
                                    shape="box"
                                    width={76}
                                    height={20}
                                    radius={9999}
                                    inline
                                  >
                                    {b && (
                                      <Status
                                        status={broadcastTone(b.status)}
                                        label={BROADCAST_STATUS[b.status] ?? b.status}
                                      />
                                    )}
                                  </Bone>
                                </ListCell>
                                <ListCell hideBelow="sm">
                                  <Bone id="segment" width={72} lineHeight={16}>
                                    {b && (
                                      <span
                                        className="block truncate text-xs text-muted-foreground"
                                        title={b.segment_name ?? undefined}
                                      >
                                        {b.segment_name ?? "-"}
                                      </span>
                                    )}
                                  </Bone>
                                </ListCell>
                                <ListCell hideBelow="sm" className="tabular text-right text-xs text-muted-foreground">
                                  <Bone
                                    id="recipients"
                                    width={48}
                                    lineHeight={16}
                                    align="end"
                                  >
                                    {b &&
                                      (b.recipient_count === null
                                        ? "-"
                                        : formatNumber(b.recipient_count))}
                                  </Bone>
                                </ListCell>
                                <ListCell
                                  className="text-right text-xs whitespace-nowrap text-muted-foreground"
                                  title={b ? (b.sent_at ?? b.created_at) : undefined}
                                >
                                  <Bone
                                    id="updated"
                                    width={64}
                                    lineHeight={16}
                                    align="end"
                                  >
                                    {b && <Time iso={b.sent_at ?? b.created_at} />}
                                  </Bone>
                                </ListCell>
                              </RowEl>
                            </BoneScope>
                          )
                        })}
                      </Body>
                    </ListTable>
                  )}
                </BoneRegion>
              </div>
            </div>
          )}
        </PageBody>
        {data && data.error === undefined && (
          <RememberShape
            def={broadcastsShape}
            shape={{ ...shape, view }}
            skip={isFiltered}
          />
        )}
      </Page>
    </BoneScope>
  )
}
