"use client"

import * as React from "react"
import { NONE } from "@/lib/react"
import Link from "next/link"
import { Layers, SearchX } from "lucide-react"
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
import { RememberShape, useRememberedShape } from "@/components/list/remembered-shapes"
import {
  ListCell,
  ListHead,
  ListHeader,
  ListRow,
  ListBody,
  ListTable,
} from "@/components/list/table"
import {
  ListResults,
  ListSearch,
  ListToolbar,
  ListToolbarEnd,
  ViewToggle,
  useRememberedView,
} from "@/components/list/toolbar"
import { NewSegmentButton } from "@/components/new-segment"
import { PanelError } from "@/components/panel-error"
import { SegmentActions } from "@/components/segment-actions"
import { formatNumber } from "@/lib/format"
import { PAGE_COPY } from "@/lib/page-copy"
import {
  segmentsShape,
  type SegmentsData,
  type SegmentsShape,
} from "@/lib/shapes/segments"
import type { SegmentRow } from "@/lib/types"
import { Time } from "@/components/time"

/** What loading.tsx renders: the view with the shape this workspace last had. */
export function SegmentsLoading() {
  return <SegmentsView shape={useRememberedShape(segmentsShape)} />
}

const NAME_WIDTHS = ["62%", "48%", "72%", "55%"]
const DESCRIPTION_WIDTHS = ["78%", "64%", "84%", "58%"]

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

/**
 * The segments page, loaded and loading: ONE view, so the skeleton cannot drift
 * from the page (docs/decisions/skeletons.md).
 *
 * ⚠ STRUCTURE COMES FROM THE SHAPE ALONE (header action, empty state or list);
 * `data` only fills the bones. The same file draws both.
 *
 * ⚠ FILTERED IN THE BROWSER. These lists come back whole from the API and run
 * to tens of rows, so a round trip per keystroke would only add latency.
 */
export function SegmentsView({
  shape,
  data,
}: {
  shape: SegmentsShape
  data?: SegmentsData
}) {
  const loading = data === undefined
  const segments = data?.segments ?? NONE

  const [query, setQuery] = React.useState("")
  const [view, setView] = useRememberedView("segments", shape.view)

  const q = query.trim().toLowerCase()
  const shown = segments.filter((s) => includes(q, s.name, s.description))
  const isFiltered = q.length > 0
  const clear = () => setQuery("")
  const href = (s: SegmentRow) => `/contacts?segment_id=${s.id}`

  const rows: (SegmentRow | undefined)[] = loading
    ? Array.from({ length: shape.rows }, () => undefined)
    : shown
  const hasRows = shape.rows > 0
  const Grid = loading ? StaticGrid : ListGrid
  const Body = loading ? ListBody : MotionBody
  const RowEl = loading ? ListRow : MotionRow

  return (
    <BoneScope id="segments" loading={loading}>
      <Page aria-busy={loading}>
        <PageHeader>
          <PageHeaderRow>
            {loading ? (
              <PlaceholderTitle text={PAGE_COPY.segments.title} className={TITLE} />
            ) : (
              <PageTitle>{PAGE_COPY.segments.title}</PageTitle>
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
                <NewSegmentButton />
              </PageActions>
            )}
          </PageHeaderRow>
          <PageDescription>{PAGE_COPY.segments.description}</PageDescription>
        </PageHeader>

        <PageBody>
          {data?.error !== undefined ? (
            <PanelError title="Could not load segments" message={data.error} />
          ) : !hasRows ? (
            <EmptyState
              icon={<Layers />}
              title="No segments yet"
              description="Create one, add contacts to it, and point a broadcast at it."
              secondary={<NewSegmentButton />}
            />
          ) : (
            <div>
              <ListToolbar>
                <ListSearch
                  value={query}
                  onChange={setQuery}
                  placeholder="Search segments"
                  label="Search segments"
                />
                <ListResults
                  count={shown.length}
                  query={query}
                  filtered={false}
                  noun={["segment", "segments"]}
                  onClear={clear}
                />
                <ListToolbarEnd>
                  <ViewToggle value={view} onChange={setView} />
                </ListToolbarEnd>
              </ListToolbar>

              <div className="pt-4">
                <BoneRegion id="list">
                  {!loading && shown.length === 0 ? (
                    <NoMatch onClear={clear} />
                  ) : view === "grid" ? (
                    <Grid>
                      {rows.map((s, i) => {
                        const body = (
                          <>
                            <div className="flex items-center gap-3 pr-8">
                              <span className="grid size-9 shrink-0 place-items-center rounded-xl border bg-muted/50 text-muted-foreground transition-colors group-hover:text-foreground">
                                <Layers className="size-4" />
                              </span>
                              <div className="min-w-0 flex-1">
                                <Bone
                                  id="name"
                                  width={NAME_WIDTHS[i % NAME_WIDTHS.length]}
                                  lineHeight={24}
                                >
                                  {s && (
                                    <p className="truncate font-medium">{s.name}</p>
                                  )}
                                </Bone>
                                {/*
                                 * ⚠ THE DESCRIPTION'S LINE IS ALWAYS THERE (2026-11-18).
                                 * It is optional, and a skeleton cannot know which rows
                                 * have one; inside the name's bone it had no bar, so the
                                 * title jumped up and the description appeared from
                                 * nothing. Its own bone draws the line; a segment without
                                 * one keeps the line empty, and its bar fades in place.
                                 */}
                                <Bone
                                  id="description"
                                  width={
                                    DESCRIPTION_WIDTHS[i % DESCRIPTION_WIDTHS.length]
                                  }
                                  lineHeight={16}
                                >
                                  {s && (
                                    <p className="h-4 truncate text-xs text-muted-foreground">
                                      {s.description}
                                    </p>
                                  )}
                                </Bone>
                              </div>
                            </div>
                            <div className="mt-auto flex items-end justify-between gap-2">
                              <Bone id="contacts" width={80} lineHeight={32}>
                                {s && (
                                  <p>
                                    <span className="tabular text-2xl font-medium tracking-tight">
                                      {formatNumber(s.contact_count)}
                                    </span>{" "}
                                    <span className="text-xs text-muted-foreground">
                                      {s.contact_count === 1 ? "contact" : "contacts"}
                                    </span>
                                  </p>
                                )}
                              </Bone>
                              <Bone id="created" width={60} lineHeight={16} align="end">
                                {s && (
                                  <span
                                    className="text-xs text-muted-foreground"
                                    title={s.created_at}
                                  >
                                    <Time iso={s.created_at} />
                                  </span>
                                )}
                              </Bone>
                            </div>
                          </>
                        )
                        return (
                          <BoneScope key={s?.id ?? i} id={`row-${i}`} unit>
                            {s ? (
                              <ListCard
                                id={s.id}
                                href={href(s)}
                                menu={<SegmentActions id={s.id} name={s.name} />}
                              >
                                {body}
                              </ListCard>
                            ) : (
                              <StaticCard>{body}</StaticCard>
                            )}
                          </BoneScope>
                        )
                      })}
                    </Grid>
                  ) : (
                    <ListTable>
                      <ListHeader>
                        <ListHead>Name</ListHead>
                        <ListHead className="w-[6rem] text-right">Contacts</ListHead>
                        <ListHead className="w-[6rem] text-right">Created</ListHead>
                        <ListHead className="w-[3.75rem]">
                          <span className="sr-only">Actions</span>
                        </ListHead>
                      </ListHeader>
                      <Body>
                        {rows.map((s, i) => (
                          <BoneScope key={s?.id ?? i} id={`row-${i}`} unit>
                            <RowEl clickable {...(s ? { href: href(s) } : {})}>
                              <ListCell>
                                <Bone
                                  id="name"
                                  width={NAME_WIDTHS[i % NAME_WIDTHS.length]}
                                  lineHeight={20}
                                >
                                  {s && (
                                    <Link
                                      href={href(s)}
                                      title={s.name}
                                      className="block truncate font-medium outline-none hover:underline focus-visible:underline"
                                    >
                                      {s.name}
                                    </Link>
                                  )}
                                </Bone>
                                {/* Its own line, as in the grid: see the card above. */}
                                <Bone
                                  id="description"
                                  width={
                                    DESCRIPTION_WIDTHS[i % DESCRIPTION_WIDTHS.length]
                                  }
                                  lineHeight={16}
                                >
                                  {s && (
                                    <p
                                      className="h-4 truncate text-xs text-muted-foreground"
                                      title={s.description ?? undefined}
                                    >
                                      {s.description}
                                    </p>
                                  )}
                                </Bone>
                              </ListCell>
                              <ListCell className="tabular text-right">
                                <Bone
                                  id="contacts"
                                  width={48}
                                  lineHeight={20}
                                  align="end"
                                >
                                  {s && formatNumber(s.contact_count)}
                                </Bone>
                              </ListCell>
                              <ListCell
                                className="text-right text-xs whitespace-nowrap text-muted-foreground"
                                title={s?.created_at}
                              >
                                <Bone
                                  id="created"
                                  width={64}
                                  lineHeight={16}
                                  align="end"
                                >
                                  {s && <Time iso={s.created_at} />}
                                </Bone>
                              </ListCell>
                              <ListCell className="py-1.5 text-right">
                                {s && <SegmentActions id={s.id} name={s.name} />}
                              </ListCell>
                            </RowEl>
                          </BoneScope>
                        ))}
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
            def={segmentsShape}
            shape={{ ...shape, view }}
            skip={isFiltered}
          />
        )}
      </Page>
    </BoneScope>
  )
}
