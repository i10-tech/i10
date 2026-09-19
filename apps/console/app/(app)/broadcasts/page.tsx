import type { Metadata } from "next"
import Link from "next/link"
import {
  Page,
  PageActions,
  PageBody,
  PageDescription,
  PageHeader,
  PageHeaderRow,
  PageTitle,
} from "@repo/ui/components/page"
import { Status } from "@/components/status"
import { NewBroadcastButton } from "@/components/new-broadcast"
import { EmptyState } from "@/components/empty-state"
import { PanelError } from "@/components/panel-error"
import { tryApi } from "@/lib/api"
import { formatNumber, formatRelative } from "@/lib/format"
import type { BroadcastSummary } from "@/lib/types"

export const metadata: Metadata = { title: "Broadcasts" }

/**
 * Marketing sends.
 *
 * ⚠ A BROADCAST IS NOT A SECOND SENDING PATH. Sending one fans it out into
 * ordinary rows in `core.messages` on the bulk queue, each carrying the
 * broadcast's id — so metering, suppression, DKIM, the event ingest, webhooks
 * and the delivery log are the code that is already in production. A separate
 * marketing sender would be a second answer to "did this deliver", and the two
 * would disagree the first time an event arrived late.
 */
export default async function BroadcastsPage() {
  const result = await tryApi<{ data: BroadcastSummary[] }>("/console/broadcasts")
  const hasRows = result.ok && result.data.data.length > 0

  return (
    <Page>
      <PageHeader>
        <PageHeaderRow>
          <PageTitle>Broadcasts</PageTitle>
          {/*
           * ⚠ HIDDEN WHILE THE LIST IS EMPTY, BECAUSE THE EMPTY STATE ALREADY
           * CARRIES THIS ACTION. Two buttons for one action, eight inches
           * apart, reads as two different things — and the one in the header is
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
        <PageDescription>
          One email to a segment. Delivery, bounces and complaints are reported the same
          way as any other send.
        </PageDescription>
      </PageHeader>

      <PageBody>
        {!result.ok ? (
          <PanelError
            title="Could not load broadcasts"
            message={result.error.message}
          />
        ) : !hasRows ? (
          <EmptyState
            title="No broadcasts yet"
            description="Write one, point it at a segment, and send it. Drafts are safe to leave lying around."
          />
        ) : (
          <ul className="divide-y overflow-hidden rounded-lg border">
            {result.data.data.map((broadcast) => (
              <li key={broadcast.id}>
                <Link
                  href={`/broadcasts/${broadcast.id}`}
                  className="flex items-center gap-4 px-4 py-3 transition-colors duration-(--duration-instant) ease-(--ease-linear) hover:bg-muted/30"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{broadcast.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {broadcast.subject || <em>No subject yet</em>}
                      {broadcast.segment_name && ` · ${broadcast.segment_name}`}
                    </p>
                  </div>

                  {broadcast.recipient_count !== null && (
                    <span className="tabular hidden shrink-0 text-xs text-muted-foreground sm:block">
                      {formatNumber(broadcast.recipient_count)} recipients
                    </span>
                  )}

                  <Status
                    status={
                      broadcast.status === "draft"
                        ? "queued"
                        : broadcast.status === "canceled"
                          ? "canceled"
                          : broadcast.status === "sent"
                            ? "delivered"
                            : broadcast.status === "scheduled"
                              ? "scheduled"
                              : "sending"
                    }
                    label={broadcast.status}
                    className="shrink-0"
                  />

                  <span
                    className="shrink-0 text-xs whitespace-nowrap text-muted-foreground"
                    title={broadcast.created_at}
                  >
                    {formatRelative(broadcast.sent_at ?? broadcast.created_at)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </PageBody>
    </Page>
  )
}
