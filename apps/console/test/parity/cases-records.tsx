import { defineView } from "./harness"
import { MAX_SKELETON_ROWS } from "@/lib/list-counts"
import { iso, retext, rows } from "./fixtures"

// ⚠ LOADED AFTER harness.tsx HAS MOCKED `server-only` (see cases-lists.tsx).
const { previewFor } = await import("@/lib/preview")
const { WebhooksView } = await import("@/components/webhooks-view")
const { webhooksShape } = await import("@/lib/shapes/webhooks")
const { WebhookDetailView } = await import("@/components/webhook-detail-view")
const { webhookDetailShape } = await import("@/lib/shapes/webhook-detail")
const { WebhookDeliveryDetailView } =
  await import("@/components/webhook-delivery-detail-view")
const { webhookDeliveryDetailShape } =
  await import("@/lib/shapes/webhook-delivery-detail")
const { DomainDetailView } = await import("@/components/domain-detail-view")
const { domainDetailShape } = await import("@/lib/shapes/domain-detail")
const { NewDomainView } = await import("@/components/new-domain-view")
const { newDomainShape } = await import("@/lib/shapes/new-domain")
const { EmailView } = await import("@/components/email-view")
const { emailShape } = await import("@/lib/shapes/email")
const { BroadcastView } = await import("@/components/broadcast-view")
const { broadcastShape } = await import("@/lib/shapes/broadcast")
const { TemplateDetailView } = await import("@/components/template-detail-view")
const { templateDetailShape } = await import("@/lib/shapes/template-detail")
const { GithubSetupView } = await import("@/components/github-setup-view")
const { githubSetupShape } = await import("@/lib/shapes/github-setup")

import type { BroadcastData } from "@/lib/shapes/broadcast"
import type { DomainDetailData } from "@/lib/shapes/domain-detail"
import type { EmailData } from "@/lib/shapes/email"
import type { NewDomainData } from "@/lib/shapes/new-domain"
import type { TemplateDetailData } from "@/lib/shapes/template-detail"
import type { WebhookDeliveryDetailData } from "@/lib/shapes/webhook-delivery-detail"
import type { WebhookDetailData } from "@/lib/shapes/webhook-detail"
import type { WebhooksData } from "@/lib/shapes/webhooks"
import type {
  BroadcastDetail,
  DeliveryRow,
  DnsInspection,
  Domain,
  DomainSummary,
  EmailDetail,
  Page,
  SegmentRow,
  TemplateDetail,
  TopicRow,
  WebhookDeliveryDetail,
  WebhookEndpoint,
  WebhookEndpointStats,
  WebhookEventType,
  WebhookHealthEvent,
  WebhookReplay,
  WebhookStats,
} from "@/lib/types"

/** What the preview API answers for `path`, typed by the caller. */
const api = <T,>(path: string, query?: Record<string, string | number>) =>
  previewFor(path, query) as T

// ── Webhooks ─────────────────────────────────────────────────────────────

const endpoints = () =>
  api<{ data: WebhookEndpoint[] }>("/console/webhook-endpoints").data
const deliveries = () => api<Page<DeliveryRow>>("/console/webhook-deliveries")
// A skeleton draws at most MAX_SKELETON_ROWS rows, so a fixture past that is a page it cannot match by design.
const someDeliveries = () => deliveries().data.slice(0, MAX_SKELETON_ROWS)
const catalog = () =>
  api<{ data: WebhookEventType[] }>("/console/webhook-event-types").data

const webhooksData =
  (over: Partial<WebhooksData> = {}) =>
  (tag: string): WebhooksData => ({
    endpoints: retext(endpoints(), tag, ["description", "url"]),
    deliveries: someDeliveries(),
    nextCursor: null,
    stats: api<WebhookStats>("/console/webhook-stats", { window: "24h" }),
    catalog: catalog(),
    tab: "endpoints",
    view: "grid",
    ...over,
  })

const healthy = (e: WebhookEndpoint): WebhookEndpoint => ({
  ...e,
  health: "healthy",
  enabled: true,
  disabled_reason: null,
})

// ── Domains ──────────────────────────────────────────────────────────────

const domainList = () => api<{ data: DomainSummary[] }>("/console/domains").data

function domainData(index: number, tag: string): DomainDetailData {
  const summary = domainList()[index]!
  const domain = api<Domain>(`/console/domains/${summary.id}`)
  return {
    domain: retext(domain, tag, ["name", "value"]),
    delegation: null,
    inspection: api<DnsInspection>("/console/dns/lookup", { domain: domain.name }),
    connectable: null,
    connection: null,
    scopedKeys: [],
    keyImpact: [],
    transfer: null,
    ownEmails: [`${tag}@example.com`],
  }
}

// ── Email, broadcast, template ───────────────────────────────────────────

const emailList = () =>
  api<Page<{ id: string }>>("/console/emails").data.map((e) => e.id)

function emailData(index: number, tag: string): EmailData {
  const email = api<EmailDetail>(`/console/emails/${emailList()[index]}`)
  return { email: retext(email, tag, ["subject", "html", "text", "last_error"]) }
}

// Only the preview broadcasts the API would answer in full: some are list stubs.
const broadcastIds = () =>
  api<Page<{ id: string }>>("/console/broadcasts")
    .data.map((b) => b.id)
    .filter((id) => {
      const detail = api<BroadcastDetail | undefined>(`/console/broadcasts/${id}`)
      return typeof detail?.from === "string" && detail.stats !== undefined
    })

function broadcastData(
  index: number,
  tag: string,
  over: Partial<BroadcastDetail> = {},
): BroadcastData {
  const broadcast = api<BroadcastDetail>(`/console/broadcasts/${broadcastIds()[index]}`)
  return {
    broadcast: {
      ...retext(broadcast, tag, ["name", "subject"]),
      recipient_count: broadcast.recipient_count ?? null,
      stats: broadcast.stats,
      ...over,
    },
    segments: rows(2, (i) => ({
      id: `seg_${tag}${i}`,
      name: `${tag} segment ${i}`,
      description: null,
      contact_count: 4,
      created_at: iso(2),
    })) as SegmentRow[],
    topics: api<{ data: TopicRow[] }>("/console/topics").data,
    domains: domainList(),
  }
}

const templateIds = () =>
  api<Page<{ id: string }>>("/console/templates").data.map((t) => t.id)

function templateData(index: number, tag: string, tab?: string): TemplateDetailData {
  const template = api<TemplateDetail>(`/console/templates/${templateIds()[index]}`)
  return { template: retext(template, tag, ["name", "title", "subject"]), tab }
}

export const RECORD_VIEWS = [
  defineView({
    route: "/webhooks",
    pathname: "/webhooks",
    View: WebhooksView,
    shape: webhooksShape,
    cases: [
      { name: "empty", fixture: webhooksData({ endpoints: [], deliveries: [] }) },
      {
        name: "one healthy endpoint",
        fixture: (tag) => webhooksData({ endpoints: [healthy(endpoints()[0]!)] })(tag),
      },
      {
        name: "endpoints as a grid",
        fixture: webhooksData(),
      },
      {
        name: "endpoints as a table",
        fixture: webhooksData({ view: "table" }),
      },
      {
        name: "failing and disabled endpoints (banner)",
        fixture: (tag) =>
          webhooksData({
            endpoints: [
              { ...endpoints()[0]!, health: "failing", enabled: true },
              { ...endpoints()[1]!, health: "disabled", enabled: false },
            ],
          })(tag),
      },
      {
        name: "deliveries tab",
        fixture: webhooksData({ tab: "deliveries" }),
      },
      {
        name: "deliveries tab, empty",
        fixture: webhooksData({ tab: "deliveries", deliveries: [] }),
      },
    ],
  }),

  defineView({
    route: "/webhooks/[id]",
    pathname: "/webhooks/x",
    params: { id: "x" },
    View: WebhookDetailView,
    shape: webhookDetailShape,
    cases: ["overview", "deliveries", "replays", "settings"].map((tab) => ({
      name: `${tab} tab`,
      fixture: (tag: string): WebhookDetailData => {
        const endpoint = retext(healthy(endpoints()[0]!), tag, ["description", "url"])
        return {
          endpoint,
          stats: api<WebhookEndpointStats>(
            `/console/webhook-endpoints/${endpoint.id}/stats`,
          ),
          dayStats: null,
          health: [] as WebhookHealthEvent[],
          deliveries: someDeliveries(),
          nextCursor: null,
          replays: api<{ data: WebhookReplay[] }>(
            `/console/webhook-endpoints/${endpoint.id}/replays`,
          ).data,
          catalog: catalog(),
          window: "24h",
          tab,
        }
      },
    })),
  }),

  defineView({
    route: "/webhooks/deliveries/[id]",
    pathname: "/webhooks/deliveries/x",
    params: { id: "x" },
    View: WebhookDeliveryDetailView,
    shape: webhookDeliveryDetailShape,
    cases: [
      {
        name: "a delivery",
        fixture: (tag): WebhookDeliveryDetailData => {
          const id = deliveries().data[0]!.id
          const delivery = api<WebhookDeliveryDetail>(
            `/console/webhook-deliveries/${id}`,
          )
          return {
            delivery: retext(delivery, tag, ["last_error", "event_type"]),
            endpoint: endpoints()[0]!,
          }
        },
      },
      {
        name: "a failed delivery with its error",
        fixture: (tag): WebhookDeliveryDetailData => {
          const id = deliveries().data[0]!.id
          const delivery = api<WebhookDeliveryDetail>(
            `/console/webhook-deliveries/${id}`,
          )
          return {
            delivery: { ...delivery, status: "failed", last_error: `${tag} refused` },
            endpoint: endpoints()[0]!,
          }
        },
      },
    ],
  }),

  defineView({
    route: "/domains/[id]",
    pathname: "/domains/x",
    params: { id: "x" },
    View: DomainDetailView,
    shape: domainDetailShape,
    cases: domainList().map((d, i) => ({
      name: `${d.name} (${d.status})`,
      fixture: (tag: string) => domainData(i, tag),
    })),
  }),

  defineView({
    route: "/domains/new",
    pathname: "/domains/new",
    View: NewDomainView,
    shape: newDomainShape,
    cases: [
      {
        name: "a fresh start",
        fixture: (tag): NewDomainData => ({ tenantId: `ten_${tag}`, restored: null }),
      },
    ],
  }),

  defineView({
    route: "/emails/[id]",
    pathname: "/emails/x",
    params: { id: "x" },
    View: EmailView,
    shape: emailShape,
    // The first few of the preview log: they differ in status, recipients and errors.
    cases: emailList()
      .slice(0, 5)
      .map((id, i) => ({
        name: `preview email ${i}`,
        fixture: (tag: string) => emailData(i, tag),
      })),
  }),

  defineView({
    route: "/broadcasts/[id]",
    pathname: "/broadcasts/x",
    params: { id: "x" },
    View: BroadcastView,
    shape: broadcastShape,
    cases: [
      ...broadcastIds().map((id, i) => ({
        name: `preview broadcast ${i}`,
        fixture: (tag: string) => broadcastData(i, tag),
      })),
      {
        name: "a draft (editable, no results)",
        fixture: (tag: string) =>
          broadcastData(0, tag, { status: "draft", sent_at: null, scheduled_at: null }),
      },
      {
        name: "a scheduled send (a step more)",
        fixture: (tag: string) =>
          broadcastData(0, tag, {
            status: "scheduled",
            sent_at: null,
            scheduled_at: iso(-1),
          }),
      },
    ],
  }),

  defineView({
    route: "/templates/[id]",
    pathname: "/templates/x",
    params: { id: "x" },
    View: TemplateDetailView,
    shape: templateDetailShape,
    cases: [
      { name: "preview tab", fixture: (tag) => templateData(0, tag) },
      { name: "versions tab", fixture: (tag) => templateData(0, tag, "versions") },
    ],
  }),

  defineView({
    route: "/templates/github/setup",
    pathname: "/templates/github/setup",
    View: GithubSetupView,
    shape: githubSetupShape,
    cases: [{ name: "the page", fixture: () => ({}) }],
  }),
]
