import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { Megaphone } from "lucide-react"
import { Page, PageBody, PageHeader } from "@repo/ui/components/i10/page"
import { DetailHero } from "@/components/detail-hero"
import { Journey } from "@/components/journey"
import { Status } from "@/components/status"
import { BroadcastEditor } from "@/components/broadcast-editor"
import { KpiRow, MetricCard, share } from "@/components/kpi-row"
import { ButtonLink } from "@repo/ui/components/i10/button-link"
import { tryApi } from "@/lib/api"
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
          crumbs={[{ label: "Broadcasts", href: "/broadcasts" }]}
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
          <div className="grid gap-4">
            <KpiRow>
              <MetricCard
                label="Recipients"
                value={broadcast.data.stats.total}
                context="In the segment when it went out"
              />
              <MetricCard
                label="Delivered"
                value={broadcast.data.stats.delivered}
                context={`${share(broadcast.data.stats.delivered, broadcast.data.stats.total)}% of recipients`}
              />
              <MetricCard
                label="Bounced"
                value={broadcast.data.stats.bounced}
                context={`${share(broadcast.data.stats.bounced, broadcast.data.stats.total)}% of recipients`}
              />
              <MetricCard
                label="Complained"
                value={broadcast.data.stats.complained}
                context={`${share(broadcast.data.stats.complained, broadcast.data.stats.total)}% of recipients`}
              />
              <MetricCard
                label="Failed"
                value={broadcast.data.stats.failed}
                context="Could not be sent"
              />
            </KpiRow>
            <ButtonLink
              href={`/emails?broadcast_id=${broadcast.data.id}`}
              variant="secondary"
              size="sm"
              className="self-start"
            >
              View messages in the delivery log
            </ButtonLink>
          </div>
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
