import type { HoldStore } from "../../risk/holds.js"
import type { TrustedTemplateStore } from "../../risk/trusted.js"
import type { SubscriptionOps } from "../../billing/db.js"
import type { TenantAuthDeps } from "../../middleware/tenant.js"
import type { FreshAuthReader } from "../../middleware/session.js"
import type { ConsoleQueries } from "../../console/queries.js"
import type { ReputationStore } from "../../ses-status/reputation-store.js"
import type { SesStatusStore } from "../../ses-status/store.js"
import type { SuppressionStore } from "../../suppressions/store.js"
import type { MarketingStore } from "../../console/marketing.js"
import type { TemplateStore } from "../../templates/store.js"
import type { SendEmail } from "@repo/contracts"
import type { AcceptOutcome } from "../../send/accept.js"
import type { Renderer } from "../../templates/renderer.js"
import type { TemplateAssets } from "../../templates/assets.js"
import type { GitHubApp } from "../../github/client.js"
import type { GithubStore } from "../../github/store.js"
import type { GithubSyncer } from "../../github/sync.js"
import type { OnboardingStore } from "../../console/onboarding.js"
import type { UsageStore } from "../../console/usage.js"
import type { DomainStore } from "../../domains/store.js"
import type { DomainTransfers } from "../../domains/transfers.js"
import type { KeyCache } from "../../auth/api-key.js"
import type { KeyStore } from "../../auth/store.js"
import type { WebhookEndpointStore } from "../../webhooks/store.js"
import type { WebhookHistory } from "../../webhooks/history.js"
import type { DnsInspector } from "../../console/dns.js"
import type { DelegationChecker } from "../../console/delegation.js"
import type { DnsConnectionStore } from "../../dns/connections.js"
import type { DnsOAuth } from "../../dns/oauth.js"
import type { DnsPublisher } from "../../dns/publish.js"
import type { TenantProfileStore } from "../../console/tenant.js"
import type { PolarClient } from "../../billing/polar.js"
import type { PlanChange } from "../../billing/plan-change.js"

export interface ConsoleDeps extends TenantAuthDeps {
  /**
   * Reads how recently the session's factors were verified.
   *
   * ⚠ ITS ABSENCE REFUSES THE DESTRUCTIVE ROUTES RATHER THAN OPENING THEM. See
   * `requireFreshAuth`: a deployment that forgot to wire this stops deletions,
   * which is the failure anybody would rather have.
   */
  freshAuth?: FreshAuthReader
  queries: ConsoleQueries
  /**
   * SES's sending status for the workspace (#157), for the console banner.
   * Optional; without it the banner never shows.
   */
  sesStatus?: Pick<SesStatusStore, "current">
  /**
   * SES reputation findings and our own rates (#158), for the banner and the
   * overview's sending-health card. Optional; without it both read healthy.
   */
  sesReputation?: Pick<ReputationStore, "openFindings" | "counts">
  /**
   * The risk engine's hold on the workspace (#170), for the same banner.
   * Optional; without it no hold ever shows.
   */
  holds?: Pick<HoldStore, "current">
  /**
   * Records who is using the console, from where and on what (#170). Called
   * after `requireTenant`, never awaited: a failure costs a sighting, never a
   * page. See risk/identity.ts.
   */
  observeSession?: (input: {
    userId: string
    tenantId: string
    request: Request
  }) => void
  /**
   * The suppression list - the same store `/suppressions` uses. Optional like
   * the other stores the tests leave out; its routes then answer 501.
   */
  suppressions?: SuppressionStore
  /**
   * Templates submitted for staff review (#222) - the store `/trusted-templates`
   * uses. Optional; without it the routes answer 501.
   */
  trustedTemplates?: TrustedTemplateStore
  usage: UsageStore
  onboarding: OnboardingStore
  marketing: MarketingStore
  /**
   * The workspace's templates and versions (#160, #161). Optional like the
   * other stores the tests leave out; its routes then answer 501.
   */
  templates?: TemplateStore
  /**
   * The sandbox that renders an uploaded `.tsx` once (#160). Optional: without
   * it HTML templates work and uploads answer 501. See TEMPLATE_RENDERER_URL.
   */
  templateRenderer?: Renderer
  /**
   * Images for templates (#244). Optional: without the TEMPLATE_ASSETS_*
   * settings, uploads answer 501 and the editor takes image addresses only.
   */
  templateAssets?: TemplateAssets
  /**
   * Sends one email down the ordinary send path, as the workspace - what a
   * template's "Test email" uses. Optional; without it the route answers 501.
   *
   * ⚠ THE SAME PATH AS AN API SEND, so a test is signed, logged, suppression-
   * checked and metered exactly like the real thing, and refused for exactly
   * the same reasons (an unverified sender, a paused workspace).
   */
  /**
   * Which of these domains the workspace may send from - the send path's own
   * answer, so a template's From is held to exactly the rule a send is.
   * Optional; without it a From is checked for shape only.
   */
  sendableFrom?: (tenantId: string, domains: string[]) => Promise<Set<string>>
  sendTest?: (
    tenantId: string,
    payload: SendEmail,
    /** A key that makes a second identical request replay the first (onboarding). */
    options?: { idempotencyKey?: string },
  ) => Promise<AcceptOutcome>
  /**
   * GitHub-connected templates (#235). Optional: without the GITHUB_APP_*
   * settings the routes answer 501 and nothing else changes.
   */
  github?: {
    app: GitHubApp
    store: GithubStore
    syncer: GithubSyncer
    /** The app's OAuth client secret, which also keys the install state. */
    clientSecret: string
  }
  profile: TenantProfileStore
  /**
   * Renaming the Clerk organization behind the workspace.
   *
   * ⚠ IT IS A SEPARATE PORT RATHER THAN PART OF `profile` BECAUSE IT IS A
   * SEPARATE SYSTEM WITH A SEPARATE FAILURE. `profile.rename` is a transaction
   * against our own database and either happens or does not; this is a call
   * over the network to somebody else's, and the whole point of the design
   * below is that the second cannot take the first down with it.
   *
   * ⚠ OPTIONAL, AND ITS ABSENCE IS THE OLD BEHAVIOUR RATHER THAN AN ERROR.
   * Without it renaming a workspace renames only ours, which is exactly what
   * this endpoint did before - the two names simply drift, which is the
   * complaint rather than a crash.
   */
  organizations?: { rename(clerkOrgId: string, name: string): Promise<void> }
  /**
   * The Clerk organizations a person belongs to - where an accepted domain may
   * land.
   *
   * ⚠ OPTIONAL, AND ITS ABSENCE TURNS TRANSFERS OFF RATHER THAN OPENING THEM.
   * Without it there is no way to know which workspaces a person may write to,
   * and guessing is the one thing an authorisation check cannot do.
   */
  memberships?: { list(userId: string): Promise<{ id: string; name: string }[]> }
  /**
   * Who the signed-in person is: a name to sign an offer with, and the
   * addresses Clerk has VERIFIED for them - the only thing an offer is ever
   * matched against.
   */
  people?: {
    get(
      userId: string,
    ): Promise<{ name: string; primaryEmail: string | null; verifiedEmails: string[] }>
  }
  transfers?: DomainTransfers
  /**
   * Emails the recipient of an offer.
   *
   * ⚠ OPTIONAL, AND ITS ABSENCE LEAVES THE OFFER IN-APP ONLY. Somebody with an
   * account still sees it on their domains page; somebody without one does not
   * hear about it at all, which the route reports back to the sender.
   */
  transferNotice?: {
    send(input: {
      to: string
      offerId: string
      domain: string
      offeredBy: string
      fromWorkspace: string
      expiresAt: Date
    }): Promise<void>
  }
  /** Optional for the same reason `AppDeps.domains` is - see createApp. */
  domains?: DomainStore
  /**
   * ⚠ THE CACHE IS NOT OPTIONAL IN PRACTICE, EVEN THOUGH THE TYPE ALLOWS IT.
   * Revoking a key is two acts - the row and the Redis entry - and without the
   * second the key keeps working for up to the TTL after the customer was told
   * it was dead. See the delete route.
   */
  keys?: { store: KeyStore; cache?: KeyCache }
  webhooks?: WebhookEndpointStore
  /** A delivery's attempts, and expunging its payload (#280). */
  webhookHistory?: WebhookHistory
  /** Resend and replay (#282). */
  webhookReplays?: import("../../webhooks/replay.js").WebhookReplayOps
  /** Sends a sample event to one endpoint (#281). */
  webhookTests?: (
    tenantId: string,
    endpointId: string,
    type: import("../../webhooks/events.js").WebhookEventType,
  ) => Promise<import("../../webhooks/test-events.js").TestResult>
  dns?: DnsInspector
  /**
   * Why a delegated domain has not verified yet.
   *
   * ⚠ OPTIONAL, AND ITS ABSENCE HIDES THE PANEL RATHER THAN FAILING THE PAGE.
   * The domain still renders its records and its status; what is lost is the
   * sentence explaining which of four indistinguishable reasons is the live
   * one. Degrading to the old behaviour is correct - that behaviour was
   * uninformative, not broken.
   */
  delegation?: DelegationChecker
  /**
   * Customers' credentials for their own DNS, and the machinery that uses them.
   *
   * ⚠ ALL THREE ARE OPTIONAL TOGETHER, BECAUSE THEY DEPEND ON THE SEALING KEY.
   * Without `WEBHOOK_SECRET_KEY` there is nowhere safe to keep a credential that
   * can rewrite a customer's MX records, so the routes answer 501 rather than
   * storing one in the clear - the same rule `core.domains` and the webhook
   * secrets already follow.
   */
  dnsConnections?: DnsConnectionStore
  dnsOAuth?: DnsOAuth
  dnsPublisher?: DnsPublisher
  /**
   * Buying a plan, and moving between them.
   *
   * ⚠ A SECOND ENTRY POINT TO THE SAME OPERATIONS `/billing` ALREADY EXPOSES,
   * AND IT EXISTS BECAUSE THE CREDENTIALS DIFFER. `/billing` is API-key
   * authenticated, which a browser does not have and must not be given. This is
   * the same two calls behind a session.
   *
   * ⚠ NEITHER OF THEM GRANTS ANYTHING. `checkout` hands back a URL and writes
   * nothing; the entitlement moves only when Polar's signature-verified webhook
   * says the money arrived. That is the whole reason the console polls
   * afterwards rather than acting on the redirect.
   */
  billing?: {
    polar: PolarClient
    /** Our plan id → Polar product id. The only plans that can be bought. */
    products: Record<string, string>
    /**
     * ⚠ NARROWED TO THE ONE WRITE THIS ROUTE OWES THE REST OF THE SYSTEM.
     * Recording which workspace a checkout was started for is what attributes
     * the payment later - see billing/attribution.ts. It is deliberately not
     * the whole `SubscriptionOps`: nothing in the console may record a
     * subscription or grant a plan.
     */
    subscriptions: Pick<SubscriptionOps, "recordCheckout">
    successUrl?: string
    planChange?: PlanChange
  }
  log: { error: (o: object, m: string) => void; warn: (o: object, m: string) => void }
}
