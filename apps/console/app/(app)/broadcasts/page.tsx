import type { Metadata } from "next"
import { Megaphone } from "lucide-react"
import {
  Page,
  PageActions,
  PageBody,
  PageDescription,
  PageHeader,
  PageHeaderRow,
  PageTitle,
} from "@repo/ui/components/page"
import { BroadcastsList } from "@/components/marketing-lists"
import { NewBroadcastButton } from "@/components/new-broadcast"
import { EmptyState } from "@/components/empty-state"
import { PanelError } from "@/components/panel-error"
import { tryApi } from "@/lib/api"
import type { BroadcastSummary } from "@/lib/types"

export const metadata: Metadata = { title: "Broadcasts" }

/**
 * Marketing sends.
 *
 * ⚠ A BROADCAST IS NOT A SECOND SENDING PATH. Sending one fans it out into
 * ordinary rows in `core.messages` on the bulk queue, each carrying the
 * broadcast's id - so metering, suppression, DKIM, the event ingest, webhooks
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
           * apart, reads as two different things - and the one in the header is
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
            icon={<Megaphone />}
            title="No broadcasts yet"
            description="Write one, point it at a segment, and send it. Drafts are safe to leave lying around."
            secondary={<NewBroadcastButton />}
          />
        ) : (
          <BroadcastsList broadcasts={result.data.data} />
        )}
      </PageBody>
    </Page>
  )
}
