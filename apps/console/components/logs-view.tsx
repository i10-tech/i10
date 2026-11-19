"use client"

import * as React from "react"
import { NONE } from "@/lib/react"
import { AnimatePresence, motion } from "motion/react"
import { ChevronRight, ScrollText, SearchX } from "lucide-react"
import { Bone, BoneRegion, BoneScope } from "@repo/ui/components/bone/bone"
import { CopyButton } from "@repo/ui/components/copy-button/copy-button"
import { motionTokens } from "@repo/ui/components/lib/motion-tokens"
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
import { cn } from "cn"
import { EmptyState } from "@/components/empty-state"
import { ApiButton } from "@/components/list/api-button"
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
  UrlRangeSelect,
} from "@/components/list/toolbar"
import { ListRegion, UrlList, useUrlList } from "@/components/list/url-state"
import { LoadMore } from "@/components/load-more"
import { PanelError } from "@/components/panel-error"
import { StatusDot } from "@/components/status"
import { Time } from "@/components/time"
import { formatDuration } from "@/lib/format"
import { PAGE_COPY } from "@/lib/page-copy"
import { logsShape, type LogsData, type LogsShape } from "@/lib/shapes/logs"
import { SNIPPETS } from "@/lib/snippets"
import type { RequestRow } from "@/lib/types"

/** What loading.tsx renders: the view with the shape this workspace last had. */
export function LogsLoading() {
  return <LogsView shape={useRememberedShape(logsShape)} />
}

const FILTERS = ["search", "days", "status", "method", "api_key_id"]
const ENDPOINT_WIDTHS = ["64%", "45%", "80%", "55%", "70%"]

/**
 * The API request log.
 *
 * The API request log, loaded and loading: ONE view, so the skeleton cannot drift
 * from the page (docs/decisions/skeletons.md).
 *
 * ⚠ THE DURATION COLUMN IS WHY THIS PAGE EARNS ITS PLACE. "The API is slow" is
 * the hardest report to act on, and the answer is almost always either a cold
 * key verification or a caller in another region. Per-request timings turn it
 * into a number somebody can argue with.
 *
 * ⚠ AND THE STATUS FILTER IS TWO STATES, NOT A DROPDOWN OF CODES. In practice
 * the question is "show me the failures"; filtering to a specific 429 is a
 * refinement almost nobody needs and every extra control costs a glance.
 *
 * ⚠ A ROW OPENS IN PLACE, NOT ON ANOTHER PAGE. There is no body to show (see
 * the page), so what is left - the key, the whole user agent, the exact time
 * - fits under the row.
 */
export function LogsView({ shape, data }: { shape: LogsShape; data?: LogsData }) {
  const loading = data === undefined
  return (
    <BoneScope id="logs" loading={loading}>
      <Page aria-busy={loading}>
        <PageHeader>
          <PageHeaderRow>
            {loading ? (
              <PlaceholderTitle text={PAGE_COPY.logs.title} className={TITLE} />
            ) : (
              <PageTitle>{PAGE_COPY.logs.title}</PageTitle>
            )}
            <PageActions>
              <ApiButton snippet={SNIPPETS.logs} />
            </PageActions>
          </PageHeaderRow>
          <PageDescription>{PAGE_COPY.logs.description}</PageDescription>
        </PageHeader>

        <PageBody width="full">
          {data?.error !== undefined ? (
            <PanelError title="Could not load the request log" message={data.error} />
          ) : (
            <UrlList className="space-y-4">
              <LogsContent shape={shape} data={data} loading={loading} />
            </UrlList>
          )}
        </PageBody>
      </Page>
    </BoneScope>
  )
}

function LogsContent({
  shape,
  data,
  loading,
}: {
  shape: LogsShape
  data?: LogsData
  loading: boolean
}) {
  const { params, commit } = useUrlList()
  const filtered = FILTERS.some((f) => Boolean(params.get(f)))
  const [open, setOpen] = React.useState<string | null>(null)
  const rows = data?.rows ?? NONE
  const apiKeys = data?.apiKeys ?? NONE
  const hasRows = shape.rows > 0

  const keyName = (id: string | null) => apiKeys.find((k) => k.id === id)?.name ?? null

  const displayRows: (RequestRow | undefined)[] = loading
    ? Array.from({ length: shape.rows }, () => undefined)
    : rows

  if (!hasRows && !filtered) {
    return (
      <EmptyState
        icon={<ScrollText />}
        title="No requests yet"
        description="Calls your servers make to the API appear here, with the status and timing we answered with."
      />
    )
  }

  return (
    <>
      <ListToolbar>
        <UrlListSearch
          placeholder="Search endpoints, e.g. /emails"
          label="Search requests"
        />
        <UrlListResults params={FILTERS} />
        <ListToolbarEnd>
          <UrlRangeSelect />
          <UrlFilterSelect
            param="status"
            label="Status"
            allLabel="All statuses"
            options={[
              { value: "ok", label: "Succeeded", icon: <StatusDot tone="success" /> },
              { value: "error", label: "Failed", icon: <StatusDot tone="danger" /> },
            ]}
          />
          <UrlFilterSelect
            param="method"
            label="Method"
            allLabel="All methods"
            className="w-36"
            options={["GET", "POST", "PATCH", "DELETE"].map((m) => ({
              value: m,
              label: m,
            }))}
          />
          {shape.keys > 0 && (
            <UrlFilterSelect
              param="api_key_id"
              label="API key"
              allLabel="All API keys"
              triggerWidth={176}
              options={apiKeys.map((k) => ({ value: k.id, label: k.name }))}
            />
          )}
        </ListToolbarEnd>
      </ListToolbar>

      <ListRegion>
        <div className="space-y-4">
          <BoneRegion id="list">
            {!loading && rows.length === 0 ? (
              <EmptyState
                icon={<SearchX />}
                title="Nothing matches those filters"
                description="Try a wider date range, or clear the filters."
                secondary={
                  <button
                    type="button"
                    onClick={() => commit((p) => FILTERS.forEach((f) => p.delete(f)))}
                    className="h-8 cursor-pointer rounded-lg border px-3 text-sm transition-colors hover:bg-muted"
                  >
                    Clear filters
                  </button>
                }
              />
            ) : (
              // F = 488 (chevron 40, Method 96, Status 96, Duration 112, When 144),
              // Endpoint keeps 220: min 708. Client 192 -> 900 -> lg (928).
              <ListTable className="[&_table]:min-w-[708px]">
                <ListHeader>
                  <ListHead className="w-10 pr-0" />
                  <ListHead className="w-[6rem]">Method</ListHead>
                  <ListHead>Endpoint</ListHead>
                  <ListHead className="w-[6rem]">Status</ListHead>
                  <ListHead className="w-[7rem] text-right">Duration</ListHead>
                  <ListHead hideBelow="lg" className="w-[12rem]">Client</ListHead>
                  <ListHead className="w-[9rem] text-right">When</ListHead>
                </ListHeader>
                {/* No `divide-y`: the folded detail rows would each draw a second line. */}
                <tbody>
                  {displayRows.map((row, i) => {
                    const expanded = row ? open === row.id : false
                    return (
                      <BoneScope key={row?.id ?? i} id={`row-${i}`} unit>
                        <tr
                          className={cn(
                            rowClass,
                            "cursor-pointer",
                            // Open, the row and its details read as one block: one
                            // fill, and no rule between them.
                            expanded &&
                              "[&>td]:border-b-0 [&>td]:[--cell-fill:var(--surface-muted)]",
                          )}
                          onClick={() => {
                            if (!row) return
                            setOpen(expanded ? null : row.id)
                          }}
                          aria-expanded={expanded}
                        >
                          <ListCell className="pr-0">
                            {/* Static, so the skeleton draws it too. */}
                            <motion.span
                              className="grid size-4 place-items-center"
                              initial={false}
                              animate={{ rotate: expanded ? 90 : 0 }}
                              transition={motionTokens.spring.snappy}
                            >
                              <ChevronRight
                                className={cn(
                                  "size-3.5 text-muted-foreground transition-colors",
                                  expanded && "text-foreground",
                                )}
                              />
                            </motion.span>
                          </ListCell>
                          <ListCell>
                            <Bone id="method" width={36} lineHeight={16}>
                              {row && (
                                <span className="font-mono text-2xs font-medium text-muted-foreground">
                                  {row.method}
                                </span>
                              )}
                            </Bone>
                          </ListCell>
                          <ListCell>
                            <Bone
                              id="endpoint"
                              width={ENDPOINT_WIDTHS[i % ENDPOINT_WIDTHS.length]}
                              lineHeight={16}
                            >
                              {row && (
                                <>
                                  <span
                                    className="block truncate font-mono text-xs"
                                    title={row.path}
                                  >
                                    {row.path}
                                  </span>
                                  {row.error_name && (
                                    <span
                                      className="block truncate text-2xs text-danger"
                                      title={row.error_name}
                                    >
                                      {row.error_name}
                                    </span>
                                  )}
                                </>
                              )}
                            </Bone>
                          </ListCell>
                          <ListCell>
                            <Bone id="status" width={32} lineHeight={16}>
                              {row && (
                                <span
                                  className={cn(
                                    "tabular font-mono text-xs",
                                    row.status >= 500 && "text-danger",
                                    row.status >= 400 &&
                                      row.status < 500 &&
                                      "text-warning",
                                    row.status < 300 && "text-success",
                                  )}
                                >
                                  {row.status}
                                </span>
                              )}
                            </Bone>
                          </ListCell>
                          <ListCell className="tabular text-right text-xs text-muted-foreground">
                            <Bone id="duration" width={48} lineHeight={16} align="end">
                              {row && formatDuration(row.duration_ms)}
                            </Bone>
                          </ListCell>
                          <ListCell hideBelow="lg">
                            <Bone id="client" width={110} lineHeight={16}>
                              {row && (
                                <span
                                  className="block truncate text-xs text-muted-foreground"
                                  title={row.user_agent ?? undefined}
                                >
                                  {row.user_agent ?? "-"}
                                </span>
                              )}
                            </Bone>
                          </ListCell>
                          <ListCell className="text-right text-xs whitespace-nowrap text-muted-foreground">
                            <Bone id="when" width={64} lineHeight={16} align="end">
                              {row && <Time iso={row.occurred_at} />}
                            </Bone>
                          </ListCell>
                        </tr>
                        {/*
                         * ⚠ THE DETAIL ROW HAS NO HEIGHT OF ITS OWN WHEN CLOSED
                         * (2026-10-13). The table gives every cell 52px and a rule, so
                         * a closed one was a blank band under each request; it is
                         * zero-height and borderless until it opens.
                         */}
                        <tr aria-hidden={!expanded}>
                          <td
                            colSpan={7}
                            className={cn(
                              "!h-0 !p-0",
                              expanded
                                ? "[--cell-fill:var(--surface-muted)]"
                                : "!border-b-0",
                            )}
                          >
                            <AnimatePresence initial={false}>
                              {row && expanded && (
                                <motion.div
                                  initial={{ height: 0, opacity: 0 }}
                                  animate={{
                                    height: "auto",
                                    opacity: 1,
                                    transition: {
                                      height: motionTokens.spring.smooth,
                                      opacity: {
                                        duration: motionTokens.duration.standard,
                                        delay: motionTokens.duration.instant,
                                      },
                                    },
                                  }}
                                  exit={{
                                    height: 0,
                                    opacity: 0,
                                    transition: {
                                      height: motionTokens.spring.smooth,
                                      opacity: {
                                        duration: motionTokens.duration.fast,
                                      },
                                    },
                                  }}
                                  className="overflow-hidden"
                                >
                                  <dl className="grid gap-x-6 gap-y-4 pt-1 pr-4 pb-5 pl-14 text-sm sm:grid-cols-2 lg:grid-cols-4">
                                    <Detail label="Request ID">
                                      <span className="flex items-center gap-1">
                                        <span className="truncate font-mono text-xs">
                                          {row.id}
                                        </span>
                                        <CopyButton
                                          value={row.id}
                                          label="Copy request ID"
                                          iconOnly
                                          variant="plain"
                                        />
                                      </span>
                                    </Detail>
                                    <Detail label="API key">
                                      {row.api_key_id
                                        ? (keyName(row.api_key_id) ?? (
                                            <span className="font-mono">
                                              {row.api_key_id}
                                            </span>
                                          ))
                                        : "None (refused before a key resolved)"}
                                    </Detail>
                                    <Detail label="Time">
                                      <span className="font-mono text-xs">
                                        <Time iso={row.occurred_at} mode="exact" />
                                      </span>
                                    </Detail>
                                    <Detail label="Answered in">
                                      {formatDuration(row.duration_ms)}
                                    </Detail>
                                    <div className="sm:col-span-2 lg:col-span-4">
                                      <Detail label="Client">
                                        <span className="font-mono text-xs break-all">
                                          {row.user_agent ?? "Not sent"}
                                        </span>
                                      </Detail>
                                    </div>
                                  </dl>
                                </motion.div>
                              )}
                            </AnimatePresence>
                          </td>
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
      {data && data.error === undefined && (
        <RememberShape
          def={logsShape}
          shape={shape}
          skip={filtered || Boolean(params.get("cursor"))}
        />
      )}
    </>
  )
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 min-h-5">{children}</dd>
    </div>
  )
}
