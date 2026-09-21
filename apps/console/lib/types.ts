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
    /**
     * A plan change accepted now and applied at the period boundary — what a
     * downgrade looks like for the rest of the month. `plan_id` above is still
     * the plan in force, deliberately: they keep what they paid for.
     */
    scheduled_plan_id: string | null
    scheduled_at: string | null
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

/**
 * What `POST /verify` saw in DNS, as opposed to what SES thinks.
 *
 * ⚠ TWO ANSWERS, NOT ONE, AND KEEPING THEM APART IS THE POINT. `absent` means
 * we asked the customer's nameservers and the records were not there;
 * `unreachable` means we never got an answer to ask about. Telling the second
 * person the first story sends them to re-check DNS that is already correct,
 * which is the most expensive wrong sentence this screen can say.
 *
 * ⚠ AND IT IS SEPARATE FROM `status`. `status` is Amazon's opinion of the
 * domain and lags DNS by minutes; this is what our own resolver saw during the
 * request. A domain can be proved here and still `pending` there, which is the
 * ordinary state between publishing records and being able to send — and the
 * one state the console previously described as "the records have not
 * propagated".
 */
export interface VerifiedDomain extends Domain {
  ownership?: { proven: true } | { proven: false; reason: "absent" | "unreachable" }
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
  /**
   * The one domain this key may send from, or `null` for every domain.
   *
   * ⚠ DERIVED BY THE API FROM `scopes`, AND THE CONSOLE DELIBERATELY DOES NOT
   * PARSE THAT ARRAY. The storage format is `domain:acme.com` and it is the
   * API's business — see apps/api/src/auth/scope.ts. A console that knew the
   * prefix would be a second place to spell it, and the one that is wrong is
   * always the one nobody tested.
   */
  domain: string | null
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
  /**
   * Delegated to us AND to something else at once — usually a previous
   * set-up's nameservers left published beside the current ones.
   *
   * ⚠ IT RESOLVES TODAY, WHICH IS WHAT MAKES IT WORTH A WARNING. Whichever
   * nameserver a resolver happens to pick decides whether the mail records
   * are found, so the domain works until the day it does not.
   */
  | {
      zone: string
      code: "extra_nameservers"
      observed: string[]
      unexpected: string[]
    }
  | { zone: string; code: "nameserver_silent" }
  | { zone: string; code: "lookup_failed" }

export interface DelegationReport {
  domain: string
  nameservers: string[]
  nameserversAnswering: boolean
  zones: ZoneFinding[]
  error?: string
}

/**
 * A DNS provider we can actually write to.
 *
 * ⚠ THE API DECIDES THIS, NOT THE CONSOLE. Whether a provider is connectable
 * depends on an adapter existing and, for the one-click path, on an OAuth app
 * being registered — one is a deploy and the other is configuration. Deciding it
 * from `@repo/dns-providers` here would render a live Connect button for the
 * twenty-nine providers we cannot write to.
 */
export interface ConnectableProvider {
  slug: string
  name: string
  /** A registered OAuth app exists, so the browser can be sent to authorise. */
  oauth: boolean
  /** A token can be pasted. True wherever an adapter exists. */
  token: boolean
  scope: string | null
  docs: string | null
  zoneScoped: boolean
}

/** A stored connection, as the console is allowed to see it. Never a credential. */
export interface DnsConnection {
  id: string
  provider: string
  label: string | null
  zones: string[]
  lastUsedAt: string | null
  lastError: string | null
  createdAt: string
}

export interface ConflictingRecord {
  name: string
  type: string
  value: string
  reason: string
}

export interface PublishOutcome {
  status: "published"
  created: { name: string; type: string; value: string }[]
  unchanged: { name: string; type: string; value: string }[]
  removed: ConflictingRecord[]
  /**
   * Records of OUR OWN that this publish replaced — a previous set left in the
   * customer's zone after the domain was deleted here and added again.
   *
   * ⚠ NOT THE SAME THING AS `removed`, AND THE CONSOLE MUST NOT REPORT THEM
   * THE SAME WAY. `removed` is the customer's data, deleted because they
   * agreed to it; this is our own litter, cleared without asking because
   * leaving it behind is what breaks the new set. See the API's
   * dns/superseded.ts.
   *
   * ⚠ OPTIONAL, BECAUSE AN OLDER API DOES NOT SEND IT. The console is
   * deployed separately and can be a version ahead.
   */
  superseded?: ConflictingRecord[]
}
