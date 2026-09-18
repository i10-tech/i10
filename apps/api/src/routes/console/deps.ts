import type { TenantAuthDeps } from "../../middleware/tenant.js"
import type { ConsoleQueries } from "../../console/queries.js"
import type { MarketingStore } from "../../console/marketing.js"
import type { OnboardingStore } from "../../console/onboarding.js"
import type { UsageStore } from "../../console/usage.js"
import type { DomainStore } from "../../domains/store.js"
import type { KeyCache } from "../../auth/api-key.js"
import type { KeyStore } from "../../auth/store.js"
import type { WebhookEndpointStore } from "../../webhooks/store.js"
import type { DnsInspector } from "../../console/dns.js"
import type { DelegationChecker } from "../../console/delegation.js"
import type { DnsConnectionStore } from "../../dns/connections.js"
import type { DnsOAuth } from "../../dns/oauth.js"
import type { DnsPublisher } from "../../dns/publish.js"
import type { TenantProfileStore } from "../../console/tenant.js"
import type { PolarClient } from "../../billing/polar.js"
import type { PlanChange } from "../../billing/plan-change.js"

export interface ConsoleDeps extends TenantAuthDeps {
  queries: ConsoleQueries
  usage: UsageStore
  onboarding: OnboardingStore
  marketing: MarketingStore
  profile: TenantProfileStore
  /** Optional for the same reason `AppDeps.domains` is — see createApp. */
  domains?: DomainStore
  /**
   * ⚠ THE CACHE IS NOT OPTIONAL IN PRACTICE, EVEN THOUGH THE TYPE ALLOWS IT.
   * Revoking a key is two acts — the row and the Redis entry — and without the
   * second the key keeps working for up to the TTL after the customer was told
   * it was dead. See the delete route.
   */
  keys?: { store: KeyStore; cache?: KeyCache }
  webhooks?: WebhookEndpointStore
  dns?: DnsInspector
  /**
   * Why a delegated domain has not verified yet.
   *
   * ⚠ OPTIONAL, AND ITS ABSENCE HIDES THE PANEL RATHER THAN FAILING THE PAGE.
   * The domain still renders its records and its status; what is lost is the
   * sentence explaining which of four indistinguishable reasons is the live
   * one. Degrading to the old behaviour is correct — that behaviour was
   * uninformative, not broken.
   */
  delegation?: DelegationChecker
  /**
   * Customers' credentials for their own DNS, and the machinery that uses them.
   *
   * ⚠ ALL THREE ARE OPTIONAL TOGETHER, BECAUSE THEY DEPEND ON THE SEALING KEY.
   * Without `WEBHOOK_SECRET_KEY` there is nowhere safe to keep a credential that
   * can rewrite a customer's MX records, so the routes answer 501 rather than
   * storing one in the clear — the same rule `core.domains` and the webhook
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
    successUrl?: string
    planChange?: PlanChange
  }
  log: { error: (o: object, m: string) => void; warn: (o: object, m: string) => void }
}
