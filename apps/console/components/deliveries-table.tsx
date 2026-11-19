"use client"

import Link from "next/link"
import * as React from "react"
import { useRouter } from "next/navigation"
import { ChevronRight, Copy, RotateCw, SearchX, Send } from "lucide-react"
import { Badge } from "@repo/ui/components/badge/badge"
import { Bone, BoneRegion, BoneScope } from "@repo/ui/components/bone/bone"
import { Button } from "@repo/ui/components/button/button"
import { Status, StatusDot } from "@/components/status"
import { cn } from "cn"
import { EmptyState } from "@/components/empty-state"
import {
  ListBody,
  ListCell,
  ListHead,
  ListHeader,
  ListRow,
  ListTable,
  selectedRowClass,
} from "@/components/list/table"
import { BulkBar } from "@/components/list/bulk-bar"
import { forEachPicked, useListSelection } from "@/components/list/selection"
import { seedShape } from "@/components/list/remembered-shapes"
import { resendWebhookDelivery } from "@/lib/actions"
import { webhookDeliveryDetailShape } from "@/lib/shapes/webhook-delivery-detail"
import { toastDone, toastError } from "@/lib/toast"
import { MotionBody, MotionRow } from "@/components/list/motion"
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
  nextCursor = null,
  endpoints = [],
  eventTypes = [],
  showEndpoint = true,
  endpointCount = endpoints.length,
  count = 5,
  loading = false,
}: {
  deliveries?: DeliveryRow[]
  nextCursor?: string | null
  endpoints?: WebhookEndpoint[]
  /**
   * How many endpoints the workspace has, which decides whether the endpoint
   * filter shows. Loading, `endpoints` is empty and this is the shape's.
   */
  endpointCount?: number
  /** From the catalog; the event filter's choices. */
  eventTypes?: string[]
  /** False on an endpoint's own page, where every row is that endpoint's. */
  showEndpoint?: boolean
  count?: number
  loading?: boolean
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
        <UrlListSearch
          param="q"
          placeholder="Delivery or message id"
          label="Search deliveries by delivery or message id"
        />
        <UrlListResults params={filters} searchParam="q" />
        <ListToolbarEnd>
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
            triggerWidth={208}
            options={eventTypes.map((type) => ({ value: type, label: type }))}
            className={HALF}
          />
          {showEndpoint && endpointCount > 1 && (
            <UrlFilterSelect
              param="endpoint_id"
              label="Endpoint"
              allLabel="All endpoints"
              triggerWidth={176}
              options={endpoints.map((e) => ({ value: e.id, label: shortName(e) }))}
              className={HALF}
            />
          )}
        </ListToolbarEnd>
      </ListToolbar>
      <ListRegion>
        <DeliveryRows
          deliveries={deliveries}
          nextCursor={nextCursor}
          filters={filters}
          showEndpoint={showEndpoint}
          count={count}
          loading={loading}
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
  count = 5,
  loading = false,
}: {
  deliveries?: DeliveryRow[]
  nextCursor: string | null
  filters: string[]
  showEndpoint: boolean
  count?: number
  loading?: boolean
}) {
  const isLoaded = !loading && deliveries !== undefined
  const { params, commit } = useUrlList()
  const filtered = filters.some((f) => params.get(f))
  const router = useRouter()
  const selection = useListSelection(deliveries ?? [], (d) => d.id)
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

  const seedDelivery = React.useCallback((d: DeliveryRow) => {
    seedShape(webhookDeliveryDetailShape, d.id, {
      status: d.status,
      transformed: false,
      expunged: false,
      hasError:
        d.status === "failed" ||
        (d.response_status !== null && d.response_status >= 400),
      polling: d.endpoint_url === null,
    })
  }, [])

  React.useEffect(() => {
    for (const d of deliveries ?? []) {
      seedDelivery(d)
    }
  }, [deliveries, seedDelivery])

  if (isLoaded && deliveries.length === 0) {
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

  if (!isLoaded && count === 0) {
    return (
      <EmptyState
        icon={<Send />}
        title="No deliveries yet"
        description="Once mail starts moving, every event we send appears here with its response. Send a test event to see one now."
      />
    )
  }

  const rows: (DeliveryRow | undefined)[] = isLoaded
    ? deliveries
    : Array.from({ length: count }, () => undefined)
  const Body = isLoaded ? MotionBody : ListBody
  const RowEl = isLoaded ? MotionRow : ListRow

  return (
    <div className="space-y-4">
      <BoneRegion id="deliveries">
        {/*
         * F = 468 (tick 68, Status 128, Response 96, When 144, chevron 32), Event keeps 220:
         * min 688. Attempts 96 -> 784 -> md (832); Endpoint 224 -> 1008 -> xl (1056). The
         * tiers hide by priority, not position, so the columns keep their order.
         */}
        <ListTable className="[&_table]:min-w-[688px]">
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
                {isLoaded && selection.headerBox("Select all deliveries")}
              </Bone>
            </th>
            <ListHead className="pl-0">Event</ListHead>
            <ListHead className="w-[8rem]">Status</ListHead>
            <ListHead className="w-[6rem]">Response</ListHead>
            {showEndpoint && (
              <ListHead hideBelow="xl" className="w-[14rem]">
                Endpoint
              </ListHead>
            )}
            <ListHead hideBelow="md" className="w-[6rem] text-right">
              Attempts
            </ListHead>
            <ListHead className="w-[9rem] text-right">When</ListHead>
            <ListHead className="w-8 pl-0" />
          </ListHeader>
          <Body>
            {rows.map((delivery, i) => {
              const href = delivery ? `/webhooks/deliveries/${delivery.id}` : undefined
              const ticked = delivery !== undefined && selection.isTicked(delivery)
              return (
                <BoneScope key={delivery?.id ?? i} id={`delivery-row-${i}`} unit>
                  <RowEl
                    clickable
                    {...(href ? { href } : {})}
                    className={cn(ticked && selectedRowClass)}
                    onClick={() => {
                      if (delivery) seedDelivery(delivery)
                    }}
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
                        {delivery &&
                          selection.rowBox(
                            delivery,
                            `Select this ${delivery.event_type} delivery`,
                          )}
                      </Bone>
                    </td>
                    <ListCell className="pl-0">
                      <Bone
                        id="event"
                        shape="box"
                        width={80}
                        height={20}
                        radius={9999}
                        inline
                      >
                        {delivery && (
                          <Link
                            href={`/webhooks/deliveries/${delivery.id}`}
                            className="outline-none focus-visible:underline"
                            onPointerEnter={() => seedDelivery(delivery)}
                          >
                            <Badge size="sm" tone="neutral">
                              {delivery.event_type}
                            </Badge>
                          </Link>
                        )}
                      </Bone>
                    </ListCell>
                    <ListCell>
                      <Bone
                        id="status"
                        shape="box"
                        width={64}
                        height={20}
                        radius={9999}
                        inline
                      >
                        {delivery && <DeliveryStatus status={delivery.status} />}
                      </Bone>
                    </ListCell>
                    <ListCell>
                      <Bone id="response" width={32} lineHeight={16} inline>
                        {delivery && <ResponseCode status={delivery.response_status} />}
                      </Bone>
                    </ListCell>
                    {showEndpoint && (
                      <ListCell hideBelow="xl">
                        <Bone id="endpoint" width={110} lineHeight={16}>
                          {delivery && (
                            <span
                              className="block truncate font-mono text-xs text-muted-foreground"
                              title={delivery.endpoint_url ?? undefined}
                            >
                              {/*
                               * ⚠ NULL IS A POLLING ENDPOINT OR A DELETED ONE: the API
                               * left-joins so a removed endpoint's history stays, and
                               * the two cannot be told apart from this row.
                               */}
                              {delivery.endpoint_url ?? "No URL"}
                            </span>
                          )}
                        </Bone>
                      </ListCell>
                    )}
                    <ListCell
                      hideBelow="md"
                      className="tabular text-right text-xs text-muted-foreground"
                    >
                      <Bone id="attempts" width={24} lineHeight={16} align="end">
                        {delivery?.attempts}
                      </Bone>
                    </ListCell>
                    <ListCell className="text-right text-xs whitespace-nowrap text-muted-foreground">
                      <Bone id="when" width={60} lineHeight={16} align="end">
                        {delivery && <Time iso={delivery.created_at} />}
                      </Bone>
                    </ListCell>
                    <ListCell className="pl-0">
                      <ChevronRight className="size-3.5 text-muted-foreground" />
                    </ListCell>
                  </RowEl>
                </BoneScope>
              )
            })}
          </Body>
        </ListTable>
      </BoneRegion>

      {isLoaded && <LoadMore cursor={nextCursor} />}

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
