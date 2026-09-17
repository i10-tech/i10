import type { Metadata } from "next"
import {
  Page,
  PageActions,
  PageBody,
  PageDescription,
  PageHeader,
  PageHeaderRow,
  PageTitle,
} from "@repo/ui/components/page"
import { ContactsTable } from "@/components/contacts-table"
import { ImportContactsButton } from "@/components/import-contacts"
import { NewContactButton } from "@/components/new-contact"
import { PanelError } from "@/components/panel-error"
import { tryApi } from "@/lib/api"
import type { ContactRow, Page as ApiPage, SegmentRow } from "@/lib/types"

export const metadata: Metadata = { title: "Contacts" }

/**
 * Everyone this workspace can send marketing mail to.
 *
 * ⚠ A CONTACT IS GLOBAL TO THE WORKSPACE AND UNIQUE BY ADDRESS. The obvious
 * alternative — a contact row per list — makes unsubscribing a per-list act,
 * which means re-importing last quarter's CSV quietly resurrects somebody who
 * opted out. Segments are a grouping OF these contacts, not copies of them.
 */
export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string; segment_id?: string; cursor?: string }>
}) {
  const params = await searchParams

  const [contacts, segments] = await Promise.all([
    tryApi<ApiPage<ContactRow>>("/console/contacts", {
      query: {
        search: params.search,
        segment_id: params.segment_id,
        cursor: params.cursor,
        limit: 50,
      },
    }),
    tryApi<{ data: SegmentRow[] }>("/console/segments"),
  ])

  return (
    <Page>
      <PageHeader>
        <PageHeaderRow>
          <PageTitle>Contacts</PageTitle>
          <PageActions>
            <ImportContactsButton />
            <NewContactButton />
          </PageActions>
        </PageHeaderRow>
        <PageDescription>
          One row per person, however many segments they are in. Unsubscribing is
          recorded once and honoured everywhere.
        </PageDescription>
      </PageHeader>

      <PageBody width="full">
        {!contacts.ok ? (
          <PanelError
            title="Could not load contacts"
            message={contacts.error.message}
          />
        ) : (
          <ContactsTable
            contacts={contacts.data.data}
            nextCursor={contacts.data.nextCursor}
            segments={segments.ok ? segments.data.data : []}
          />
        )}
      </PageBody>
    </Page>
  )
}
