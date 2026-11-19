"use client"

import * as React from "react"
import { NONE } from "@/lib/react"
import { useRouteSearchParams } from "@/lib/target-route"
import { BoneScope } from "@repo/ui/components/bone/bone"
import {
  Page,
  PageActions,
  PageBody,
  PageDescription,
  PageHeader,
  PageHeaderRow,
  PageTitle,
  TITLE,
} from "@repo/ui/components/i10/page"
import { PlaceholderTitle } from "@repo/ui/components/i10/page-title"
import { TabsContent } from "@repo/ui/components/tabs/tabs"
import { CreateWebhookButton } from "@/components/create-webhook"
import { DeliveriesTable } from "@/components/deliveries-table"
import { ApiButton } from "@/components/list/api-button"
import { RememberShape, useRememberedShape } from "@/components/list/remembered-shapes"
import { UrlTabs, type UrlTabItem } from "@/components/list/url-tabs"
import { PanelError } from "@/components/panel-error"
import { WebhookList } from "@/components/webhook-list"
import { WebhookAttentionBanner } from "@/components/webhooks/attention-banner"
import { PAGE_COPY } from "@/lib/page-copy"
import {
  webhooksShape,
  type WebhooksData,
  type WebhooksShape,
} from "@/lib/shapes/webhooks"
import { SNIPPETS } from "@/lib/snippets"

/** What loading.tsx renders: the view with the shape this workspace last had. */
export function WebhooksLoading() {
  return <WebhooksView shape={useRememberedShape(webhooksShape)} />
}

/**
 * The webhooks page, loaded and loading: ONE view, so the skeleton cannot drift
 * from the page (docs/decisions/skeletons.md).
 *
 * ⚠ STRUCTURE COMES FROM THE SHAPE ALONE (endpoints count, view, banner,
 * deliveries count, tab); `data` only fills the bones.
 *
 * ⚠ ENDPOINTS AND DELIVERIES ARE TABS ON ONE PAGE RATHER THAN TWO PAGES,
 * BECAUSE THEY ARE ALWAYS LOOKED AT TOGETHER.
 */
export function WebhooksView({
  shape,
  data,
}: {
  shape: WebhooksShape
  data?: WebhooksData
}) {
  const loading = data === undefined
  const searchParams = useRouteSearchParams()

  const isFiltered = Boolean(
    searchParams.get("q") ||
    searchParams.get("status") ||
    searchParams.get("event_type") ||
    searchParams.get("http_class") ||
    searchParams.get("days") ||
    searchParams.get("endpoint_id") ||
    searchParams.get("cursor"),
  )

  const tabs: UrlTabItem[] = [
    {
      value: "endpoints",
      label: "Endpoints",
      badge:
        shape.endpoints > 0 ? (
          <span className="tabular ml-1.5 rounded-sm bg-secondary px-1 text-2xs">
            {data ? data.endpoints.length : shape.endpoints}
          </span>
        ) : undefined,
    },
    {
      value: "deliveries",
      label: "Deliveries",
    },
  ]

  const types = data?.catalog ?? NONE

  return (
    <BoneScope id="webhooks" loading={loading}>
      <Page aria-busy={loading}>
        <PageHeader>
          <PageHeaderRow>
            {loading ? (
              <PlaceholderTitle text={PAGE_COPY.webhooks.title} className={TITLE} />
            ) : (
              <PageTitle>{PAGE_COPY.webhooks.title}</PageTitle>
            )}
            <PageActions>
              <ApiButton snippet={SNIPPETS.webhooks} />
              <CreateWebhookButton autoOpen={data?.newWebhook} catalog={types} />
            </PageActions>
          </PageHeaderRow>
          <PageDescription>{PAGE_COPY.webhooks.description}</PageDescription>
        </PageHeader>

        <PageBody className="space-y-6">
          <WebhookAttentionBanner endpoints={data?.endpoints} banner={shape.banner} />
          <UrlTabs
            value={shape.tab === "deliveries" ? "deliveries" : undefined}
            fallback="endpoints"
            tabs={tabs}
          >
            <TabsContent value="endpoints" className="m-0">
              {data?.errorEndpoints ? (
                <PanelError
                  title="Could not load your endpoints"
                  message={data.errorEndpoints}
                />
              ) : (
                <WebhookList
                  endpoints={data?.endpoints}
                  stats={data?.stats ?? null}
                  count={shape.endpoints}
                  shapeView={shape.view}
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
                  endpoints={data?.endpoints ?? NONE}
                  endpointCount={shape.endpoints}
                  eventTypes={types.map((t) => t.type)}
                  count={shape.deliveries}
                  loading={loading}
                />
              )}
            </TabsContent>
          </UrlTabs>
        </PageBody>

        {data && !data.errorEndpoints && !data.errorDeliveries && (
          <RememberShape def={webhooksShape} shape={shape} skip={isFiltered} />
        )}
      </Page>
    </BoneScope>
  )
}
