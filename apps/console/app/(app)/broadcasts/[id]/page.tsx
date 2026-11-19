import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { BroadcastView } from "@/components/broadcast-view"
import { tryApi } from "@/lib/api"
import { broadcastShape, type BroadcastData } from "@/lib/shapes/broadcast"
import type { BroadcastDetail, DomainSummary, SegmentRow, TopicRow } from "@/lib/types"

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params
  const result = await tryApi<BroadcastDetail>(
    `/console/broadcasts/${encodeURIComponent(id)}`,
  )
  return { title: result.ok ? result.data.name : "Broadcast" }
}

/**
 * One broadcast: the draft, or what happened to it.
 *
 * ⚠ THE NUMBERS ARE AGGREGATES OVER THE MESSAGES THE FAN-OUT PRODUCED, COMPUTED
 * ON READ. There is no `delivered_count` column to drift: a bounce that arrives
 * six hours after the send moves the number on its own, and nothing ever has to
 * be recomputed to agree with reality.
 */
export default async function BroadcastPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  const [broadcast, segments, topics, domains] = await Promise.all([
    tryApi<BroadcastDetail>(`/console/broadcasts/${encodeURIComponent(id)}`),
    tryApi<{ data: SegmentRow[] }>("/console/segments"),
    tryApi<{ data: TopicRow[] }>("/console/topics"),
    tryApi<{ data: DomainSummary[] }>("/console/domains"),
  ])

  if (!broadcast.ok) {
    if (broadcast.error.statusCode === 404) notFound()
    throw new Error(broadcast.error.message)
  }

  const data: BroadcastData = {
    broadcast: broadcast.data,
    segments: segments.ok ? segments.data.data : [],
    topics: topics.ok ? topics.data.data : [],
    domains: domains.ok ? domains.data.data : [],
  }

  return <BroadcastView shape={broadcastShape.of(data)} data={data} />
}
