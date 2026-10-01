import type { Metadata } from "next"
import { BackButton } from "@/components/back-button"
import { notFound } from "next/navigation"
import { Megaphone } from "lucide-react"
import { Page, PageBody, PageHeader } from "@repo/ui/components/page"
import { DetailHero } from "@/components/detail-hero"
import { Journey } from "@/components/journey"
import { Status } from "@/components/status"
import { BroadcastEditor } from "@/components/broadcast-editor"
import { Stat, StatRow } from "@/components/stat"
import { tryApi } from "@/lib/api"
import { formatRate } from "@/lib/format"
import { broadcastJourney } from "@/lib/journey"
import { describeStatus } from "@/lib/status"
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

  const sent = broadcast.data.status !== "draft"
  // The broadcast's state, in the delivery log's vocabulary of colours.
  const tone =
    broadcast.data.status === "draft"
      ? "queued"
      : broadcast.data.status === "sent"
        ? "delivered"
        : broadcast.data.status === "canceled"
          ? "canceled"
          : broadcast.data.status === "scheduled"
            ? "scheduled"
            : "sending"

  return (
    <Page>
      <PageHeader>
        <DetailHero
          back={<BackButton href="/broadcasts" label="Back to broadcasts" />}
          icon={<Megaphone />}
          tone={describeStatus(tone).tone}
          eyebrow="Broadcast"
          title={broadcast.data.name}
          subtitle={broadcast.data.subject || undefined}
          actions={
            <Status status={tone} label={broadcast.data.status} variant="pill" />
          }
        />
      </PageHeader>

      <PageBody className="space-y-8">
        <Journey title="Broadcast events" steps={broadcastJourney(broadcast.data)} />

        {sent && (
          <StatRow>
            <Stat label="Recipients" value={broadcast.data.stats.total} />
            <Stat
              label="Delivered"
              value={broadcast.data.stats.delivered}
              sub={formatRate(
                broadcast.data.stats.delivered,
                broadcast.data.stats.total,
              )}
            />
            <Stat
              label="Bounced"
              value={broadcast.data.stats.bounced}
              tone={broadcast.data.stats.bounced > 0 ? "warning" : undefined}
              sub={formatRate(broadcast.data.stats.bounced, broadcast.data.stats.total)}
            />
            <Stat
              label="Complained"
              value={broadcast.data.stats.complained}
              tone={broadcast.data.stats.complained > 0 ? "danger" : undefined}
              sub={formatRate(
                broadcast.data.stats.complained,
                broadcast.data.stats.total,
              )}
            />
            <Stat label="Failed" value={broadcast.data.stats.failed} />
            <Stat
              label="Messages"
              value="View"
              sub="in the delivery log"
              href={`/emails?broadcast_id=${broadcast.data.id}`}
            />
          </StatRow>
        )}

        <BroadcastEditor
          broadcast={broadcast.data}
          segments={segments.ok ? segments.data.data : []}
          topics={topics.ok ? topics.data.data : []}
          domains={domains.ok ? domains.data.data : []}
        />
      </PageBody>
    </Page>
  )
}
