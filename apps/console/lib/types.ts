/**
 * The shapes `/console/*` answers with.
 *
 * ⚠ HAND-WRITTEN AND NOT IMPORTED FROM THE API, WHICH IS A DELIBERATE COST.
 * `apps/api` is a bun server with a database driver, AWS clients and Redis in
 * its dependency graph; importing a type from it drags its `tsconfig`, its
 * `@types/bun`, and - the moment somebody imports a value by accident - its
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
     * A plan change accepted now and applied at the period boundary - what a
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
  user: {
    id: string
    /** Primary address, if verified. Prefills the onboarding test email. */
    email: string | null
    /** Every verified address - the transfer dialog refuses these. */
    verified_emails: string[]
  }
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
  /**
   * When another workspace proved this name and took it. Console-only - the
   * public API's domain says nothing about our other customers.
   */
  displaced_at?: string | null
}

export interface Domain extends DomainSummary {
  records: DnsRecord[]
  /** Open and click tracking (#154). Off unless the owner turned it on. */
  open_tracking: boolean
  click_tracking: boolean
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
 * ordinary state between publishing records and being able to send - and the
 * one state the console previously described as "the records have not
 * propagated".
 */
export interface VerifiedDomain extends Domain {
  /**
   * ⚠ `superseded` IS THE THIRD REASON AND IT NEEDS ITS OWN SENTENCE. It means
   * the NS records are published and point at us, but name an EARLIER claim -
   * which is what every delete-and-re-add produces, because the delegation
   * token is issued per domain row. Folding it into `absent` tells somebody
   * their records are missing while they are looking straight at them.
   */
  ownership?:
    | { proven: true }
    | { proven: false; reason: "absent" | "unreachable" | "superseded" }
  /**
   * Only when this verify took the name from another workspace AND that
   * workspace's records still resolve. The latest proof wins, so while these
   * are published the old holder can take it back - removing them keeps it.
   */
  leftover_records?: { type: "TXT" | "NS"; name: string; value?: string }[]
}

/** A workspace the signed-in person belongs to. The id is Clerk's. */
export interface Workspace {
  id: string
  name: string
}

/** A domain offered to an email address, waiting for an answer. */
export interface TransferOffer {
  id: string
  domain_id: string
  domain_name: string
  recipient_email: string
  offered_by: string
  from_workspace: string
  created_at: string
  expires_at: string
}

/**
 * One offer as its recipient sees it, with where it could land.
 *
 * ⚠ THE WORKSPACE THE DOMAIN IS ALREADY IN IS LEFT OUT BY THE API, which is
 * what lets somebody in the sender's own workspace take it into another.
 */
export interface IncomingTransfer extends TransferOffer {
  workspaces: (Workspace & { current: boolean })[]
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
   * The domains this key may send from; empty for every domain.
   *
   * ⚠ DERIVED BY THE API FROM `scopes`, AND THE CONSOLE DELIBERATELY DOES NOT
   * PARSE THAT ARRAY. The storage format is `domain:acme.com` and it is the
   * API's business - see apps/api/src/auth/scope.ts. A console that knew the
   * prefix would be a second place to spell it, and the one that is wrong is
   * always the one nobody tested.
   */
  domains: string[]
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

/** One sending limit, per window. Mirrors `SendingLimit` in the API. */
export interface SendingLimit {
  window: "day" | "week" | "month" | "year" | "lifetime"
  count: number
  source: "plan" | "tier" | "none"
  tier?: string
  used: number
  allowance: number | null
  remaining: number | null
  resets_at: string | null
  overage: boolean
  starts_on_send: boolean
  status: "ok" | "unreadable"
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

/** Where a template is maintained (#234). See `templateSource` in the API's db/core.ts. */
export type TemplateSource = "managed" | "upload" | "github"

export interface TemplateRow {
  id: string
  name: string
  folder: string | null
  /**
   * `html` is written here as HTML; `visual` in the React Email editor (#243);
   * `tsx` is a React Email component, uploaded or pushed (#160).
   */
  kind: "html" | "tsx" | "visual"
  source: TemplateSource
  subject: string | null
  /** The draft body of an `html` template, or what a `visual` one exported. */
  html: string | null
  text: string | null
  /** A `visual` template's draft: the editor's TipTap JSON. */
  design?: Record<string, unknown> | null
  /** When the live version was created; null before the first publish. */
  published_at: string | null
  /** The live version's number; 0 before the first publish. */
  version: number
  /** How many versions exist. */
  versions: number
  created_at: string
  updated_at: string
}

/** One variable a version takes: its dotted path and the sample it previews with. */
export interface TemplateVariable {
  path: string
  preview: string
}

/** A version in a template's history. Versions are immutable (#160). */
export interface TemplateVersionSummary {
  id: string
  number: number
  kind: TemplateRow["kind"]
  subject: string | null
  variables: TemplateVariable[]
  /** Which React and React Email rendered a `tsx` version. */
  runtime: string | null
  /** The entry's path in the upload or repository. */
  path: string | null
  /** The commit a GitHub template's version came from. */
  commit_sha: string | null
  live: boolean
  created_at: string
}

export interface TemplateVersionDetail extends TemplateVersionSummary {
  /** The entry `.tsx`. */
  source: string | null
  /** The other files it imports, path to text. */
  files: Record<string, string> | null
  /** A `visual` version's editor document. */
  design?: Record<string, unknown> | null
  /** The skeleton with markers written as `{{ path }}`: for reading and diffing. */
  display: { html: string | null; text: string | null }
}

export interface TemplateDetail extends TemplateRow {
  history: TemplateVersionSummary[]
  /** Where the workspace's own template images load from (#244, #248). */
  assets_origin?: string | null
}

/** A version filled with sample or given values, exactly as a send would fill it. */
export interface TemplatePreview {
  subject: string | null
  html: string | null
  text: string | null
}

/** What happened to one template in an upload (#234). */
export type TemplateUploadOutcome = {
  path: string
  name: string
  folder: string | null
  template_id: string | null
} & (
  | { outcome: "created" | "versioned" | "unchanged"; version: number }
  | { outcome: "refused"; problems: string[] }
  | { outcome: "unavailable"; message: string }
)

/**
 * A template submitted for staff review (#222). The API's public shape, the
 * same one `/trusted-templates` returns.
 *
 * ⚠ APPROVAL COVERS REPETITION, NEVER RESULTS. See apps/api/src/risk/trusted.ts.
 */
export interface TrustedTemplateRow {
  object: "trusted_template"
  id: string
  name: string
  status: "pending" | "approved" | "rejected" | "revoked" | "withdrawn"
  html: string | null
  text: string | null
  holes: { name: string; max: number }[]
  matched: number
  submitted_at: string
  decided_at: string | null
  decision_reason: string | null
}

/**
 * Why a delegated domain has not verified. See apps/api/src/console/delegation.ts.
 *
 * ⚠ THE FINDINGS ARE A UNION RATHER THAN A STRING, because the console's whole
 * job with them is to say a different sentence for each - and one of those
 * sentences blames us rather than the customer.
 */
export type ZoneFinding =
  | { zone: string; code: "ok" }
  | { zone: string; code: "not_published" }
  | { zone: string; code: "delegated_elsewhere"; observed: string[] }
  /**
   * Delegated to us AND to something else at once - usually a previous
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
 * being registered - one is a deploy and the other is configuration. Deciding it
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
   * Records of OUR OWN that this publish replaced - a previous set left in the
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

/** A reputation finding SES has open against the workspace (#158). */
export interface SendingFinding {
  /** SES's type, lowercased: `bounce`, `complaint`, `feedback_3p`, `ip_listing`. */
  type: string
  impact: "high" | "low"
  description: string | null
  opened_at: string
}

/** `GET /console/sending-status` (#157, #158). */
export interface SendingStatus {
  status: "enabled" | "disabled" | "reinstated"
  cause: string | null
  changed_at: string | null
  health: "healthy" | "at_risk" | "paused" | "held"
  findings: SendingFinding[]
  /** Our own review's hold (#170). The category sentence, never a threshold. */
  hold?: { why: string; held_at: string; canceled_messages: number } | null
}

/** `GET /console/sending-health`: the status plus seven days of our own counts. */
export interface SendingHealth extends SendingStatus {
  window_days: number
  sends: number
  hard_bounces: number
  soft_bounces: number
  complaints: number
  bounce_rate: number | null
  soft_bounce_rate: number | null
  complaint_rate: number | null
}

/** `GET /console/attention`: what the sidebar's mark on Domains is counting. */
export interface Attention {
  domains: {
    total: number
    unverified: number
    proof_missing: number
    transfers: number
    reputation: "healthy" | "at_risk" | "paused" | "held"
  }
}
