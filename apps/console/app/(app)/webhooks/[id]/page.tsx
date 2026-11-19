import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { WebhookDetailView } from "@/components/webhook-detail-view"
import { tryApi } from "@/lib/api"
import { rangeStart } from "@/lib/range"
import { webhookDetailShape, type WebhookDetailData } from "@/lib/shapes/webhook-detail"
import type {
  DeliveryRow,
  Page as ApiPage,
  WebhookEndpoint,
  WebhookEndpointStats,
  WebhookEventType,
  WebhookHealthEvent,
  WebhookReplay,
} from "@/lib/types"
import { endpointName, windowFor, windowQuery } from "@/lib/webhooks"

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

  const data: WebhookDetailData = {
    endpoint,
    stats: stats.ok ? stats.data : null,
    dayStats: day && day.ok ? day.data : null,
    health: health.ok ? health.data.data : [],
    deliveries: deliveries.ok ? deliveries.data.data : [],
    nextCursor: deliveries.ok ? deliveries.data.nextCursor : null,
    replays: replays.ok ? replays.data.data : [],
    catalog: catalog.ok ? catalog.data.data : [],
    window: window.value,
    tab: query.tab,
    ...(stats.ok ? {} : { errorStats: stats.error.message }),
    ...(health.ok ? {} : { errorHealth: health.error.message }),
    ...(deliveries.ok ? {} : { errorDeliveries: deliveries.error.message }),
    ...(replays.ok ? {} : { errorReplays: replays.error.message }),
  }

  return <WebhookDetailView shape={webhookDetailShape.of(data)} data={data} />
}
