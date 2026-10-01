import type { Metadata } from "next"
import { Layers } from "lucide-react"
import {
  Page,
  PageActions,
  PageBody,
  PageDescription,
  PageHeader,
  PageHeaderRow,
  PageTitle,
} from "@repo/ui/components/page"
import { NewSegmentButton } from "@/components/new-segment"
import { SegmentsList } from "@/components/marketing-lists"
import { EmptyState } from "@/components/empty-state"
import { PanelError } from "@/components/panel-error"
import { tryApi } from "@/lib/api"
import type { SegmentRow } from "@/lib/types"

export const metadata: Metadata = { title: "Segments" }

/**
 * Internal groupings of contacts.
 *
 * ⚠ A SEGMENT IS INTERNAL AND A TOPIC IS PUBLIC, AND CONFLATING THEM WOULD BE A
 * COMPLIANCE BUG. "Customers who bought in Q3" is a segment: the recipient must
 * never see it and cannot opt out of it. "Product updates" is a topic: it
 * appears on their preference page and their choice about it is binding. One
 * table for both would either leak internal targeting to recipients or make
 * their preferences unenforceable.
 *
 * ⚠ MEMBERSHIP IS EXPLICIT, NOT A STORED QUERY. A rule-based segment has to be
 * evaluated at send time against the event log, which makes a broadcast's
 * recipient list unreproducible afterwards - somebody asks "why did she get
 * this" and the honest answer is "she matched at 09:04". Explicit membership is
 * auditable, and rules can be added later as something that WRITES membership.
 */
export default async function SegmentsPage() {
  const result = await tryApi<{ data: SegmentRow[] }>("/console/segments")
  const hasRows = result.ok && result.data.data.length > 0

  return (
    <Page>
      <PageHeader>
        <PageHeaderRow>
          <PageTitle>Segments</PageTitle>
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
              <NewSegmentButton />
            </PageActions>
          )}
        </PageHeaderRow>
        <PageDescription>
          Groups you target a broadcast at. Recipients never see them - that is what
          topics are for.
        </PageDescription>
      </PageHeader>

      <PageBody>
        {!result.ok ? (
          <PanelError title="Could not load segments" message={result.error.message} />
        ) : !hasRows ? (
          <EmptyState
            icon={<Layers />}
            title="No segments yet"
            description="Create one, add contacts to it, and point a broadcast at it."
            secondary={<NewSegmentButton />}
          />
        ) : (
          <SegmentsList segments={result.data.data} />
        )}
      </PageBody>
    </Page>
  )
}
