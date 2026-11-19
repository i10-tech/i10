import type { Metadata } from "next"
import { cookies } from "next/headers"
import { BroadcastsView } from "@/components/broadcasts-view"
import { tryApi } from "@/lib/api"
import { broadcastsShape, type BroadcastsData } from "@/lib/shapes/broadcasts"
import type { BroadcastSummary } from "@/lib/types"
import { viewCookie, type View } from "@/lib/views"

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
  const [result, cookieStore] = await Promise.all([
    tryApi<{ data: BroadcastSummary[] }>("/console/broadcasts"),
    cookies(),
  ])
  const view = (cookieStore.get(viewCookie("broadcasts"))?.value as View) ?? "table"

  const data: BroadcastsData = {
    broadcasts: result.ok ? result.data.data : [],
    view,
    ...(result.ok ? {} : { error: result.error.message }),
  }
  return <BroadcastsView shape={broadcastsShape.of(data)} data={data} />
}
