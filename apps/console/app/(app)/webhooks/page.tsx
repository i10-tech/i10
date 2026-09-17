import type { Metadata } from "next"
import {
  Page,
  PageActions,
  PageBody,
  PageDescription,
  PageHeader,
  PageHeaderRow,
  PageTitle,
} from "@repo/ui/components/page"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@repo/ui/components/tabs"
import { CreateWebhookButton } from "@/components/create-webhook"
import { DeliveriesTable } from "@/components/deliveries-table"
import { WebhookList } from "@/components/webhook-list"
import { PanelError } from "@/components/panel-error"
import { tryApi } from "@/lib/api"
import type { DeliveryRow, Page as ApiPage, WebhookEndpoint } from "@/lib/types"

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
  searchParams: Promise<{ new?: string; tab?: string; cursor?: string }>
}) {
  const params = await searchParams

  const [endpoints, deliveries] = await Promise.all([
    tryApi<{ data: WebhookEndpoint[] }>("/console/webhook-endpoints"),
    tryApi<ApiPage<DeliveryRow>>("/console/webhook-deliveries", {
      query: { cursor: params.cursor, limit: 50 },
    }),
  ])

  return (
    <Page>
      <PageHeader>
        <PageHeaderRow>
          <PageTitle>Webhooks</PageTitle>
          <PageActions>
            <CreateWebhookButton autoOpen={params.new === "1"} />
          </PageActions>
        </PageHeaderRow>
        <PageDescription>
          We POST every delivery event to your endpoints, signed so you can verify
          it came from us. Failed deliveries are retried with backoff.
        </PageDescription>
      </PageHeader>

      <PageBody width="full">
        <Tabs defaultValue={params.tab === "deliveries" ? "deliveries" : "endpoints"}>
          <TabsList className="mb-4">
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
              <WebhookList endpoints={endpoints.data.data} />
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
              />
            )}
          </TabsContent>
        </Tabs>
      </PageBody>
    </Page>
  )
}
