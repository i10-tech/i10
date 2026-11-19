import { defineShape } from "@/lib/shapes"
import { MAX_SKELETON_ROWS } from "@/lib/list-counts"
import type {
  DeliveryRow,
  WebhookEndpoint,
  WebhookEndpointStats,
  WebhookEventType,
  WebhookHealthEvent,
  WebhookReplay,
} from "@/lib/types"
import { endpointState, type EndpointState, type WindowValue } from "@/lib/webhooks"

export type WebhookNoticeState = "none" | "disabled" | "paused" | "failing"

export type WebhookDetailTab =
  "overview" | "deliveries" | "replays" | "transformation" | "settings"

export interface WebhookDetailData {
  endpoint: WebhookEndpoint
  stats: WebhookEndpointStats | null
  dayStats: WebhookEndpointStats | null
  health: WebhookHealthEvent[]
  deliveries: DeliveryRow[]
  nextCursor: string | null
  replays: WebhookReplay[]
  catalog: WebhookEventType[]
  window: WindowValue
  tab?: string
  errorStats?: string
  errorHealth?: string
  errorDeliveries?: string
  errorReplays?: string
}

export interface WebhookDetailShape {
  kind: "http" | "sqs" | "polling"
  tab: WebhookDetailTab
  state: EndpointState
  notice: WebhookNoticeState
  deliveries: number
  replays: number
  health: number
  /** Whether the endpoint has a description, which the hero shows under its address. */
  described: boolean
  /** Event types in the stats table, capped; 0 draws no table. */
  events: number
}

const count = (v: unknown, max: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? Math.min(v, max) : null

export function noticeOf(endpoint: WebhookEndpoint): WebhookNoticeState {
  if (endpoint.health === "disabled") return "disabled"
  if (!endpoint.enabled) return "paused"
  if (endpoint.health === "failing") return "failing"
  return "none"
}

export const webhookDetailShape = defineShape<WebhookDetailShape, WebhookDetailData>({
  page: "webhook-detail",
  fallback: {
    kind: "http",
    tab: "overview",
    state: "healthy",
    notice: "none",
    deliveries: 5,
    replays: 0,
    health: 0,
    described: false,
    events: 0,
  },
  of: (data) => {
    const validTabs: WebhookDetailTab[] =
      data.endpoint.kind === "http"
        ? ["overview", "deliveries", "replays", "transformation", "settings"]
        : ["overview", "deliveries", "replays", "settings"]
    const chosen = data.tab as WebhookDetailTab | undefined
    const tab = chosen && validTabs.includes(chosen) ? chosen : "overview"
    return {
      kind: data.endpoint.kind,
      tab,
      state: endpointState(data.endpoint),
      notice: noticeOf(data.endpoint),
      deliveries: Math.min(data.deliveries.length, MAX_SKELETON_ROWS),
      replays: Math.min(data.replays.length, MAX_SKELETON_ROWS),
      health: Math.min(data.health.length, MAX_SKELETON_ROWS),
      described: Boolean(data.endpoint.description),
      events: Math.min(data.stats?.by_event_type.length ?? 0, MAX_SKELETON_ROWS),
    }
  },
  parse: (raw) => {
    if (typeof raw !== "object" || raw === null) return null
    const r = raw as Record<string, unknown>
    const kind = r.kind === "sqs" || r.kind === "polling" ? r.kind : "http"
    const state: EndpointState =
      r.state === "failing" || r.state === "disabled" || r.state === "paused"
        ? r.state
        : "healthy"
    const notice: WebhookNoticeState =
      r.notice === "disabled" || r.notice === "paused" || r.notice === "failing"
        ? r.notice
        : "none"
    const tab: WebhookDetailTab =
      r.tab === "deliveries" ||
      r.tab === "replays" ||
      (kind === "http" && r.tab === "transformation") ||
      r.tab === "settings"
        ? (r.tab as WebhookDetailTab)
        : "overview"
    const deliveries = count(r.deliveries, MAX_SKELETON_ROWS) ?? 5
    const replays = count(r.replays, MAX_SKELETON_ROWS) ?? 0
    const health = count(r.health, MAX_SKELETON_ROWS) ?? 0
    // Cookies written before these fields existed read as "none".
    const described = r.described === true
    const events = count(r.events, MAX_SKELETON_ROWS) ?? 0
    return {
      kind,
      tab,
      state,
      notice,
      deliveries,
      replays,
      health,
      described,
      events,
    }
  },
})
