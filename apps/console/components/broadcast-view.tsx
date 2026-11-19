"use client"

import * as React from "react"
import { NONE } from "@/lib/react"
import { Megaphone } from "lucide-react"
import { Bone, BoneScope } from "@repo/ui/components/bone/bone"
import { ButtonLink } from "@repo/ui/components/i10/button-link"
import { Page, PageBody, PageHeader } from "@repo/ui/components/i10/page"
import { DetailHero } from "@/components/detail-hero"
import { Journey } from "@/components/journey"
import { Status } from "@/components/status"
import { BroadcastEditor } from "@/components/broadcast-editor"
import { KpiRow, MetricCard, share } from "@/components/kpi-row"
import { RememberShape } from "@/components/list/remembered-shapes"
import { broadcastJourney } from "@/lib/journey"
import { describeStatus } from "@/lib/status"
import {
  broadcastShape,
  type BroadcastData,
  type BroadcastShape,
} from "@/lib/shapes/broadcast"

/**
 * One broadcast, loaded and loading: ONE view so the skeleton matches the record.
 *
 * ⚠ STRUCTURE COMES FROM THE SHAPE ALONE (draft vs sent panels, delivery stats KPI row);
 * `data` fills the bones.
 */
export function BroadcastView({
  shape,
  data,
}: {
  shape: BroadcastShape
  data?: BroadcastData
}) {
  const loading = data === undefined
  const sent = shape.status !== "draft"

  const status = data ? data.broadcast.status : shape.status
  // The broadcast's state, in the delivery log's vocabulary of colours.
  const tone =
    status === "draft"
      ? "queued"
      : status === "sent"
        ? "delivered"
        : status === "canceled"
          ? "canceled"
          : status === "scheduled"
            ? "scheduled"
            : "sending"

  return (
    <BoneScope id="broadcast-detail" loading={loading}>
      <Page aria-busy={loading}>
        <PageHeader>
          <DetailHero
            crumbs={[{ label: "Broadcasts", href: "/broadcasts" }]}
            icon={<Megaphone />}
            tone={describeStatus(tone).tone}
            eyebrow="Broadcast"
            title={loading ? undefined : data?.broadcast.name}
            subtitle={shape.subject ? (data?.broadcast.subject ?? "") : undefined}
            actions={
              <Bone id="status" shape="box" width={76} height={20} radius={9999} inline>
                {data && (
                  <Status status={tone} label={data.broadcast.status} variant="pill" />
                )}
              </Bone>
            }
            loading={loading}
          />
        </PageHeader>

        <PageBody className="space-y-8">
          <Journey
            title="Broadcast events"
            steps={loading ? shape.steps : broadcastJourney(data!.broadcast)}
          />

          {sent && (
            <div className="grid gap-4">
              <KpiRow loading={loading}>
                <MetricCard
                  label="Recipients"
                  value={data?.broadcast.stats.total}
                  context="In the segment when it went out"
                  loading={loading}
                />
                <MetricCard
                  label="Delivered"
                  value={data?.broadcast.stats.delivered}
                  context={
                    data
                      ? `${share(data.broadcast.stats.delivered, data.broadcast.stats.total)}% of recipients`
                      : ""
                  }
                  derived
                  loading={loading}
                />
                <MetricCard
                  label="Bounced"
                  value={data?.broadcast.stats.bounced}
                  context={
                    data
                      ? `${share(data.broadcast.stats.bounced, data.broadcast.stats.total)}% of recipients`
                      : ""
                  }
                  derived
                  loading={loading}
                />
                <MetricCard
                  label="Complained"
                  value={data?.broadcast.stats.complained}
                  context={
                    data
                      ? `${share(data.broadcast.stats.complained, data.broadcast.stats.total)}% of recipients`
                      : ""
                  }
                  derived
                  loading={loading}
                />
                <MetricCard
                  label="Failed"
                  value={data?.broadcast.stats.failed}
                  context="Could not be sent"
                  loading={loading}
                />
              </KpiRow>
              {/* ⚠ THE SAME BUTTON WHILE LOADING, going nowhere yet: `inert` keeps it from being pressed. */}
              <ButtonLink
                href={data ? `/emails?broadcast_id=${data.broadcast.id}` : "/emails"}
                variant="secondary"
                size="sm"
                className="self-start"
                inert={loading || undefined}
              >
                View messages in the delivery log
              </ButtonLink>
            </div>
          )}

          <BroadcastEditor
            broadcast={data?.broadcast}
            segments={data?.segments ?? NONE}
            topics={data?.topics ?? NONE}
            domains={data?.domains ?? NONE}
            status={shape.status}
            loading={loading}
          />
        </PageBody>
        {data && <RememberShape def={broadcastShape} shape={shape} />}
      </Page>
    </BoneScope>
  )
}
