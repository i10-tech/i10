import type { Metadata } from "next"
import { cookies } from "next/headers"
import { SegmentsView } from "@/components/segments-view"
import { tryApi } from "@/lib/api"
import { segmentsShape, type SegmentsData } from "@/lib/shapes/segments"
import type { SegmentRow } from "@/lib/types"
import { viewCookie, type View } from "@/lib/views"

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
  const [result, cookieStore] = await Promise.all([
    tryApi<{ data: SegmentRow[] }>("/console/segments"),
    cookies(),
  ])
  const view = (cookieStore.get(viewCookie("segments"))?.value as View) ?? "grid"

  const data: SegmentsData = {
    segments: result.ok ? result.data.data : [],
    view,
    ...(result.ok ? {} : { error: result.error.message }),
  }
  return <SegmentsView shape={segmentsShape.of(data)} data={data} />
}
