"use client"

import Link from "next/link"
import * as React from "react"
import { useRouter } from "next/navigation"
import { ChevronRight, Copy, RotateCw, SearchX, Send } from "lucide-react"
import { Badge } from "@repo/ui/components/badge/badge"
import { Button } from "@repo/ui/components/button/button"
import { Status, StatusDot } from "@/components/status"
import { cn } from "cn"
import { EmptyState } from "@/components/empty-state"
import {
  ListCell,
  ListHead,
  ListHeader,
  ListTable,
  selectedRowClass,
} from "@/components/list/table"
import { BulkBar } from "@/components/list/bulk-bar"
import { forEachPicked, useListSelection } from "@/components/list/selection"
import { resendWebhookDelivery } from "@/lib/actions"
import { toastDone, toastError } from "@/lib/toast"
import { MotionBody, MotionRow } from "@/components/list/motion"
import {
  ListToolbar,
  UrlClearFilters,
  UrlFilterSelect,
  UrlRangeSelect,
  UrlSearchField,
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
 *
 * ⚠ THE SEARCH IS AN ID PREFIX, NOT TEXT. Somebody arrives here holding an id -
 * the `webhook-id` their receiver logged, or the email they are asking about -
 * so the box matches the start of a delivery's id or of its message's, and the
 * response filter answers "which of these never got an answer at all".
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
  const filters = [
    "q",
    "days",
    "status",
    "http_class",
    "event_type",
    ...(showEndpoint ? ["endpoint_id"] : []),
  ]
  return (
    <UrlList className="space-y-4">
      <ListToolbar>
        <UrlSearchField
          param="q"
          placeholder="Delivery or message id"
          label="Search deliveries by delivery or message id"
          className="min-w-60"
        />
        <UrlRangeSelect className={HALF} />
        <UrlFilterSelect
          param="status"
          label="Delivery status"
          allLabel="All statuses"
          className={HALF}
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
          param="http_class"
          label="Response"
          allLabel="All responses"
          options={RESPONSE_CLASSES}
          className={HALF}
        />
        <UrlFilterSelect
          param="event_type"
          label="Event"
          allLabel="All events"
          options={eventTypes.map((type) => ({ value: type, label: type }))}
          className={cn("w-56", HALF)}
        />
        {showEndpoint && endpoints.length > 1 && (
          <UrlFilterSelect
            param="endpoint_id"
            label="Endpoint"
            allLabel="All endpoints"
            options={endpoints.map((e) => ({ value: e.id, label: shortName(e) }))}
            className={cn("w-64", HALF)}
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

/**
 * Two filters to a row on a phone, under the full-width search. Five selects
 * at their desktop widths stacked one per row, each a different length.
 */
const HALF = "max-sm:w-[calc(50%-0.25rem)]"

/** The bands of `response_status`, as the API's `http_class` takes them. */
// ⚠ THE CODE ALONE, beside the Response column it filters: "4xx Client error"
// did not fit the trigger at half a phone's width.
const RESPONSE_CLASSES = [
  { value: "2xx", label: "2xx", icon: <StatusDot tone="success" /> },
  { value: "4xx", label: "4xx", icon: <StatusDot tone="warning" /> },
  { value: "5xx", label: "5xx", icon: <StatusDot tone="danger" /> },
  // Attempted, undelivered and never answered: timeouts, refused connections,
  // failed handshakes or transformations. A polled delivery is not one.
  { value: "none", label: "No response", icon: <StatusDot tone="neutral" /> },
]

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
  const router = useRouter()
  const selection = useListSelection(deliveries, (d) => d.id)
  const { picked } = selection
  const [resending, setResending] = React.useState(false)

  /** Sends each ticked delivery again, as a new attempt, one at a time. */
  async function resend() {
    if (resending) return
    setResending(true)
    const { done, failed } = await forEachPicked(picked, (d) =>
      resendWebhookDelivery(d.id),
    )
    setResending(false)
    const noun = (n: number) => (n === 1 ? "delivery" : "deliveries")
    if (done === 0) toastError(`Could not resend the ${noun(failed)}`)
    else {
      toastDone(
        `Resent ${done} ${noun(done)}`,
        failed > 0 ? `${failed} could not be resent` : undefined,
      )
      selection.clear()
      router.refresh()
    }
  }

  if (deliveries.length === 0) {
    return (
      <EmptyState
        icon={filtered ? <SearchX /> : <Send />}
        title={filtered ? "No delivery matches" : "No deliveries yet"}
        description={
          filtered
            ? "Try another filter, or the start of a different id, or clear the filters."
            : "Once mail starts moving, every event we send appears here with its response. Send a test event to see one now."
        }
        secondary={
          filtered ? (
            <Button
              size="sm"
              variant="secondary"
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
          <th className="w-10 py-2.5 pl-4">
            {selection.headerBox("Select all deliveries")}
          </th>
          <ListHead className="pl-0">Event</ListHead>
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
              <MotionRow
                key={delivery.id}
                href={href}
                className={cn(selection.isTicked(delivery) && selectedRowClass)}
              >
                <td className="w-10 py-3 pl-4">
                  {selection.rowBox(
                    delivery,
                    `Select this ${delivery.event_type} delivery`,
                  )}
                </td>
                <ListCell className="pl-0">
                  <Link href={href} className="outline-none focus-visible:underline">
                    <Badge size="sm" tone="neutral">
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

      <BulkBar
        count={picked.length}
        onClear={selection.clear}
        label="Selected deliveries"
      >
        <Button
          variant="ghost"
          size="sm"
          loading={resending}
          onClick={() => void resend()}
        >
          <RotateCw />
          Resend
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            void navigator.clipboard.writeText(picked.map((d) => d.id).join("\n")).then(
              () =>
                toastDone(
                  picked.length === 1 ? "Delivery ID copied" : "Delivery IDs copied",
                ),
              () => toastError("Could not copy the IDs"),
            )
          }
        >
          <Copy />
          Copy IDs
        </Button>
      </BulkBar>
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
