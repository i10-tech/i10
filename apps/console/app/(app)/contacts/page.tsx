import type { Metadata } from "next"
import { ContactsView } from "@/components/contacts-view"
import { tryApi } from "@/lib/api"
import { contactsShape, type ContactsData } from "@/lib/shapes/contacts"
import type { ContactRow, Page as ApiPage, SegmentRow } from "@/lib/types"

export const metadata: Metadata = { title: "Contacts" }

/**
 * Everyone this workspace can send marketing mail to.
 *
 * ⚠ A CONTACT IS GLOBAL TO THE WORKSPACE AND UNIQUE BY ADDRESS. The obvious
 * alternative - a contact row per list - makes unsubscribing a per-list act,
 * which means re-importing last quarter's CSV quietly resurrects somebody who
 * opted out. Segments are a grouping OF these contacts, not copies of them.
 */
export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{
    search?: string
    segment_id?: string
    status?: string
    cursor?: string
  }>
}) {
  const params = await searchParams

  const [contacts, segments] = await Promise.all([
    tryApi<ApiPage<ContactRow>>("/console/contacts", {
      query: {
        search: params.search,
        segment_id: params.segment_id,
        status: params.status,
        cursor: params.cursor,
        limit: 50,
      },
    }),
    tryApi<{ data: SegmentRow[] }>("/console/segments"),
  ])

  const data: ContactsData = {
    contacts: contacts.ok ? contacts.data.data : [],
    nextCursor: contacts.ok ? contacts.data.nextCursor : null,
    segments: segments.ok ? segments.data.data : [],
    ...(contacts.ok ? {} : { error: contacts.error.message }),
  }

  return <ContactsView shape={contactsShape.of(data)} data={data} />
}
