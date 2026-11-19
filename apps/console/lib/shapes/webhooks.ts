import { defineShape } from "@/lib/shapes"
import { MAX_SKELETON_ROWS } from "@/lib/list-counts"
import type {
  DeliveryRow,
  WebhookEndpoint,
  WebhookEventType,
  WebhookStats,
} from "@/lib/types"

export interface WebhooksData {
  endpoints: WebhookEndpoint[]
  deliveries: DeliveryRow[]
  nextCursor: string | null
  stats: WebhookStats | null
  catalog: WebhookEventType[]
  tab: "endpoints" | "deliveries"
  view: "grid" | "table"
  errorEndpoints?: string
  errorDeliveries?: string
  newWebhook?: boolean
}

export type WebhookBannerState = "none" | "disabled" | "failing" | "both"

export interface WebhooksShape {
  /** Rows to draw, capped; 0 is the empty state. */
  endpoints: number
  /** "grid" or "table" view. */
  view: "grid" | "table"
  /** Attention banner state above the list. */
  banner: WebhookBannerState
  /** Rows to draw in deliveries tab, capped; 0 is the empty state. */
  deliveries: number
  /** Tab read from the URL. */
  tab: "endpoints" | "deliveries"
}

const count = (v: unknown, max: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? Math.min(v, max) : null

export function bannerOf(endpoints: WebhookEndpoint[]): WebhookBannerState {
  const disabled = endpoints.some((e) => e.health === "disabled")
  const failing = endpoints.some((e) => e.health === "failing" && e.enabled)
  if (disabled && failing) return "both"
  if (disabled) return "disabled"
  if (failing) return "failing"
  return "none"
}

const webhooksShapeFallback: WebhooksShape = {
  endpoints: 3,
  view: "grid",
  banner: "none",
  deliveries: 5,
  tab: "endpoints",
}

export const webhooksShape = defineShape<WebhooksShape, WebhooksData>({
  page: "webhooks",
  fallback: webhooksShapeFallback,
  // A first visit's count (GET /console/shapes); what a count cannot know
  // keeps the default.
  // The banner comes from the two attention counts; one the API did not send
  // reads as none, so an old API draws no banner, as before.
  fromCounts: (counts) => {
    const n = counts.webhooks
    if (n === undefined) return null
    const disabled = (counts.webhooksDisabled ?? 0) > 0
    const failing = (counts.webhooksFailing ?? 0) > 0
    return {
      ...webhooksShapeFallback,
      endpoints: n,
      banner:
        disabled && failing
          ? "both"
          : disabled
            ? "disabled"
            : failing
              ? "failing"
              : "none",
    }
  },
  of: (data) => ({
    endpoints: Math.min(data.endpoints.length, MAX_SKELETON_ROWS),
    view: data.view,
    banner: bannerOf(data.endpoints),
    deliveries: Math.min(data.deliveries.length, MAX_SKELETON_ROWS),
    tab: data.tab,
  }),
  parse: (raw) => {
    if (typeof raw !== "object" || raw === null) return null
    const r = raw as Record<string, unknown>
    const endpoints = count(r.endpoints, MAX_SKELETON_ROWS)
    const deliveries = count(r.deliveries, MAX_SKELETON_ROWS)
    if (endpoints === null || deliveries === null) return null
    const view = r.view === "table" ? "table" : "grid"
    const banner =
      r.banner === "disabled" || r.banner === "failing" || r.banner === "both"
        ? r.banner
        : "none"
    const tab = r.tab === "deliveries" ? "deliveries" : "endpoints"
    return {
      endpoints,
      view,
      banner,
      deliveries,
      tab,
    }
  },
})
