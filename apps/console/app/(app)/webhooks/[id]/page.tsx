import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { Page, PageBody, PageHeader } from "@repo/ui/components/page"
import { TabsContent, TabsList, TabsTrigger } from "@repo/ui/components/tabs"
import { BackButton } from "@/components/back-button"
import { DetailHero, MetaGrid } from "@/components/detail-hero"
import { DeliveriesTable } from "@/components/deliveries-table"
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
import { tryApi } from "@/lib/api"
import { rangeStart } from "@/lib/range"
import type {
  DeliveryRow,
  Page as ApiPage,
  WebhookEndpoint,
  WebhookEndpointStats,
  WebhookEventType,
  WebhookHealthEvent,
  WebhookReplay,
} from "@/lib/types"
import {
  KIND_LABEL,
  STATE_TONE,
  endpointName,
  endpointState,
  shortName,
  errorRate,
  formatErrorRate,
  windowFor,
  windowQuery,
} from "@/lib/webhooks"

const TABS = [
  "overview",
  "deliveries",
  "replays",
  "transformation",
  "settings",
] as const

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params
  const result = await tryApi<WebhookEndpoint>(
    `/console/webhook-endpoints/${encodeURIComponent(id)}`,
  )
  return { title: result.ok ? endpointName(result.data) : "Webhook endpoint" }
}

/**
 * One endpoint: how it is doing, everything sent to it, and everything about
 * it that can be changed (#286).
 *
 * ⚠ OVERVIEW FIRST, BECAUSE THE QUESTION THAT OPENS THIS PAGE IS "IS IT
 * WORKING". The error rate and the health timeline answer it before anything
 * is clicked; the deliveries are one tab away for the "why not".
 *
 * ⚠ THE TAB IS IN THE URL (`?tab=`), unlike the domain page, because the
 * deliveries tab filters through the URL too. A filter is a navigation, and
 * without the tab in the URL every filter change would land back on Overview.
 *
 * ⚠ EVERYTHING IS READ ON THE SERVER, IN PARALLEL. Each read fails on its own:
 * a stats outage empties the chart, not the page.
 */
export default async function WebhookEndpointPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{
    tab?: string
    window?: string
    status?: string
    event_type?: string
    http_class?: string
    q?: string
    days?: string
    cursor?: string
  }>
}) {
  const { id } = await params
  const query = await searchParams
  const path = `/console/webhook-endpoints/${encodeURIComponent(id)}`

  const result = await tryApi<WebhookEndpoint>(path)
  if (!result.ok) {
    if (result.error.statusCode === 404) notFound()
    throw new Error(result.error.message)
  }
  const endpoint = result.data
  const window = windowFor(query.window)

  const [stats, day, health, deliveries, replays, catalog] = await Promise.all([
    tryApi<WebhookEndpointStats>(`${path}/stats`, { query: windowQuery(window.value) }),
    // ⚠ THE HEADER'S ERROR RATE IS ALWAYS THE LAST 24 HOURS, whatever window
    // the chart below is showing, so the number at the top never changes
    // meaning under someone's feet.
    window.value === "24h"
      ? null
      : tryApi<WebhookEndpointStats>(`${path}/stats`, { query: windowQuery("24h") }),
    tryApi<{ data: WebhookHealthEvent[]; next_cursor: string | null }>(
      "/console/webhook-health-events",
      { query: { endpoint_id: endpoint.id, limit: 20 } },
    ),
    tryApi<ApiPage<DeliveryRow>>("/console/webhook-deliveries", {
      query: {
        endpoint_id: endpoint.id,
        status: query.status,
        event_type: query.event_type,
        http_class: query.http_class,
        q: query.q,
        since: rangeStart(query.days),
        cursor: query.cursor,
        limit: 50,
      },
    }),
    tryApi<{ data: WebhookReplay[] }>(`${path}/replays`),
    tryApi<{ data: WebhookEventType[] }>("/console/webhook-event-types"),
  ])

  const types = catalog.ok ? catalog.data.data : []
  const last24 = day ?? stats
  const rate = last24.ok
    ? errorRate(last24.data.attempts, last24.data.failed_attempts)
    : null
  const state = endpointState(endpoint)
  const tab = TABS.find((t) => t === query.tab)

  return (
    <Page>
      <PageHeader>
        <DetailHero
          back={<BackButton href="/webhooks" label="Back to webhooks" />}
          icon={<KindIcon kind={endpoint.kind} />}
          tone={STATE_TONE[state]}
          eyebrow={`${KIND_LABEL[endpoint.kind]} endpoint`}
          title={
            // ⚠ WITHOUT THE SCHEME: every endpoint is https, and on a phone those
            // eight characters are most of what fits.
            <span
              className="font-mono text-lg sm:text-2xl"
              title={endpointName(endpoint)}
            >
              {shortName(endpoint)}
            </span>
          }
          subtitle={endpoint.description ?? undefined}
          actions={<EndpointActions endpoint={endpoint} catalog={types} />}
        />
      </PageHeader>

      <PageBody className="space-y-8">
        <EndpointNotice
          endpoint={endpoint}
          failingSince={stats.ok ? stats.data.failing_since : null}
        />

        <MetaGrid
          items={[
            { label: "Status", value: <EndpointStatus state={state} /> },
            {
              label: "Error rate, 24h",
              value: (
                <span className="tabular">
                  {formatErrorRate(rate)}
                  {last24.ok && last24.data.attempts > 0 && (
                    <span className="text-xs text-muted-foreground">
                      {" "}
                      of {last24.data.attempts} attempts
                    </span>
                  )}
                </span>
              ),
            },
            {
              label: "Last success",
              value:
                last24.ok && last24.data.last_success_at ? (
                  <Time iso={last24.data.last_success_at} />
                ) : (
                  <span className="text-muted-foreground">None in 24 hours</span>
                ),
            },
            { label: "Created", value: <Time iso={endpoint.created_at} /> },
          ]}
        />

        <UrlTabs value={tab} fallback="overview">
          <div className="-mx-4 mb-6 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0">
            <TabsList variant="pill">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="deliveries">Deliveries</TabsTrigger>
              <TabsTrigger value="replays">Replays</TabsTrigger>
              {endpoint.kind === "http" && (
                <TabsTrigger value="transformation">Transformation</TabsTrigger>
              )}
              <TabsTrigger value="settings">Settings</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="overview" className="m-0 space-y-10">
            {stats.ok ? (
              <StatsPanel stats={stats.data} window={window.value} />
            ) : (
              <PanelError
                title="Could not load the stats"
                message={stats.error.message}
              />
            )}
            {health.ok ? (
              <HealthTimeline events={health.data.data} />
            ) : (
              <PanelError
                title="Could not load the health history"
                message={health.error.message}
              />
            )}
          </TabsContent>

          <TabsContent value="deliveries" className="m-0">
            {deliveries.ok ? (
              <DeliveriesTable
                deliveries={deliveries.data.data}
                nextCursor={deliveries.data.nextCursor}
                endpoints={[endpoint]}
                eventTypes={types.map((t) => t.type)}
                showEndpoint={false}
              />
            ) : (
              <PanelError
                title="Could not load deliveries"
                message={deliveries.error.message}
              />
            )}
          </TabsContent>

          <TabsContent value="replays" className="m-0">
            {replays.ok ? (
              <ReplaysPanel
                endpoint={endpoint}
                initial={replays.data.data}
                eventTypes={endpoint.events}
              />
            ) : (
              <PanelError
                title="Could not load replays"
                message={replays.error.message}
              />
            )}
          </TabsContent>

          {endpoint.kind === "http" && (
            <TabsContent value="transformation" className="m-0">
              <TransformationPanel endpoint={endpoint} />
            </TabsContent>
          )}

          <TabsContent value="settings" className="m-0">
            <EndpointSettings endpoint={endpoint} catalog={types} />
          </TabsContent>
        </UrlTabs>
      </PageBody>
    </Page>
  )
}
