"use client"

import * as React from "react"
import { NONE } from "@/lib/react"
import { SearchX, Tag, Users } from "lucide-react"
import { Badge } from "@repo/ui/components/badge/badge"
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
  FilterSelect,
  ListResults,
  ListSearch,
  ListToolbar,
  ListToolbarEnd,
  ViewToggle,
  useRememberedView,
} from "@/components/list/toolbar"
import { NewTopicButton } from "@/components/new-topic"
import { PanelError } from "@/components/panel-error"
import { TopicActions } from "@/components/topic-actions"
import { formatNumber } from "@/lib/format"
import { PAGE_COPY } from "@/lib/page-copy"
import { topicsShape, type TopicsData, type TopicsShape } from "@/lib/shapes/topics"
import type { TopicRow } from "@/lib/types"

/** What loading.tsx renders: the view with the shape this workspace last had. */
export function TopicsLoading() {
  return <TopicsView shape={useRememberedShape(topicsShape)} />
}

const NAME_WIDTHS = ["62%", "48%", "72%", "55%"]
const DESCRIPTION_WIDTHS = ["78%", "64%", "84%", "58%"]

const DEFAULT_LABEL: Record<string, string> = {
  opt_in: "Opt-out by default",
  opt_out: "Opt-in required",
}

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
 * The topics page, loaded and loading: ONE view, so the skeleton cannot drift
 * from the page (docs/decisions/skeletons.md).
 *
 * ⚠ STRUCTURE COMES FROM THE SHAPE ALONE (header action, empty state or list);
 * `data` only fills the bones. The same file draws both.
 *
 * ⚠ FILTERED IN THE BROWSER. These lists come back whole from the API and run
 * to tens of rows, so a round trip per keystroke would only add latency.
 */
export function TopicsView({ shape, data }: { shape: TopicsShape; data?: TopicsData }) {
  const loading = data === undefined
  const topics = data?.topics ?? NONE

  const [query, setQuery] = React.useState("")
  const [visibility, setVisibility] = React.useState("")
  const [view, setView] = useRememberedView("topics", shape.view)

  const q = query.trim().toLowerCase()
  const shown = topics.filter(
    (t) =>
      includes(q, t.name, t.description) &&
      (!visibility || t.visibility === visibility),
  )
  const isFiltered = visibility !== "" || q.length > 0
  const clear = () => {
    setQuery("")
    setVisibility("")
  }
  const defaultLabel = (t: TopicRow) =>
    DEFAULT_LABEL[t.default_subscription] ?? "Opt-in required"

  const rows: (TopicRow | undefined)[] = loading
    ? Array.from({ length: shape.rows }, () => undefined)
    : shown
  const hasRows = shape.rows > 0
  const Grid = loading ? StaticGrid : ListGrid
  const Body = loading ? ListBody : MotionBody
  const RowEl = loading ? ListRow : MotionRow

  return (
    <BoneScope id="topics" loading={loading}>
      <Page aria-busy={loading}>
        <PageHeader>
          <PageHeaderRow>
            {loading ? (
              <PlaceholderTitle text={PAGE_COPY.topics.title} className={TITLE} />
            ) : (
              <PageTitle>{PAGE_COPY.topics.title}</PageTitle>
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
                <NewTopicButton />
              </PageActions>
            )}
          </PageHeaderRow>
          <PageDescription>{PAGE_COPY.topics.description}</PageDescription>
        </PageHeader>

        <PageBody>
          {data?.error !== undefined ? (
            <PanelError title="Could not load topics" message={data.error} />
          ) : !hasRows ? (
            <EmptyState
              icon={<Tag />}
              title="No topics yet"
              description="Without topics, unsubscribing is all-or-nothing. A couple of topics lets somebody keep the receipts and drop the newsletter."
              secondary={<NewTopicButton />}
            />
          ) : (
            <div>
              <ListToolbar>
                <ListSearch
                  value={query}
                  onChange={setQuery}
                  placeholder="Search topics"
                  label="Search topics"
                />
                <ListResults
                  count={shown.length}
                  query={query}
                  filtered={visibility !== ""}
                  noun={["topic", "topics"]}
                  onClear={clear}
                />
                <ListToolbarEnd>
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
                </ListToolbarEnd>
              </ListToolbar>

              <div className="pt-4">
                <BoneRegion id="list">
                  {!loading && shown.length === 0 ? (
                    <NoMatch onClear={clear} />
                  ) : view === "grid" ? (
                    <Grid>
                      {rows.map((t, i) => {
                        const body = (
                          <>
                            <div className="flex items-center gap-3 pr-8">
                              <span className="grid size-9 shrink-0 place-items-center rounded-xl border bg-muted/50 text-muted-foreground transition-colors group-hover:text-foreground">
                                <Tag className="size-4" />
                              </span>
                              <div className="min-w-0 flex-1">
                                <Bone
                                  id="name"
                                  width={NAME_WIDTHS[i % NAME_WIDTHS.length]}
                                  lineHeight={24}
                                >
                                  {t && <p className="truncate font-medium">{t.name}</p>}
                                </Bone>
                                {/*
                                 * ⚠ THE DESCRIPTION'S LINE IS ALWAYS THERE, as on
                                 * segments (components/segments-view.tsx). Inside the
                                 * name's bone it had no bar, so every card grew 8px
                                 * when its data arrived. A topic without one keeps the
                                 * line empty.
                                 */}
                                <Bone
                                  id="description"
                                  width={DESCRIPTION_WIDTHS[i % DESCRIPTION_WIDTHS.length]}
                                  lineHeight={16}
                                >
                                  {t && (
                                    <p className="h-4 truncate text-xs text-muted-foreground">
                                      {t.description}
                                    </p>
                                  )}
                                </Bone>
                              </div>
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              <Bone
                                id="default"
                                shape="box"
                                width={128}
                                height={26}
                                radius={9999}
                                inline
                              >
                                {t && <Badge tone="neutral">{defaultLabel(t)}</Badge>}
                              </Bone>
                              <Bone
                                id="visibility"
                                shape="box"
                                width={60}
                                height={26}
                                radius={9999}
                                inline
                              >
                                {t && (
                                  <Badge
                                    tone={
                                      t.visibility === "public" ? "info" : "neutral"
                                    }
                                    className="capitalize"
                                  >
                                    {t.visibility}
                                  </Badge>
                                )}
                              </Bone>
                            </div>
                            <div className="mt-auto">
                              <Bone id="subscribers" width={90} lineHeight={16}>
                                {t && (
                                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                    <Users className="size-3.5" />
                                    <span className="tabular text-foreground">
                                      {formatNumber(t.subscriber_count)}
                                    </span>
                                    {t.subscriber_count === 1
                                      ? " subscriber"
                                      : " subscribers"}
                                  </p>
                                )}
                              </Bone>
                            </div>
                          </>
                        )
                        return (
                          <BoneScope key={t?.id ?? i} id={`row-${i}`} unit>
                            {t ? (
                              <ListCard id={t.id} menu={<TopicActions topic={t} />}>
                                {body}
                              </ListCard>
                            ) : (
                              <StaticCard linked={false}>{body}</StaticCard>
                            )}
                          </BoneScope>
                        )
                      })}
                    </Grid>
                  ) : (
                    <ListTable>
                      <ListHeader>
                        <ListHead>Name</ListHead>
                        {/* F = 276 (Visibility 104, Subscribers 112, actions 60): Default 160 -> 656 -> sm (704). */}
                        <ListHead hideBelow="sm" className="w-[10rem]">
                          Default
                        </ListHead>
                        <ListHead className="w-[6.5rem]">Visibility</ListHead>
                        <ListHead className="w-[7rem] text-right">Subscribers</ListHead>
                        <ListHead className="w-[3.75rem]">
                          <span className="sr-only">Actions</span>
                        </ListHead>
                      </ListHeader>
                      <Body>
                        {rows.map((t, i) => (
                          <BoneScope key={t?.id ?? i} id={`row-${i}`} unit>
                            <RowEl>
                              <ListCell>
                                <Bone
                                  id="name"
                                  width={NAME_WIDTHS[i % NAME_WIDTHS.length]}
                                  lineHeight={20}
                                >
                                  {t && (
                                    <p className="truncate font-medium" title={t.name}>
                                      {t.name}
                                    </p>
                                  )}
                                </Bone>
                                {/* Its own line, as in the grid: see the card above. */}
                                <Bone
                                  id="description"
                                  width={DESCRIPTION_WIDTHS[i % DESCRIPTION_WIDTHS.length]}
                                  lineHeight={16}
                                >
                                  {t && (
                                    <p
                                      className="h-4 truncate text-xs text-muted-foreground"
                                      title={t.description ?? undefined}
                                    >
                                      {t.description}
                                    </p>
                                  )}
                                </Bone>
                              </ListCell>
                              <ListCell hideBelow="sm">
                                <Bone
                                  id="default"
                                  shape="box"
                                  width={128}
                                  height={26}
                                  radius={9999}
                                  inline
                                >
                                  {t && <Badge tone="neutral">{defaultLabel(t)}</Badge>}
                                </Bone>
                              </ListCell>
                              <ListCell>
                                <Bone
                                  id="visibility"
                                  shape="box"
                                  width={60}
                                  height={26}
                                  radius={9999}
                                  inline
                                >
                                  {t && (
                                    <Badge
                                      tone={
                                        t.visibility === "public" ? "info" : "neutral"
                                      }
                                      className="capitalize"
                                    >
                                      {t.visibility}
                                    </Badge>
                                  )}
                                </Bone>
                              </ListCell>
                              <ListCell className="tabular text-right">
                                <Bone
                                  id="subscribers"
                                  width={48}
                                  lineHeight={20}
                                  align="end"
                                >
                                  {t && formatNumber(t.subscriber_count)}
                                </Bone>
                              </ListCell>
                              <ListCell className="py-1.5 text-right">
                                {t && <TopicActions topic={t} />}
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
            def={topicsShape}
            shape={{ ...shape, view }}
            skip={isFiltered}
          />
        )}
      </Page>
    </BoneScope>
  )
}
