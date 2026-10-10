"use client"

import Link from "next/link"
import { ChevronRight, SearchX, Send } from "lucide-react"
import { Badge } from "@repo/ui/components/badge"
import { Button } from "@repo/ui/components/button"
import { Status, StatusDot } from "@/components/status"
import { cn } from "cn"
import { EmptyState } from "@/components/empty-state"
import { ListCell, ListHead, ListHeader, ListTable } from "@/components/list/table"
import { MotionBody, MotionRow } from "@/components/list/motion"
import {
  ListToolbar,
  UrlClearFilters,
  UrlFilterSelect,
} from "@/components/list/toolbar"
import { ListRegion, UrlList, useUrlList } from "@/components/list/url-state"
import { LoadMore } from "@/components/load-more"
import { shortName } from "@/lib/webhooks"
import type { DeliveryRow, WebhookEndpoint } from "@/lib/types"
import { Time } from "@/components/time"

/**
 * Every delivery we have made, or are still making, to a customer's endpoint.
 *
 * ⚠ `response_status` IS THE COLUMN PEOPLE COME FOR. "It is not working" almost
 * always resolves to a 401 from their own auth middleware, a 404 from a route
 * that moved, or a 500 from their handler - and each of those is a completely
 * different fix. Showing the status code turns a support conversation into a
 * glance.
 *
 * ⚠ AND A PENDING DELIVERY IS NOT A FAILED ONE. Retries run on a backoff for
 * hours; a row that says `retrying` with three attempts is working as designed,
 * and colouring it red would have somebody rewriting a handler that is about to
 * succeed.
 *
 * ⚠ EACH ROW OPENS THE DELIVERY'S OWN PAGE (#286): the payload, what was sent,
 * and every attempt with its request and response. The row used to unfold the
 * last error alone, which is the one thing that is never enough.
 */
export function DeliveriesTable({
  deliveries,
  nextCursor,
  endpoints,
  eventTypes,
  showEndpoint = true,
}: {
  deliveries: DeliveryRow[]
  nextCursor: string | null
  endpoints: WebhookEndpoint[]
  /** From the catalog; the event filter's choices. */
  eventTypes: string[]
  /** False on an endpoint's own page, where every row is that endpoint's. */
  showEndpoint?: boolean
}) {
  const filters = showEndpoint
    ? ["status", "event_type", "endpoint_id"]
    : ["status", "event_type"]
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
          options={eventTypes.map((type) => ({ value: type, label: type }))}
          className="w-56"
        />
        {showEndpoint && endpoints.length > 1 && (
          <UrlFilterSelect
            param="endpoint_id"
            label="Endpoint"
            allLabel="All endpoints"
            options={endpoints.map((e) => ({ value: e.id, label: shortName(e) }))}
            className="w-64"
          />
        )}
        <UrlClearFilters params={filters} />
      </ListToolbar>
      <ListRegion>
        <DeliveryRows
          deliveries={deliveries}
          nextCursor={nextCursor}
          filters={filters}
          showEndpoint={showEndpoint}
        />
      </ListRegion>
    </UrlList>
  )
}

function DeliveryRows({
  deliveries,
  nextCursor,
  filters,
  showEndpoint,
}: {
  deliveries: DeliveryRow[]
  nextCursor: string | null
  filters: string[]
  showEndpoint: boolean
}) {
  const { params, commit } = useUrlList()
  const filtered = filters.some((f) => params.get(f))

  if (deliveries.length === 0) {
    return (
      <EmptyState
        icon={filtered ? <SearchX /> : <Send />}
        title={filtered ? "No delivery matches" : "No deliveries yet"}
        description={
          filtered
            ? "Try another status or event, or clear the filters."
            : "Once mail starts moving, every event we send appears here with its response. Send a test event to see one now."
        }
        secondary={
          filtered ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => commit((p) => filters.forEach((f) => p.delete(f)))}
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
          <ListHead>Event</ListHead>
          <ListHead className="w-[8rem]">Status</ListHead>
          <ListHead className="w-[6rem]">Response</ListHead>
          {showEndpoint && (
            <ListHead className="hidden lg:table-cell">Endpoint</ListHead>
          )}
          <ListHead className="hidden w-[6rem] text-right sm:table-cell">
            Attempts
          </ListHead>
          <ListHead className="w-[9rem] text-right">When</ListHead>
          <ListHead className="w-8 pl-0" />
        </ListHeader>
        <MotionBody>
          {deliveries.map((delivery) => {
            const href = `/webhooks/deliveries/${delivery.id}`
            return (
              <MotionRow key={delivery.id} href={href}>
                <ListCell>
                  <Link href={href} className="outline-none focus-visible:underline">
                    <Badge variant="outline" className="font-mono text-2xs">
                      {delivery.event_type}
                    </Badge>
                  </Link>
                </ListCell>
                <ListCell>
                  <DeliveryStatus status={delivery.status} />
                </ListCell>
                <ListCell>
                  <ResponseCode status={delivery.response_status} />
                </ListCell>
                {showEndpoint && (
                  <ListCell className="hidden max-w-0 lg:table-cell">
                    <span className="block truncate font-mono text-xs text-muted-foreground">
                      {/*
                       * ⚠ NULL IS A POLLING ENDPOINT OR A DELETED ONE: the API
                       * left-joins so a removed endpoint's history stays, and
                       * the two cannot be told apart from this row.
                       */}
                      {delivery.endpoint_url ?? "No URL"}
                    </span>
                  </ListCell>
                )}
                <ListCell className="tabular hidden text-right text-xs text-muted-foreground sm:table-cell">
                  {delivery.attempts}
                </ListCell>
                <ListCell className="text-right text-xs whitespace-nowrap text-muted-foreground">
                  <Time iso={delivery.created_at} />
                </ListCell>
                <ListCell className="pl-0">
                  <ChevronRight className="size-3.5 text-muted-foreground" />
                </ListCell>
              </MotionRow>
            )
          })}
        </MotionBody>
      </ListTable>

      <LoadMore cursor={nextCursor} />
    </div>
  )
}

export function DeliveryStatus({ status }: { status: DeliveryRow["status"] }) {
  return (
    <Status
      status={status === "pending" ? "queued" : status}
      label={status === "pending" ? "Retrying" : undefined}
    />
  )
}

export function ResponseCode({ status }: { status: number | null }) {
  if (status === null) return <span className="text-xs text-muted-foreground">-</span>
  return (
    <span
      className={cn(
        "tabular font-mono text-xs",
        status >= 400 && "text-danger",
        status < 300 && "text-success",
      )}
    >
      {status}
    </span>
  )
}
