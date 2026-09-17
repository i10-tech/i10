"use client"

import * as React from "react"
import { ChevronRight } from "lucide-react"
import { Badge } from "@repo/ui/components/badge"
import { Status } from "@/components/status"
import { cn } from "cn"
import { EmptyState } from "@/components/empty-state"
import { LoadMore } from "@/components/load-more"
import type { DeliveryRow } from "@/lib/types"
import { Time } from "@/components/time"

/**
 * Every attempt we have made to call a customer's endpoint.
 *
 * ⚠ `response_status` IS THE COLUMN PEOPLE COME FOR. "It is not working" almost
 * always resolves to a 401 from their own auth middleware, a 404 from a route
 * that moved, or a 500 from their handler — and each of those is a completely
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
}: {
  deliveries: DeliveryRow[]
  nextCursor: string | null
}) {
  const [expanded, setExpanded] = React.useState<string | null>(null)

  if (deliveries.length === 0) {
    return (
      <EmptyState
        title="No deliveries yet"
        description="Once an endpoint exists and mail starts moving, every attempt we make appears here with its response."
      />
    )
  }

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-lg border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/30 text-left">
              <th className="w-8" />
              <th className="px-3 py-2 text-xs font-medium text-muted-foreground">
                Event
              </th>
              <th className="w-[8rem] px-3 py-2 text-xs font-medium text-muted-foreground">
                Status
              </th>
              <th className="w-[6rem] px-3 py-2 text-xs font-medium text-muted-foreground">
                Response
              </th>
              <th className="hidden px-3 py-2 text-xs font-medium text-muted-foreground lg:table-cell">
                Endpoint
              </th>
              <th className="w-[6rem] px-3 py-2 text-right text-xs font-medium text-muted-foreground">
                Attempts
              </th>
              <th className="w-[9rem] px-3 py-2 text-right text-xs font-medium text-muted-foreground">
                When
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {deliveries.map((delivery) => {
              const open = expanded === delivery.id
              const failing = delivery.last_error !== null

              return (
                <React.Fragment key={delivery.id}>
                  <tr
                    className={cn(
                      "cursor-pointer hover:bg-muted/30",
                      open && "bg-muted/30",
                    )}
                    onClick={() => setExpanded(open ? null : delivery.id)}
                  >
                    <td className="pl-3">
                      <ChevronRight
                        className={cn(
                          "size-3.5 text-muted-foreground transition-transform",
                          "duration-(--duration-instant) ease-(--ease-linear)",
                          open && "rotate-90",
                        )}
                      />
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge variant="outline" className="font-mono text-2xs">
                        {delivery.event_type}
                      </Badge>
                    </td>
                    <td className="px-3 py-2.5">
                      <Status
                        status={
                          delivery.status === "delivered"
                            ? "delivered"
                            : delivery.status === "failed"
                              ? "failed"
                              : "queued"
                        }
                        label={delivery.status}
                      />
                    </td>
                    <td className="px-3 py-2.5">
                      {delivery.response_status === null ? (
                        <span className="text-xs text-muted-foreground">—</span>
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
                    </td>
                    <td className="hidden max-w-0 px-3 py-2.5 lg:table-cell">
                      <span className="block truncate font-mono text-xs text-muted-foreground">
                        {/*
                         * ⚠ A DELETED ENDPOINT LEAVES ITS DELIVERIES BEHIND —
                         * the API left-joins for exactly this reason. Showing
                         * "(deleted)" is more useful than an empty cell,
                         * because the history of a removed endpoint is usually
                         * what somebody is looking for right after removing it.
                         */}
                        {delivery.endpoint_url ?? "(deleted endpoint)"}
                      </span>
                    </td>
                    <td className="tabular px-3 py-2.5 text-right text-xs text-muted-foreground">
                      {delivery.attempts}
                    </td>
                    <td className="px-3 py-2.5 text-right text-xs whitespace-nowrap text-muted-foreground">
                      <Time iso={delivery.created_at} />
                    </td>
                  </tr>

                  {open && (
                    <tr className="bg-muted/20">
                      <td colSpan={7} className="px-3 py-3">
                        <dl className="grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
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
                                "—"
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
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              )
            })}
          </tbody>
        </table>
      </div>

      <LoadMore cursor={nextCursor} />
    </div>
  )
}
