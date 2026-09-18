/**
 * The shapes `/console/*` answers with.
 *
 * ⚠ HAND-WRITTEN AND NOT IMPORTED FROM THE API, WHICH IS A DELIBERATE COST.
 * `apps/api` is a bun server with a database driver, AWS clients and Redis in
 * its dependency graph; importing a type from it drags its `tsconfig`, its
 * `@types/bun`, and — the moment somebody imports a value by accident — its
 * runtime into a Next build. `@repo/contracts` exists for the shapes that are a
 * PUBLIC contract and is used for those; this file covers the console's private
 * surface, which is deliberately not one.
 *
 * ⚠ THE CONSEQUENCE IS THAT THESE CAN DRIFT, AND THE DRIFT IS SILENT. A field
 * renamed on the API renders as `undefined` here rather than failing to
 * compile. The mitigation is that both sides are in one repository and one
 * commit; if this surface ever leaves that arrangement, it needs generating.
 */

export interface TenantProfile {
  id: string
  slug: string
  name: string
  status: string
  clerk_org_id: string | null
  created_at: string
}

export interface PlanSummary {
  id: string
  name: string
  rank: number
  source: string
  entitlements: {
    featureId: string
    kind: string
    allowance: number
    interval?: string
    overage?: string
  }[]
}

export interface BillingState {
  plan: PlanSummary | null
  subscription: {
    status: string
    plan_id: string
    cancel_at_period_end: boolean
    current_period_end: string | null
    polar_customer_id: string
  } | null
  anchor: string | null
  overage_enabled: boolean
  storage_bytes: number | null
}

export interface OnboardingState {
  step: "workspace" | "domain" | "verify" | "send" | "plan"
  completed_at: string | null
  last_onboarded_plan: string | null
  use_case: string | null
  should_onboard: boolean
  facts: {
    has_domain: boolean
    has_verified_domain: boolean
    has_api_key: boolean
  }
}

export interface Me {
  user: { id: string }
  tenant: TenantProfile | null
  billing: BillingState
  onboarding: OnboardingState
}

export interface DailyStat {
  date: string
  sent: number
  delivered: number
  bounced: number
  complained: number
  delayed: number
  failed: number
}

export interface Overview {
  series: DailyStat[]
  totals: {
    sent: number
    delivered: number
    bounced: number
    complained: number
    delayed: number
    failed: number
  }
  counts: {
    domains: number
    verifiedDomains: number
    apiKeys: number
    webhookEndpoints: number
    suppressions: number
  }
}

export interface Page<T> {
  data: T[]
  nextCursor: string | null
}

export interface EmailRow {
  id: string
  created_at: string
  from: string
  to: string[]
  subject: string
  status: string
  last_event: string
  scheduled_at: string | null
  sent_at: string | null
  route: string | null
  last_error: string | null
}

export interface EmailDetail extends EmailRow {
  cc: string[]
  bcc: string[]
  reply_to: string[]
  html: string | null
  text: string | null
  headers: Record<string, string> | null
  attachments: { filename?: string; content_type?: string; size?: number }[] | null
  tags: Record<string, string> | null
  events: { type: string; occurred_at: string; payload: unknown }[]
  domain_id: string | null
  api_key_id: string | null
  broadcast_id: string | null
  provider_message_id: string | null
  attempts: number
}

export interface DnsRecord {
  record: string
  name: string
  type: "MX" | "TXT" | "CNAME" | "NS"
  ttl: string
  status: string
  value: string
  priority?: number
}

export interface DomainSummary {
  object: "domain"
  id: string
  name: string
  status: string
  created_at: string
  region: string
  delegated: boolean
}

export interface Domain extends DomainSummary {
  records: DnsRecord[]
}

export interface DnsInspection {
  domain: string
  nameservers: string[]
  provider: {
    slug: string
    name: string
    kind: string
    nsDelegation: boolean
    canConnect: boolean
    oauth: boolean
    manualPath?: string
    helpUrl?: string
  } | null
  confidence: "exact" | "partial" | "none"
  records: {
    txt: string[]
    mx: { exchange: string; priority: number }[]
    dmarc: string[]
  }
  error?: string
}

export interface ApiKeyRow {
  id: string
  name: string
  prefix: string
  mode: string
  scopes: string[]
  created_at: string
  last_used_at: string | null
  expires_at: string | null
  revoked_at: string | null
}

/** ⚠ `secret` IS PRESENT EXACTLY ONCE, IN THE CREATE RESPONSE. Nothing stores it. */
export interface CreatedApiKey extends Omit<
  ApiKeyRow,
  "last_used_at" | "expires_at" | "revoked_at"
> {
  secret: string
}

export interface WebhookEndpoint {
  object: "webhook_endpoint"
  id: string
  url: string
  events: string[]
  description: string | null
  enabled: boolean
  created_at: string
  /** ⚠ Only on create and on rotate. */
  secret?: string
}

export interface DeliveryRow {
  id: string
  endpoint_id: string
  endpoint_url: string | null
  event_type: string
  status: string
  attempts: number
  response_status: number | null
  last_error: string | null
  occurred_at: string
  delivered_at: string | null
  created_at: string
}

export interface SuppressionRow {
  address: string
  reason: string
  message_id: string | null
  created_at: string
}

export interface RequestRow {
  id: string
  method: string
  path: string
  status: number
  duration_ms: number
  error_name: string | null
  user_agent: string | null
  api_key_id: string | null
  occurred_at: string
}

export interface FeatureUsage {
  feature_id: string
  label: string
  unit: string
  used: number
  allowance: number | null
  remaining: number | null
  resets_at: string | null
  overage: boolean
  status: "ok" | "unentitled" | "unreadable"
}

export interface ContactRow {
  id: string
  email: string
  first_name: string | null
  last_name: string | null
  unsubscribed: boolean
  properties: Record<string, unknown> | null
  created_at: string
}

export interface ContactDetail extends ContactRow {
  segments: { id: string; name: string }[]
  topics: { id: string; name: string; subscribed: boolean }[]
}

export interface SegmentRow {
  id: string
  name: string
  description: string | null
  contact_count: number
  created_at: string
}

export interface TopicRow {
  id: string
  name: string
  description: string | null
  default_subscription: string
  visibility: string
  subscriber_count: number
  created_at: string
}

export interface PropertyRow {
  id: string
  key: string
  type: string
  fallback_value: string | null
  created_at: string
}

export interface BroadcastRow {
  id: string
  segment_id: string | null
  segment_name: string | null
  topic_id: string | null
  name: string
  from: string
  reply_to: string[]
  subject: string
  preview_text: string | null
  html: string | null
  text: string | null
  status: string
  scheduled_at: string | null
  sent_at: string | null
  recipient_count: number | null
  created_at: string
}

/**
 * A broadcast in a LIST: the same row without its body.
 *
 * ⚠ THE LIST ENDPOINT DOES NOT SEND `html` OR `text`, AND THE TYPE SAYS SO. A
 * broadcast body is a whole marketing email; shipping one per row to draw a
 * table of names made the page a multi-megabyte response that rendered none of
 * it. Typing the list as `BroadcastRow` would have let a component reach for
 * `broadcast.html` and get `undefined` at runtime with the compiler agreeing.
 */
export type BroadcastSummary = Omit<BroadcastRow, "html" | "text">

/** A template in a list: the same row without its body, for the same reason. */
export type TemplateSummary = Omit<TemplateRow, "html" | "text">

export interface BroadcastDetail extends BroadcastRow {
  stats: {
    total: number
    delivered: number
    bounced: number
    complained: number
    failed: number
  }
}

export interface TemplateRow {
  id: string
  name: string
  folder: string | null
  subject: string | null
  html: string | null
  text: string | null
  published_at: string | null
  version: number
  created_at: string
  updated_at: string
}

/**
 * Why a delegated domain has not verified. See apps/api/src/console/delegation.ts.
 *
 * ⚠ THE FINDINGS ARE A UNION RATHER THAN A STRING, because the console's whole
 * job with them is to say a different sentence for each — and one of those
 * sentences blames us rather than the customer.
 */
export type ZoneFinding =
  | { zone: string; code: "ok" }
  | { zone: string; code: "not_published" }
  | { zone: string; code: "delegated_elsewhere"; observed: string[] }
  | { zone: string; code: "nameserver_silent" }
  | { zone: string; code: "lookup_failed" }

export interface DelegationReport {
  domain: string
  nameservers: string[]
  nameserversAnswering: boolean
  zones: ZoneFinding[]
  error?: string
}
