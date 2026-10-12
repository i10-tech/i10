import type { Metadata } from "next"
import {
  Page,
  PageActions,
  PageBody,
  PageDescription,
  PageHeader,
  PageHeaderRow,
  PageTitle,
} from "@repo/ui/components/i10/page"
import { TabsContent, TabsList, TabsTrigger } from "@repo/ui/components/tabs/tabs"
import { CreateWebhookButton } from "@/components/create-webhook"
import { DeliveriesTable } from "@/components/deliveries-table"
import { ApiButton } from "@/components/list/api-button"
import { UrlTabs } from "@/components/list/url-tabs"
import { WebhookList } from "@/components/webhook-list"
import { PanelError } from "@/components/panel-error"
import { tryApi } from "@/lib/api"
import { rangeStart } from "@/lib/range"
import { SNIPPETS } from "@/lib/snippets"
import { WebhookAttentionBanner } from "@/components/webhooks/attention-banner"
import type {
  DeliveryRow,
  Page as ApiPage,
  WebhookEndpoint,
  WebhookEventType,
  WebhookStats,
} from "@/lib/types"
import { windowQuery } from "@/lib/webhooks"
import { PAGE_COPY } from "@/lib/page-copy"

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
  const types = catalog.ok ? catalog.data.data : []

  return (
    <Page>
      <PageHeader>
        <PageHeaderRow>
          <PageTitle>{PAGE_COPY.webhooks.title}</PageTitle>
          <PageActions>
            <ApiButton snippet={SNIPPETS.webhooks} />
            <CreateWebhookButton autoOpen={params.new === "1"} catalog={types} />
          </PageActions>
        </PageHeaderRow>
        <PageDescription>{PAGE_COPY.webhooks.description}</PageDescription>
      </PageHeader>

      <PageBody className="space-y-6">
        {endpoints.ok && <WebhookAttentionBanner endpoints={endpoints.data.data} />}
        <UrlTabs
          value={params.tab === "deliveries" ? "deliveries" : undefined}
          fallback="endpoints"
        >
          <TabsList>
            <TabsTrigger value="endpoints">
              Endpoints
              {endpoints.ok && endpoints.data.data.length > 0 && (
                <span className="tabular ml-1.5 rounded-sm bg-secondary px-1 text-2xs">
                  {endpoints.data.data.length}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="deliveries">Deliveries</TabsTrigger>
          </TabsList>

          <TabsContent value="endpoints" className="m-0">
            {!endpoints.ok ? (
              <PanelError
                title="Could not load your endpoints"
                message={endpoints.error.message}
              />
            ) : (
              <WebhookList
                endpoints={endpoints.data.data}
                stats={stats.ok ? stats.data : null}
              />
            )}
          </TabsContent>

          <TabsContent value="deliveries" className="m-0">
            {!deliveries.ok ? (
              <PanelError
                title="Could not load deliveries"
                message={deliveries.error.message}
              />
            ) : (
              <DeliveriesTable
                deliveries={deliveries.data.data}
                nextCursor={deliveries.data.nextCursor}
                endpoints={endpoints.ok ? endpoints.data.data : []}
                eventTypes={types.map((t) => t.type)}
              />
            )}
          </TabsContent>
        </UrlTabs>
      </PageBody>
    </Page>
  )
}
