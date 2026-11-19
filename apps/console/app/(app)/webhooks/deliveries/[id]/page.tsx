import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { WebhookDeliveryDetailView } from "@/components/webhook-delivery-detail-view"
import { tryApi } from "@/lib/api"
import {
  webhookDeliveryDetailShape,
  type WebhookDeliveryDetailData,
} from "@/lib/shapes/webhook-delivery-detail"
import type { WebhookDeliveryDetail, WebhookEndpoint } from "@/lib/types"

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params
  const result = await tryApi<WebhookDeliveryDetail>(
    `/console/webhook-deliveries/${encodeURIComponent(id)}`,
  )
  return { title: result.ok ? result.data.event_type : "Delivery" }
}

/**
 * One delivery: what it carried, what was actually sent, and every attempt
 * with its request and response (#286).
 *
 * ⚠ THE PAYLOAD AND WHAT WAS SENT ARE TWO THINGS when the endpoint has a
 * transformation. The payload is the event; "Sent" is what the transformation
 * made of it, fixed at the first attempt so every retry sends the same bytes.
 * Showing only one of them hides either the bug in the event or the bug in
 * the function.
 */
export default async function DeliveryPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const result = await tryApi<WebhookDeliveryDetail>(
    `/console/webhook-deliveries/${encodeURIComponent(id)}`,
  )
  if (!result.ok) {
    if (result.error.statusCode === 404) notFound()
    throw new Error(result.error.message)
  }
  const delivery = result.data

  // ⚠ THE ENDPOINT MAY HAVE BEEN DELETED; its deliveries outlive it, and the
  // page still renders, with the way back going to the list instead.
  const endpoint = await tryApi<WebhookEndpoint>(
    `/console/webhook-endpoints/${encodeURIComponent(delivery.endpoint_id)}`,
  )

  const data: WebhookDeliveryDetailData = {
    delivery,
    endpoint: endpoint.ok ? endpoint.data : null,
  }

  return (
    <WebhookDeliveryDetailView
      shape={webhookDeliveryDetailShape.of(data)}
      data={data}
    />
  )
}
