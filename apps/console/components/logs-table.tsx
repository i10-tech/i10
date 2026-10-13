"use client"

import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import { ChevronRight, ScrollText, SearchX } from "lucide-react"
import { CopyButton } from "@repo/ui/components/copy-button/copy-button"
import { cn } from "cn"
import { EmptyState } from "@/components/empty-state"
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
  UrlRangeSelect,
  UrlSearchField,
} from "@/components/list/toolbar"
import { ListRegion, UrlList, useUrlList } from "@/components/list/url-state"
import { LoadMore } from "@/components/load-more"
import { StatusDot } from "@/components/status"
import { formatDuration } from "@/lib/format"
import type { RequestRow } from "@/lib/types"
import { Time } from "@/components/time"

const FILTERS = ["search", "days", "status", "method", "api_key_id"]

/**
 * The API request log.
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
export function LogsTable({
  rows,
  nextCursor,
  apiKeys,
}: {
  rows: RequestRow[]
  nextCursor: string | null
  apiKeys: { id: string; name: string }[]
}) {
  return (
    <UrlList className="space-y-4">
      <ListToolbar>
        <UrlSearchField
          placeholder="Search endpoints, e.g. /emails"
          label="Search requests"
        />
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
        {apiKeys.length > 0 && (
          <UrlFilterSelect
            param="api_key_id"
            label="API key"
            allLabel="All API keys"
            options={apiKeys.map((k) => ({ value: k.id, label: k.name }))}
          />
        )}
        <UrlClearFilters params={FILTERS} />
      </ListToolbar>

      <ListRegion>
        <Rows rows={rows} nextCursor={nextCursor} apiKeys={apiKeys} />
      </ListRegion>
    </UrlList>
  )
}

function Rows({
  rows,
  nextCursor,
  apiKeys,
}: {
  rows: RequestRow[]
  nextCursor: string | null
  apiKeys: { id: string; name: string }[]
}) {
  const { params, commit } = useUrlList()
  const [open, setOpen] = React.useState<string | null>(null)
  const filtered = FILTERS.some((f) => params.get(f))
  const keyName = (id: string | null) => apiKeys.find((k) => k.id === id)?.name ?? null

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={filtered ? <SearchX /> : <ScrollText />}
        title={filtered ? "Nothing matches those filters" : "No requests yet"}
        description={
          filtered
            ? "Try a wider date range, or clear the filters."
            : "Calls your servers make to the API appear here, with the status and timing we answered with."
        }
        secondary={
          filtered ? (
            <button
              type="button"
              onClick={() => commit((p) => FILTERS.forEach((f) => p.delete(f)))}
              className="h-8 cursor-pointer rounded-lg border px-3 text-sm transition-colors hover:bg-muted"
            >
              Clear filters
            </button>
          ) : undefined
        }
      />
    )
  }

  return (
    <div className="space-y-4">
      <ListTable fixed className="[&_table]:min-w-[640px]">
        <ListHeader>
          <ListHead className="w-10 pr-0" />
          <ListHead className="w-[6rem]">Method</ListHead>
          <ListHead>Endpoint</ListHead>
          <ListHead className="w-[6rem]">Status</ListHead>
          <ListHead className="w-[7rem] text-right">Duration</ListHead>
          <ListHead className="hidden w-[12rem] lg:table-cell">Client</ListHead>
          <ListHead className="w-[9rem] text-right">When</ListHead>
        </ListHeader>
        {/* No `divide-y`: the folded detail rows would each draw a second line. */}
        <tbody>
          {rows.map((row) => {
            const expanded = open === row.id
            return (
              <React.Fragment key={row.id}>
                <tr
                  className={cn(
                    rowClass,
                    "cursor-pointer animate-in fade-in-0 duration-300",
                    // Open, the row and its details read as one block: one
                    // fill, and no rule between them.
                    expanded &&
                      "[&>td]:border-b-0 [&>td]:[--cell-fill:var(--surface-muted)]",
                  )}
                  onClick={() => setOpen(expanded ? null : row.id)}
                  aria-expanded={expanded}
                >
                  <ListCell className="pr-0">
                    <motion.span
                      className="grid size-4 place-items-center"
                      initial={false}
                      animate={{ rotate: expanded ? 90 : 0 }}
                      transition={{ type: "spring", stiffness: 520, damping: 34 }}
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
                    <span className="font-mono text-2xs font-medium text-muted-foreground">
                      {row.method}
                    </span>
                  </ListCell>
                  <ListCell className="max-w-0">
                    <span className="block truncate font-mono text-xs">{row.path}</span>
                    {row.error_name && (
                      <span className="text-2xs text-danger">{row.error_name}</span>
                    )}
                  </ListCell>
                  <ListCell>
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
                  </ListCell>
                  <ListCell className="tabular text-right text-xs text-muted-foreground">
                    {formatDuration(row.duration_ms)}
                  </ListCell>
                  <ListCell className="hidden max-w-0 lg:table-cell">
                    <span
                      className="block truncate text-xs text-muted-foreground"
                      title={row.user_agent ?? undefined}
                    >
                      {row.user_agent ?? "-"}
                    </span>
                  </ListCell>
                  <ListCell className="text-right text-xs whitespace-nowrap text-muted-foreground">
                    <Time iso={row.occurred_at} />
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
                      expanded ? "[--cell-fill:var(--surface-muted)]" : "!border-b-0",
                    )}
                  >
                    <AnimatePresence initial={false}>
                      {expanded && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{
                            height: "auto",
                            opacity: 1,
                            transition: {
                              height: { type: "spring", stiffness: 420, damping: 40 },
                              opacity: { duration: 0.18, delay: 0.04 },
                            },
                          }}
                          exit={{
                            height: 0,
                            opacity: 0,
                            transition: {
                              height: { type: "spring", stiffness: 520, damping: 44 },
                              opacity: { duration: 0.1 },
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
                                    <span className="font-mono">{row.api_key_id}</span>
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
              </React.Fragment>
            )
          })}
        </tbody>
      </ListTable>

      <LoadMore cursor={nextCursor} />
    </div>
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
