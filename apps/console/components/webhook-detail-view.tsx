"use client"

import * as React from "react"
import { NONE } from "@/lib/react"
import { BoneScope } from "@repo/ui/components/bone/bone"
import { Page, PageBody, PageHeader } from "@repo/ui/components/i10/page"
import { TabsContent } from "@repo/ui/components/tabs/tabs"
import { DetailHero, MetaGrid } from "@/components/detail-hero"
import { DeliveriesTable } from "@/components/deliveries-table"
import { RememberShape, useRecordShape } from "@/components/list/remembered-shapes"
import { UrlTabs } from "@/components/list/url-tabs"
import { PanelError } from "@/components/panel-error"
import { Time } from "@/components/time"
import { EndpointStatus, KindIcon } from "@/components/webhook-list"
import { EndpointActions } from "@/components/webhooks/endpoint-actions"
import { EndpointNotice } from "@/components/webhooks/endpoint-notice"
import { EndpointSettings } from "@/components/webhooks/endpoint-settings"
import { HealthTimeline } from "@/components/webhooks/health-timeline"
import { ReplaysPanel } from "@/components/webhooks/replays-panel"
import { StatsPanel } from "@/components/webhooks/stats-panel"
import { TransformationPanel } from "@/components/webhooks/transformation-panel"
import {
  webhookDetailShape,
  type WebhookDetailData,
  type WebhookDetailShape,
} from "@/lib/shapes/webhook-detail"
import {
  KIND_LABEL,
  STATE_TONE,
  endpointName,
  errorRate,
  formatErrorRate,
  shortName,
} from "@/lib/webhooks"

/** What loading.tsx renders: the view with the seeded shape for this endpoint. */
export function WebhookDetailLoading() {
  return <WebhookDetailView shape={useRecordShape(webhookDetailShape)} />
}

/**
 * One endpoint: how it is doing, everything sent to it, and everything about
 * it that can be changed (#286).
 *
 * ⚠ STRUCTURE COMES FROM THE SHAPE ALONE (kind, tab, state, notice, deliveries,
 * replays, health). Data only fills the bones.
 *
 * ⚠ THE TRANSFORMATION TAB EXISTS ONLY FOR KIND HTTP.
 */
export function WebhookDetailView({
  shape,
  data,
}: {
  shape: WebhookDetailShape
  data?: WebhookDetailData
}) {
  const loading = data === undefined
  const last24 = data ? (data.dayStats ?? data.stats) : null
  const rate = last24 ? errorRate(last24.attempts, last24.failed_attempts) : null

  const tabs =
    shape.kind === "http"
      ? ["Overview", "Deliveries", "Replays", "Transformation", "Settings"]
      : ["Overview", "Deliveries", "Replays", "Settings"]

  const types = data?.catalog ?? NONE

  return (
    <BoneScope id="webhook-detail" loading={loading}>
      <Page aria-busy={loading}>
        <PageHeader>
          <DetailHero
            crumbs={[{ label: "Webhooks", href: "/webhooks" }]}
            icon={<KindIcon kind={shape.kind} />}
            tone={STATE_TONE[shape.state]}
            eyebrow={`${KIND_LABEL[shape.kind]} endpoint`}
            title={
              // ⚠ WITHOUT THE SCHEME: every endpoint is https, and on a phone those
              // eight characters are most of what fits.
              <span
                className="font-mono text-lg sm:text-2xl"
                title={data ? endpointName(data.endpoint) : undefined}
              >
                {data ? shortName(data.endpoint) : undefined}
              </span>
            }
            subtitle={shape.described ? (data?.endpoint.description ?? "") : undefined}
            actions={
              <EndpointActions
                endpoint={data?.endpoint}
                state={shape.state}
                catalog={types}
              />
            }
          />
        </PageHeader>

        <PageBody className="space-y-8">
          <EndpointNotice
            endpoint={data?.endpoint}
            failingSince={data?.stats?.failing_since ?? null}
            notice={shape.notice}
          />

          <MetaGrid
            items={[
              { label: "Status", value: <EndpointStatus state={shape.state} /> },
              {
                label: "Error rate, 24h",
                value: data ? (
                  <span className="tabular">
                    {formatErrorRate(rate)}
                    {last24 && last24.attempts > 0 && (
                      <span className="text-xs text-muted-foreground">
                        {" "}
                        of {last24.attempts} attempts
                      </span>
                    )}
                  </span>
                ) : undefined,
              },
              {
                label: "Last success",
                value: data ? (
                  last24 && last24.last_success_at ? (
                    <Time iso={last24.last_success_at} />
                  ) : (
                    <span className="text-muted-foreground">None in 24 hours</span>
                  )
                ) : undefined,
              },
              {
                label: "Created",
                value: data ? <Time iso={data.endpoint.created_at} /> : undefined,
              },
            ]}
          />

          <UrlTabs
            value={shape.tab}
            fallback="overview"
            tabs={tabs.map((t) => ({ value: t.toLowerCase(), label: t }))}
          >
            <TabsContent value="overview" className="m-0 space-y-10">
              {data?.errorStats ? (
                <PanelError
                  title="Could not load the stats"
                  message={data.errorStats}
                />
              ) : (
                <StatsPanel
                  stats={data?.stats}
                  window={data?.window ?? "24h"}
                  events={shape.events}
                  loading={loading}
                />
              )}
              {data?.errorHealth ? (
                <PanelError
                  title="Could not load the health history"
                  message={data.errorHealth}
                />
              ) : (
                <HealthTimeline
                  events={data?.health}
                  count={shape.health}
                  loading={loading}
                />
              )}
            </TabsContent>

            <TabsContent value="deliveries" className="m-0">
              {data?.errorDeliveries ? (
                <PanelError
                  title="Could not load deliveries"
                  message={data.errorDeliveries}
                />
              ) : (
                <DeliveriesTable
                  deliveries={data?.deliveries}
                  nextCursor={data?.nextCursor ?? null}
                  endpoints={data?.endpoint ? [data.endpoint] : []}
                  eventTypes={types.map((t) => t.type)}
                  showEndpoint={false}
                  count={shape.deliveries}
                  loading={loading}
                />
              )}
            </TabsContent>

            <TabsContent value="replays" className="m-0">
              {data?.errorReplays ? (
                <PanelError
                  title="Could not load replays"
                  message={data.errorReplays}
                />
              ) : (
                <ReplaysPanel
                  endpoint={data?.endpoint}
                  initial={data?.replays}
                  eventTypes={data?.endpoint?.events ?? NONE}
                  count={shape.replays}
                  loading={loading}
                />
              )}
            </TabsContent>

            {shape.kind === "http" && (
              <TabsContent value="transformation" className="m-0">
                <TransformationPanel endpoint={data?.endpoint} loading={loading} />
              </TabsContent>
            )}

            <TabsContent value="settings" className="m-0">
              <EndpointSettings
                endpoint={data?.endpoint}
                kind={shape.kind}
                catalog={types}
                loading={loading}
              />
            </TabsContent>
          </UrlTabs>
        </PageBody>

        {data && <RememberShape def={webhookDetailShape} shape={shape} />}
      </Page>
    </BoneScope>
  )
}
