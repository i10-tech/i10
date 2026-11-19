import type { Metadata } from "next"
import { cookies } from "next/headers"
import { WebhooksView } from "@/components/webhooks-view"
import { viewCookie } from "@/lib/views"
import { tryApi } from "@/lib/api"
import { rangeStart } from "@/lib/range"
import { webhooksShape, type WebhooksData } from "@/lib/shapes/webhooks"
import type {
  DeliveryRow,
  Page as ApiPage,
  WebhookEndpoint,
  WebhookEventType,
  WebhookStats,
} from "@/lib/types"
import { windowQuery } from "@/lib/webhooks"

export const metadata: Metadata = { title: "Webhooks" }

/**
 * Where delivery events go.
 *
 * ⚠ ENDPOINTS AND DELIVERIES ARE TABS ON ONE PAGE RATHER THAN TWO PAGES,
 * BECAUSE THEY ARE ALWAYS LOOKED AT TOGETHER. The reason to open this screen is
 * "my handler is not firing", and answering that needs the endpoint's
 * configuration and its recent attempts side by side. Splitting them puts a
 * navigation between the question and the answer.
 *
 * ⚠ AND BOTH ARE FETCHED ON THE SERVER, IN PARALLEL, EVEN THOUGH ONE IS BEHIND
 * A TAB. The deliveries list is the reason people come here; loading it only
 * when the tab is clicked would put a spinner in front of the answer. It is one
 * indexed query.
 */
export default async function WebhooksPage({
  searchParams,
}: {
  searchParams: Promise<{
    new?: string
    tab?: string
    cursor?: string
    status?: string
    event_type?: string
    http_class?: string
    q?: string
    days?: string
    endpoint_id?: string
  }>
}) {
  const params = await searchParams
  const jar = await cookies()
  const rawView = jar.get(viewCookie("webhooks"))?.value
  const view: "grid" | "table" = rawView === "table" ? "table" : "grid"

  /*
   * ⚠ THE STATS AND THE CATALOG FAIL QUIETLY. Without stats the list shows a
   * dash for each error rate; without the catalog the create dialog has no
   * events to offer and says so. Neither is worth an error in place of the
   * endpoints themselves.
   */
  const [endpoints, deliveries, stats, catalog] = await Promise.all([
    tryApi<{ data: WebhookEndpoint[] }>("/console/webhook-endpoints"),
    tryApi<ApiPage<DeliveryRow>>("/console/webhook-deliveries", {
      query: {
        cursor: params.cursor,
        status: params.status,
        event_type: params.event_type,
        http_class: params.http_class,
        q: params.q,
        since: rangeStart(params.days),
        endpoint_id: params.endpoint_id,
        limit: 50,
      },
    }),
    tryApi<WebhookStats>("/console/webhook-stats", { query: windowQuery("24h") }),
    tryApi<{ data: WebhookEventType[] }>("/console/webhook-event-types"),
  ])

  const tab = params.tab === "deliveries" ? "deliveries" : "endpoints"
  const data: WebhooksData = {
    endpoints: endpoints.ok ? endpoints.data.data : [],
    deliveries: deliveries.ok ? deliveries.data.data : [],
    nextCursor: deliveries.ok ? deliveries.data.nextCursor : null,
    stats: stats.ok ? stats.data : null,
    catalog: catalog.ok ? catalog.data.data : [],
    tab,
    view,
    newWebhook: params.new === "1",
    ...(endpoints.ok ? {} : { errorEndpoints: endpoints.error.message }),
    ...(deliveries.ok ? {} : { errorDeliveries: deliveries.error.message }),
  }

  return <WebhooksView shape={webhooksShape.of(data)} data={data} />
}
