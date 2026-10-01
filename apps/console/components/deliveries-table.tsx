"use client"

import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import { ChevronRight, SearchX, Send } from "lucide-react"
import { Badge } from "@repo/ui/components/badge"
import { Button } from "@repo/ui/components/button"
import { Status, StatusDot } from "@/components/status"
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
} from "@/components/list/toolbar"
import { ListRegion, UrlList, useUrlList } from "@/components/list/url-state"
import { LoadMore } from "@/components/load-more"
import { WEBHOOK_EVENTS } from "@/components/webhook-events"
import type { DeliveryRow, WebhookEndpoint } from "@/lib/types"
import { Time } from "@/components/time"

const FILTERS = ["status", "event_type", "endpoint_id"]

/**
 * Every attempt we have made to call a customer's endpoint.
 *
 * ⚠ `response_status` IS THE COLUMN PEOPLE COME FOR. "It is not working" almost
 * always resolves to a 401 from their own auth middleware, a 404 from a route
 * that moved, or a 500 from their handler - and each of those is a completely
 * different fix. Showing the status code turns a support conversation into a
 * glance.
 *
 * ⚠ AND A PENDING DELIVERY IS NOT A FAILED ONE. Retries run on a backoff for
 * hours; a row that says `pending` with three attempts is working as designed,
 * and colouring it red would have somebody rewriting a handler that is about to
 * succeed.
 */
export function DeliveriesTable({
  deliveries,
  nextCursor,
  endpoints,
}: {
  deliveries: DeliveryRow[]
  nextCursor: string | null
  endpoints: WebhookEndpoint[]
}) {
  return (
    <UrlList className="space-y-4">
      <ListToolbar>
        <UrlFilterSelect
          param="status"
          label="Delivery status"
          allLabel="All statuses"
          options={[
            {
              value: "delivered",
              label: "Delivered",
              icon: <StatusDot tone="success" />,
            },
            { value: "pending", label: "Retrying", icon: <StatusDot tone="info" /> },
            { value: "failed", label: "Failed", icon: <StatusDot tone="danger" /> },
          ]}
        />
        <UrlFilterSelect
          param="event_type"
          label="Event"
          allLabel="All events"
          options={WEBHOOK_EVENTS.map((e) => ({ value: e.value, label: e.value }))}
          className="w-52"
        />
        {endpoints.length > 1 && (
          <UrlFilterSelect
            param="endpoint_id"
            label="Endpoint"
            allLabel="All endpoints"
            options={endpoints.map((e) => ({
              value: e.id,
              label: e.url.replace(/^https?:\/\//, ""),
            }))}
            className="w-64"
          />
        )}
        <UrlClearFilters params={FILTERS} />
      </ListToolbar>
      <ListRegion>
        <DeliveryRows deliveries={deliveries} nextCursor={nextCursor} />
      </ListRegion>
    </UrlList>
  )
}

function DeliveryRows({
  deliveries,
  nextCursor,
}: {
  deliveries: DeliveryRow[]
  nextCursor: string | null
}) {
  const { params, commit } = useUrlList()
  const filtered = FILTERS.some((f) => params.get(f))
  const [expanded, setExpanded] = React.useState<string | null>(null)

  if (deliveries.length === 0) {
    return (
      <EmptyState
        icon={filtered ? <SearchX /> : <Send />}
        title={filtered ? "No delivery matches" : "No deliveries yet"}
        description={
          filtered
            ? "Try another status or event, or clear the filters."
            : "Once an endpoint exists and mail starts moving, every attempt we make appears here with its response."
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
    )
  }

  return (
    <div className="space-y-4">
      <ListTable>
        <ListHeader>
          <ListHead className="w-8 pr-0" />
          <ListHead>Event</ListHead>
          <ListHead className="w-[8rem]">Status</ListHead>
          <ListHead className="w-[6rem]">Response</ListHead>
          <ListHead className="hidden lg:table-cell">Endpoint</ListHead>
          <ListHead className="w-[6rem] text-right">Attempts</ListHead>
          <ListHead className="w-[9rem] text-right">When</ListHead>
        </ListHeader>
        {/* No `divide-y`: the folded detail rows would each draw a second line. */}
        <tbody>
          {deliveries.map((delivery) => {
            const open = expanded === delivery.id
            const failing = delivery.last_error !== null

            return (
              <React.Fragment key={delivery.id}>
                <tr
                  className={cn(
                    rowClass,
                    "cursor-pointer border-t animate-in fade-in-0 duration-300 first:border-t-0",
                    open && "bg-muted/40",
                  )}
                  onClick={() => setExpanded(open ? null : delivery.id)}
                  aria-expanded={open}
                >
                  <ListCell className="pr-0">
                    <ChevronRight
                      className={cn(
                        "size-3.5 text-muted-foreground transition-transform duration-200",
                        open && "rotate-90",
                      )}
                    />
                  </ListCell>
                  <ListCell>
                    <Badge variant="outline" className="font-mono text-2xs">
                      {delivery.event_type}
                    </Badge>
                  </ListCell>
                  <ListCell>
                    <Status
                      status={
                        delivery.status === "delivered"
                          ? "delivered"
                          : delivery.status === "failed"
                            ? "failed"
                            : "queued"
                      }
                      label={
                        delivery.status === "pending" ? "retrying" : delivery.status
                      }
                    />
                  </ListCell>
                  <ListCell>
                    {delivery.response_status === null ? (
                      <span className="text-xs text-muted-foreground">-</span>
                    ) : (
                      <span
                        className={cn(
                          "tabular font-mono text-xs",
                          delivery.response_status >= 400 && "text-danger",
                          delivery.response_status < 300 && "text-success",
                        )}
                      >
                        {delivery.response_status}
                      </span>
                    )}
                  </ListCell>
                  <ListCell className="hidden max-w-0 lg:table-cell">
                    <span className="block truncate font-mono text-xs text-muted-foreground">
                      {/*
                       * ⚠ A DELETED ENDPOINT LEAVES ITS DELIVERIES BEHIND - the
                       * API left-joins for exactly this reason. "(deleted)" is
                       * more useful than an empty cell, because the history of
                       * a removed endpoint is usually what somebody is looking
                       * for right after removing it.
                       */}
                      {delivery.endpoint_url ?? "(deleted endpoint)"}
                    </span>
                  </ListCell>
                  <ListCell className="tabular text-right text-xs text-muted-foreground">
                    {delivery.attempts}
                  </ListCell>
                  <ListCell className="text-right text-xs whitespace-nowrap text-muted-foreground">
                    <Time iso={delivery.created_at} />
                  </ListCell>
                </tr>

                <tr>
                  <td colSpan={7} className="p-0">
                    <AnimatePresence initial={false}>
                      {open && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                          className="overflow-hidden bg-muted/20"
                        >
                          <dl className="grid gap-3 px-4 py-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
                            <div>
                              <dt className="text-muted-foreground">Event occurred</dt>
                              <dd className="mt-0.5 font-mono">
                                <Time iso={delivery.occurred_at} mode="exact" />
                              </dd>
                            </div>
                            <div>
                              <dt className="text-muted-foreground">Delivered</dt>
                              <dd className="mt-0.5 font-mono">
                                {delivery.delivered_at ? (
                                  <Time iso={delivery.delivered_at} mode="exact" />
                                ) : (
                                  "-"
                                )}
                              </dd>
                            </div>
                            <div className="sm:col-span-2">
                              <dt className="text-muted-foreground">Delivery ID</dt>
                              <dd className="mt-0.5 font-mono break-all">
                                {delivery.id}
                              </dd>
                            </div>
                            {failing && (
                              <div className="sm:col-span-2 lg:col-span-4">
                                <dt className="text-muted-foreground">Last error</dt>
                                <dd className="mt-1 overflow-x-auto rounded-md border border-danger/25 bg-danger/5 px-3 py-2 font-mono text-2xs whitespace-pre-wrap">
                                  {delivery.last_error}
                                </dd>
                              </div>
                            )}
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
