import { defineShape } from "@/lib/shapes"
import type { WebhookDeliveryDetail, WebhookEndpoint } from "@/lib/types"

export interface WebhookDeliveryDetailData {
  delivery: WebhookDeliveryDetail
  endpoint: WebhookEndpoint | null
}

export interface WebhookDeliveryDetailShape {
  status: "delivered" | "pending" | "failed"
  transformed: boolean
  expunged: boolean
  hasError: boolean
  polling: boolean
}

export const webhookDeliveryDetailShape = defineShape<
  WebhookDeliveryDetailShape,
  WebhookDeliveryDetailData
>({
  page: "webhook-delivery-detail",
  fallback: {
    status: "delivered",
    transformed: false,
    expunged: false,
    hasError: false,
    polling: false,
  },
  of: ({ delivery, endpoint }) => ({
    status: delivery.status,
    transformed: delivery.transformed !== null,
    expunged: delivery.payload_expunged_at !== null,
    hasError: Boolean(delivery.last_error && delivery.status !== "delivered"),
    polling: endpoint?.kind === "polling",
  }),
  parse: (raw) => {
    if (typeof raw !== "object" || raw === null) return null
    const r = raw as Record<string, unknown>
    const status =
      r.status === "failed" || r.status === "pending" ? r.status : "delivered"
    return {
      status,
      transformed: r.transformed === true,
      expunged: r.expunged === true,
      hasError: r.hasError === true,
      polling: r.polling === true,
    }
  },
})
