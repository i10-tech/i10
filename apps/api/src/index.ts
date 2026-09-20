import { createClerkClient } from "@clerk/backend"
import { createHmac } from "node:crypto"
import pino from "pino"
import { createApp } from "./app.js"
import { subscriptionOps } from "./billing/db.js"
import { subscriptionGrants } from "./billing/grants.js"
import { planChange } from "./billing/plan-change.js"
import { polarClient } from "./billing/polar.js"
import { tenantStore } from "./tenants/db.js"
import { tenantProvisioning } from "./tenants/provision.js"
import { createCacheClient, createQueueClient, redisKeyCache } from "./cache/redis.js"
import { keyLookup, keyStore } from "./auth/store.js"
import { assertRlsSubject, createDb } from "./db/client.js"
import { publishRoutingSettings } from "./domains/routing-settings.js"
import { loadEnv } from "./env.js"
import { captureError, flushObservability, initObservability } from "./observability.js"
import { createSendQueue } from "./queue/send-queue.js"
import { createWebhookQueue } from "./queue/webhook-queue.js"
import { acceptDatabaseOps } from "./send/accept-db.js"
import { SESv2Client } from "@aws-sdk/client-sesv2"
import { domainStore } from "./domains/store.js"
import { mailboxProvisioning } from "./mailboxes/provision.js"
import { mailboxDirectory } from "./mailboxes/store.js"
import { clerkIdentity } from "./mailboxes/clerk.js"
import { clerkActiveOrg, clerkFreshAuth, clerkSessions } from "./middleware/session.js"
import { consoleQueries } from "./console/queries.js"
import { dnsInspector } from "./console/dns.js"
import { delegationChecker } from "./console/delegation.js"
import { dnsConnectionStore } from "./dns/connections.js"
import { dnsOAuth } from "./dns/oauth.js"
import { dnsPublisher } from "./dns/publish.js"
import { credentialRenewal } from "./dns/renew.js"
import { marketingStore } from "./console/marketing.js"
import { onboardingStore } from "./console/onboarding.js"
import { tenantProfileStore } from "./console/tenant.js"
import { usageStore } from "./console/usage.js"
import { tenantResolver } from "./middleware/tenant.js"
import { projectClerkUser } from "./projection/writer.js"
import { MAILBOXES } from "./metering/levels.js"
import { offlineIdentity, sesIdentity } from "./domains/identity.js"
import { powerDnsZones } from "./domains/powerdns.js"
import { postgresMeter } from "./metering/service.js"
import { authEmailDelivery } from "./auth-email/deliver.js"
import { authEmailSender } from "./auth-email/sender.js"
import { emailLookup } from "./send/lookup.js"
import { resilient } from "./send/metering.js"
import { postgresEntitlements, postgresMetering } from "./metering/service.js"
import { webhookEventOps } from "./webhooks/db.js"
import { secretBox } from "./webhooks/signing.js"
import { webhookEndpointStore } from "./webhooks/store.js"

const log = pino({ name: "i10-api" })
const env = loadEnv()

// ⚠ BEFORE THE DATABASE, THE CLERK CLIENT AND EVERY OTHER DEPENDENCY, so that
// the boot failures below are the first things it can report. A pod that dies
// during startup is the one failure nobody is watching a dashboard for.
initObservability({
  dsn: env.SENTRY_DSN,
  environment: env.SENTRY_ENVIRONMENT,
  service: "api",
  // Read straight from the environment, the same way /version does — it is
  // baked into the image at build time rather than validated as configuration.
  release: process.env.GIT_SHA,
  log,
})

const { sql, db } = createDb(env.DATABASE_URL)

// ⚠ BEFORE THE LISTENER, NOT AFTER, AND NOT IN A HEALTH CHECK. Connecting as a
// role that bypasses row level security is the one misconfiguration in this
// service that produces no error and no wrong answer — it removes the tenant
// boundary and everything keeps working. Checked here, it fails the rollout
// while the previous pod is still serving.
try {
  await assertRlsSubject(sql)
} catch (error) {
  log.fatal({ err: error }, "refusing to start")
  captureError(error, { phase: "boot" })
  await sql.end({ timeout: 5 })
  // ⚠ FLUSHED BEFORE THE EXIT, or the report dies in the buffer with the
  // process. A crashlooping pod is the case where this matters most and the
  // one where there is no later chance to send it.
  await flushObservability()
  process.exit(1)
}

// ⚠ AFTER THE RLS ASSERTION, BEFORE ANYTHING SERVES. This publishes
// `SES_ENABLED` and `METERING_FREE_PLAN_ID` into `core.routing_settings`, which
// is the only way the mailbox lever — a function Stalwart calls inside Postgres
// — can see them. See domains/routing-settings.ts.
//
// ⚠ AND IT IS NOT FATAL. A failure leaves Stalwart reading the previous deploy's
// values, which are stale rather than nonsense; refusing to boot over a routing
// flag would turn it into an outage.
try {
  await publishRoutingSettings(db, {
    sesEnabled: env.SES_ENABLED,
    sesRelayEnabled: env.SES_RELAY_ENABLED,
    freePlanId: env.METERING_FREE_PLAN_ID,
  })
} catch (error) {
  log.error(
    { err: error },
    "could not publish routing settings — Stalwart keeps the old ones",
  )
  captureError(error, { phase: "boot" })
}

/*
 * ⚠ THE PUBLISHABLE KEY IS PASSED, AND `authenticateRequest` DOES NOT WORK
 * WITHOUT IT. It is not an optional nicety for a server SDK: Clerk uses it to
 * resolve which instance a session token belongs to, and throws "Publishable
 * key is missing" when it is absent — which the verifier reports as
 * `unavailable`, which every session route renders as "retry shortly". See
 * env.ts.
 */
const clerk = createClerkClient({
  secretKey: env.CLERK_SECRET_KEY,
  ...(env.CLERK_PUBLISHABLE_KEY ? { publishableKey: env.CLERK_PUBLISHABLE_KEY } : {}),
})

/*
 * ⚠ SAID AT STARTUP RATHER THAN DISCOVERED PER REQUEST. Both of these are
 * misconfigurations that present as something else entirely — one as a Clerk
 * outage, one as nothing at all — so the only place they are cheap to notice is
 * the first ten lines of the log after a deploy.
 */
if (!env.CLERK_PUBLISHABLE_KEY) {
  log.error(
    {},
    "CLERK_PUBLISHABLE_KEY is not set — every session-authenticated route " +
      "(/console/*, /mailboxes) will answer 503. Sending is unaffected.",
  )
}

if (env.POLAR_ACCESS_TOKEN && !env.POLAR_SUCCESS_URL) {
  /*
   * ⚠ IT BREAKS TWO THINGS AT ONCE AND LOOKS LIKE NEITHER. `POLAR_SUCCESS_URL`
   * is where the browser lands after paying, AND — because `embed_origin` is
   * derived from its origin — it is the only thing that lets Polar's embedded
   * checkout speak to the page it is embedded in. Without it the modal takes
   * the money and then sits there for ever, having sent no `success` event and
   * offering no working way out. See `withCheckoutId` in billing/polar.ts.
   */
  log.error(
    {},
    "POLAR_SUCCESS_URL is not set — the embedded checkout cannot message the " +
      "console, so a completed payment leaves the customer looking at a modal " +
      "that never closes.",
  )
}

if (env.CONSOLE_ORIGINS.length === 0) {
  // ⚠ THIS ONE FAILS OPEN, WHICH IS WHY IT HAS TO BE SAID OUT LOUD. `azp` is
  // what stops a session token minted for another application on the same Clerk
  // instance from being replayed here; empty means Clerk checks nothing, and
  // nothing about the running system looks different.
  log.error(
    {},
    "CONSOLE_ORIGINS is empty — the Clerk `azp` allowlist is disabled, so a " +
      "token minted for any application on this Clerk instance is accepted.",
  )
}

// ⚠ A SEPARATE CLIENT FROM THE QUEUES'. The queue connection is a dependency —
// a job that cannot be enqueued has not been accepted. This one is a cache, and
// its errors are swallowed. Sharing a client would mean one set of retry and
// offline-queue settings serving two opposite failure policies.
const cache = createCacheClient(env.REDIS_URL)
cache.on("error", (err: Error) => log.warn({ err }, "api key cache unavailable"))

// ⚠ THE QUEUE'S CONNECTION, NOT THE CACHE'S — see cache/redis.ts. An enqueue
// that fails does not fail the request, but it does cost the message a trip
// through the sweep, so this client retries where the cache one gives up.
const queueRedis = createQueueClient(env.REDIS_URL)
queueRedis.on("error", (err: Error) => log.error({ err }, "send queue unavailable"))

/**
 * ⚠ THERE IS NO LONGER AN UNMETERED MODE TO FALL INTO, AND THAT IS THE POINT OF
 * THE SWAP. This used to hinge on a vendor secret key: no key meant every send
 * allowed and nothing counted — right for a local checkout, catastrophic to
 * discover in production a month later, and so a line you could grep for rather
 * than a silent default. Usage now lives in the database the API cannot start
 * without, so the state that needed announcing no longer exists.
 *
 * `resilient` still wraps it. The database can be unreachable too, and the
 * policy has not changed: a metering outage degrades to `unavailable`, which
 * `shouldSend` turns into a send, rather than refusing a paying customer's
 * password resets.
 */
const metering = resilient(
  postgresMetering({ db, featureId: env.METERING_FEATURE_ID, log }),
  log,
)
log.info({ feature: env.METERING_FEATURE_ID }, "metering via postgres")

/*
 * ⚠ SKIPPED IS NOT SILENT. A client id with no secret beside it, or a secret
 * with no id, is somebody half-way through configuring a provider — and the
 * only symptom is one Connect button that quietly does nothing, which nobody
 * discovers until a customer presses it. It is not worth refusing to boot over,
 * which is exactly why it has to be said out loud here instead.
 */
if (env.DNS_OAUTH_IGNORED.length > 0) {
  log.warn(
    { providers: env.DNS_OAUTH_IGNORED },
    "DNS OAuth apps ignored: a client id, secret or scope list is missing or empty",
  )
}

/*
 * ⚠ HALF A BROKER IS SILENT AND IS THE ONE SHAPE THAT LOOKS FINE. Both
 * variables set is a working Cloudflare connection; neither is a direct call,
 * which is correct wherever the egress is not challenged. ONE of them is a
 * Cloudflare exchange that goes on failing with a bot challenge while the
 * deployment believes it has been fixed — and the challenge is invisible until
 * a customer presses Connect. Same reasoning as the ignored apps above.
 */
if (Boolean(env.DNS_OAUTH_BROKER_URL) !== Boolean(env.DNS_OAUTH_BROKER_SECRET)) {
  log.warn(
    { haveUrl: Boolean(env.DNS_OAUTH_BROKER_URL) },
    "DNS OAuth broker ignored: DNS_OAUTH_BROKER_URL and DNS_OAUTH_BROKER_SECRET " +
      "must both be set. Cloudflare's token exchange will be called directly and " +
      "is expected to be challenged from the cluster.",
  )
}

/**
 * ⚠ WEBHOOKS ARE ON OR OFF IN ONE PLACE, AND THE KEY IS WHAT DECIDES. Without
 * `WEBHOOK_SECRET_KEY` there is nowhere safe to keep a customer's signing
 * secret, so the endpoint routes answer 501 and no SES event is ingested —
 * visible, rather than a silent downgrade to unsigned or plaintext.
 */
const secrets = env.WEBHOOK_SECRET_KEY ? secretBox(env.WEBHOOK_SECRET_KEY) : null
// ⚠ `maxAttempts` HERE, NOT ONLY ON THE WORKER'S QUEUE, BECAUSE THE BUDGET HAS
// TWO HALVES. The value stamped on the job at `add()` is enforced as a ceiling
// in `retry.lua`; the Worker's own value is what actually dead-letters. The
// effective budget is the smaller of the two, so both come from
// WEBHOOK_MAX_ATTEMPTS — left to the default here, raising that variable would
// make groupmq give up before `deliverWebhook` considers the attempt final, and
// the row would sit `pending` forever with the endpoint never disabled.
const webhookQueue = secrets
  ? createWebhookQueue({ redis: queueRedis, maxAttempts: env.WEBHOOK_MAX_ATTEMPTS })
  : null

log.info(
  { webhooks: Boolean(secrets) },
  secrets ? "webhooks enabled" : "WEBHOOKS DISABLED — no WEBHOOK_SECRET_KEY",
)

/**
 * Billing: Polar takes the money, `core.plan_assignments` holds the entitlement.
 *
 * ⚠ THE GRANTING OBJECT IS CONSTRUCTED HERE AND HANDED ONLY TO
 * `subscriptionGrants`. Everything else in this process gets `metering`, which
 * exposes quota and usage and nothing else. That is what keeps "only one code
 * path grants a plan" a fact about the wiring rather than a rule somebody has
 * to remember.
 */
const subscriptions = subscriptionOps(db)

/**
 * ⚠ THE ONLY OBJECT IN THIS PROCESS THAT CAN MOVE A CUSTOMER BETWEEN PLANS, and
 * it reaches exactly two places: `subscriptionGrants`, which acts on verified
 * Polar events, and tenant provisioning, which puts a brand-new tenant on the
 * free plan. Nothing else is handed it — everything else gets `metering`, which
 * exposes quota and usage and nothing that could grant anything.
 *
 * ⚠ AND IT IS NO LONGER OPTIONAL, WHICH REMOVES A WHOLE FAILURE MODE. When the
 * entitlement lived in a remote service, its absence meant no granting at all:
 * the Polar receiver answered 503 and every paying customer sat on free-tier
 * limits until somebody noticed. An assignment is a row in our own database;
 * there is nothing left to be absent.
 */
const entitlements = postgresEntitlements({
  db,
  freePlanId: env.METERING_FREE_PLAN_ID,
})

const grants = subscriptionGrants({ subscriptions, entitlements, log })

/**
 * Sign-up: a Clerk organization becomes a tenant, and a user with no
 * organization gets one made for them. See tenants/provision.ts.
 */
const provisioning = tenantProvisioning({
  organizations: {
    membershipCount: async (userId) =>
      (await clerk.users.getOrganizationMembershipList({ userId, limit: 1 }))
        .totalCount,
    create: async ({ name, slug, createdBy }) => {
      await clerk.organizations.createOrganization({ name, slug, createdBy })
    },
  },
  tenants: tenantStore(db),
  entitlements,
  log,
})

const polar = env.POLAR_ACCESS_TOKEN
  ? polarClient({
      accessToken: env.POLAR_ACCESS_TOKEN,
      server: env.POLAR_SERVER,
      timeoutMs: env.POLAR_TIMEOUT_MS,
    })
  : null

const planOptions = {
  planForProduct: (productId: string) =>
    Object.entries(env.POLAR_PRODUCTS).find(([, id]) => id === productId)?.[0],
  freePlanId: env.METERING_FREE_PLAN_ID,
}

log.info(
  {
    server: env.POLAR_SERVER,
    checkout: Boolean(polar),
    events: Boolean(grants && env.POLAR_WEBHOOK_SECRET),
    plans: Object.keys(env.POLAR_PRODUCTS),
  },
  polar && grants && env.POLAR_WEBHOOK_SECRET
    ? "billing wired to polar"
    : "BILLING INCOMPLETE — no paid plan can be sold or granted",
)

/**
 * ⚠ THE SAME QUEUE OBJECTS THE ACCEPT PATH PUSHES TO, NOT NEW ONES. groupmq's
 * Queue is a handle rather than a connection, but two handles on one namespace
 * would be two places to keep the options in step — and an autoscaler reading a
 * queue configured differently from the one being written to is a scaler that
 * measures the wrong thing.
 */
/**
 * ⚠ `maxAttempts` HERE AS WELL AS ON THE WORKER, AND FROM THE SAME VARIABLE.
 * groupmq stamps this side's value on the job and `retry.lua` enforces it as a
 * ceiling, while the Worker's own setting is what actually dead-letters — so
 * two different numbers give an effective budget equal to the smaller of them.
 * This side used to take the queue's fallback of 5 while the worker asked for
 * 3, which meant the real budget was 3 and nothing anywhere said so.
 */
const sendQueues = {
  transactional: createSendQueue({
    redis: queueRedis,
    class: "transactional",
    jobTimeoutMs: env.WORKER_JOB_TIMEOUT_MS,
    maxAttempts: env.WORKER_MAX_ATTEMPTS,
  }),
  bulk: createSendQueue({
    redis: queueRedis,
    class: "bulk",
    jobTimeoutMs: env.WORKER_JOB_TIMEOUT_MS,
    maxAttempts: env.WORKER_MAX_ATTEMPTS,
  }),
}

const depthSources = {
  ...sendQueues,
  ...(webhookQueue ? { webhooks: webhookQueue } : {}),
}

/**
 * i10's own tenant, for the mail i10 sends about itself.
 *
 * ⚠ RESOLVED ONCE AT BOOT AND ALLOWED TO BE ABSENT. A fresh database has no
 * `i10` tenant — migration 0029 inserts one only where it already exists — so
 * this is `null` on a new deployment and authentication mail simply stays with
 * Clerk. Failing to boot over it would make the API refuse to start on exactly
 * the deployments that have no customers to email.
 */
const authEmailTenantId = await (async () => {
  if (!env.AUTH_EMAIL_FROM) return null

  try {
    // ⚠ THROUGH THE DEFINER, NOT `select … from core.tenants`. That table is
    // under RLS and its policy reads `current_setting('app.tenant_id')`
    // strictly, which nothing has set this early — so the direct read did not
    // return zero rows, it RAISED. It cannot be repaired with `withTenant()`
    // either: that needs the tenant id, and the id is what this is looking
    // for. See migration 0032.
    //
    // The postgres client directly rather than drizzle: this is a function
    // call, not a table, and one query at boot does not earn a definition.
    const rows = await sql<{ id: string | null }[]>`
      select core.tenant_id_by_slug(${env.AUTH_EMAIL_TENANT_SLUG})::text as id`

    const id = rows[0]?.id ?? null
    if (!id) {
      log.warn(
        { slug: env.AUTH_EMAIL_TENANT_SLUG },
        "no tenant for auth email — clerk keeps delivering its own",
      )
    }
    return id
  } catch (err) {
    // ⚠ CAUGHT, BECAUSE THE RLS FAULT ABOVE TOOK THE WHOLE API DOWN WITH IT.
    // One question about who signs the verification mail crashlooped the send
    // path, the webhooks and the mailbox projection along with it. However
    // this fails, the right outcome is the one this value already has a name
    // for — no tenant, and Clerk keeps delivering. Loud in the log, not in the
    // exit code.
    log.error(
      { slug: env.AUTH_EMAIL_TENANT_SLUG, err: String(err) },
      "could not resolve the auth email tenant — clerk keeps delivering its own",
    )
    return null
  }
})()

/*
 * Clerk session verification, built ONCE.
 *
 * ⚠ ONE VERIFIER AND ONE ORG READER FOR THE WHOLE PROCESS, BECAUSE THE
 * `authorizedParties` ALLOWLIST IS A SECURITY CONTROL AND IT IS CONFIGURED
 * HERE. `azp` is what stops a token minted for another application on the same
 * Clerk instance from being replayed against this API, and every separate
 * construction is another chance for one of them to be built without it. Three
 * copies of this call used to be spread through the deps object below with a
 * comment claiming they were shared — which is the version of this mistake that
 * survives review, because the sharing was asserted rather than done.
 */
const sessions = clerkSessions(clerk, {
  authorizedParties: env.CONSOLE_ORIGINS,
  log,
})
const activeOrg = clerkActiveOrg(clerk, {
  authorizedParties: env.CONSOLE_ORIGINS,
  log,
})
/**
 * ⚠ THE SAME CLERK CLIENT AND THE SAME ALLOWLIST, DELIBERATELY. This reads the
 * factor ages off the very token `requireTenant` just verified; pointing it at
 * a differently-configured client would let a token be good enough to act and
 * not good enough to check, or the reverse.
 */
const freshAuth = clerkFreshAuth(clerk, {
  authorizedParties: env.CONSOLE_ORIGINS,
  log,
})

const app = createApp({
  apiKeyAuth: {
    // ⚠ OUR OWN TABLE, NOT CLERK. See auth/api-key.ts for why, and note the
    // client above is still built — Clerk remains the identity provider for
    // sessions, organizations and the authd bind delegation. It is only the
    // per-request credential check that stopped crossing the network.
    lookup: keyLookup(db),
    cache: redisKeyCache(cache),
    ttlSeconds: env.API_KEY_CACHE_TTL_SECONDS,
  },
  apiKeys: { store: keyStore(db), cache: redisKeyCache(cache), log },
  clerkWebhooks: {
    db,
    signingSecret: env.CLERK_WEBHOOK_SECRET,
    hostedDomains: env.MAIL_DOMAINS,
    provisioning,
    // ⚠ ONLY WHEN BOTH HALVES EXIST. Without a from-address or i10's tenant we
    // would have nowhere to send from and nothing to attribute it to, and the
    // webhook then acknowledges the event while Clerk keeps sending — which is
    // the state the product is in today, and a safe place to fail to.
    ...(env.AUTH_EMAIL_FROM && authEmailTenantId
      ? {
          authEmail: authEmailDelivery({
            sender: authEmailSender({
              tenantId: authEmailTenantId,
              from: env.AUTH_EMAIL_FROM,
              ops: acceptDatabaseOps({ db, queues: sendQueues }),
              metering,
              log,
            }),
            log,
          }),
        }
      : {}),
    log,
  },
  autoconfig: {
    hostedDomains: env.MAIL_DOMAINS,
    mailHost: env.MAIL_HOSTNAME,
    // ⚠ NOT CONFIGURABLE, BECAUSE THEY ARE NOT OURS TO CHOOSE. These are the
    // two ports claimed with `hostPort` in the Stalwart StatefulSet and named
    // in the SRV records — 993 implicit-TLS IMAP, 465 implicit-TLS submission.
    // An environment variable here would let a profile advertise a port
    // nothing is listening on, and the client's report of that is "cannot
    // connect using SSL", which sends you looking at certificates.
    imapPort: 993,
    smtpPort: 465,
    organization: "i10",
  },
  sendPath: {
    ...acceptDatabaseOps({
      db,
      // ⚠ ONE QUEUE PER CLASS, BOTH BUILT AT BOOT. Constructing them lazily at
      // the first send would put a Redis connection on the latency path of
      // somebody waiting for a password reset.
      queues: sendQueues,
    }),
    metering,
    log,
  },
  emailLookup: emailLookup(db),
  ...(env.METRICS_TOKEN
    ? {
        metrics: {
          token: env.METRICS_TOKEN,
          queueDepth: async () => {
            const counts = await Promise.all(
              Object.entries(depthSources).map(async ([name, queue]) => {
                const c = await queue.getJobCounts()
                return [name, c] as const
              }),
            )

            const pending: Record<string, number> = {}
            const delayed: Record<string, number> = {}
            for (const [name, c] of counts) {
              // ⚠ `waiting + active`, NOT `waiting + delayed`. A send scheduled
              // for next week sits in the delayed set until it is due; counting
              // it would hold replicas up for a week over one email.
              pending[name] = (c.waiting ?? 0) + (c.active ?? 0)
              delayed[name] = c.delayed ?? 0
            }

            return {
              pending,
              delayed,
              total: Object.values(pending).reduce((a, b) => a + b, 0),
            }
          },
        },
      }
    : {}),
  ...(grants && env.POLAR_WEBHOOK_SECRET
    ? {
        polarWebhooks: {
          secret: env.POLAR_WEBHOOK_SECRET,
          grants,
          options: planOptions,
          log,
        },
      }
    : {}),
  ...(polar
    ? {
        billing: {
          polar,
          subscriptions,
          products: env.POLAR_PRODUCTS,
          successUrl: env.POLAR_SUCCESS_URL,
          // ⚠ THE ONLY OBJECT THAT CAN MOVE A PAYING CUSTOMER BETWEEN PRODUCTS,
          // and it is named rather than reached through `polar` so the wiring
          // says so. It grants nothing: the entitlement still moves only when
          // Polar's webhook says the money did.
          planChange: planChange({
            db,
            polar,
            subscriptions,
            products: env.POLAR_PRODUCTS,
            freePlanId: env.METERING_FREE_PLAN_ID,
            log,
          }),
          log,
        },
        /*
         * ⚠ IT NOW HOLDS `grants`, AND THE NOTE THAT USED TO SAY IT DELIBERATELY
         * DID NOT WAS RIGHT UNTIL THE REPAIR PATH EXISTED. Reading a checkout
         * and reading our row is all this endpoint needs for every ordinary
         * poll, and that is still all it does for them.
         *
         * ⚠ WHAT CHANGED IS THE ONE CASE ONLY IT CAN FIX. A checkout carries
         * `metadata.tenant_id`; a subscription does not — so when Polar reuses a
         * customer it did not create, and leaves `external_id` null, THIS is the
         * only place in the system that knows both halves. It writes the id
         * back, and then has to be able to grant what that customer already
         * bought: Polar sends no new event because we patched a customer, so
         * without this the repair would sit until the half-hourly reconciler on
         * a page that gives up after ninety seconds.
         *
         * ⚠ IT STILL GRANTS NOTHING OF ITS OWN. `grants.apply` takes a state
         * derived by `toState` from what Polar says, exactly as the webhook and
         * the reconciler do — the money still decides, and this only removes the
         * wait.
         */
        checkoutStatus: {
          polar,
          subscriptions,
          log,
          grants,
          options: {
            planForProduct: (productId: string) =>
              Object.entries(env.POLAR_PRODUCTS).find(
                ([, id]) => id === productId,
              )?.[0],
            freePlanId: env.METERING_FREE_PLAN_ID,
          },
        },
      }
    : {}),
  /**
   * ⚠ THE ONLY WRITER OF `core.domains` IN THE APPLICATION, which is what makes
   * the plan's domain limit enforceable at all — before this there was nowhere
   * to check it. It is handed the meter rather than the `Metering` seam,
   * because the seam answers about one feature and this asks about another.
   */
  ...(secrets
    ? {
        domains: domainStore({
          db,
          /*
           * ⚠ `SES_ENABLED` GATES THE IDENTITY, NOT JUST THE SENDING. It used to
           * gate only the latter, so a deployment with SES off still called
           * `CreateEmailIdentity` on every domain creation — which on a laptop
           * holding production AWS credentials wrote into the real account. The
           * flag now means what it says. See `offlineIdentity`.
           */
          identity: env.SES_ENABLED
            ? sesIdentity(new SESv2Client({ region: env.AWS_REGION }))
            : offlineIdentity(),
          capacity: postgresMeter(db),
          region: env.AWS_REGION,
          // ⚠ OUR OWN SENDING DOMAINS, so nobody can add one. See the note on
          // `ownDomains`: the delegated path would hand them our return path.
          ownDomains: env.MAIL_DOMAINS,
          dns: {
            spfInclude: env.MAIL_SPF_INCLUDE,
            bounceHost: env.MAIL_BOUNCE_HOST,
            nameservers: env.MAIL_NAMESERVERS,
          },
          // ⚠ THE ZONES LIVE IN OUR OWN POSTGRES, so publishing one is a write
          // in the same transaction as everything else rather than a call to a
          // provider that can be down. Swapping this for Cloudflare or Route 53
          // later is an adapter, not a migration.
          zones: powerDnsZones(db),
          log,
          // ⚠ THE SAME BOX THE WEBHOOK SECRETS USE. Without a key there is
          // nowhere safe to keep a DKIM private key, so the routes answer 501
          // rather than storing one in the clear — the same rule webhooks
          // already follow.
          secrets,
        }),
      }
    : {}),
  /**
   * The human half of i10, and the only routes that take a session.
   *
   * ⚠ WIRED UNCONDITIONALLY, unlike `domains` above, because none of its parts
   * are optional — there is no secret it can be missing. A deployment that
   * cannot reach Clerk fails at the session, which answers 503, rather than at
   * a 501 that would claim mailboxes are not a feature.
   */
  sessionAuth: sessions,

  /**
   * The dashboard, at `/console`.
   *
   * ⚠ IT SHARES `sessionAuth`'s VERIFIER RATHER THAN BUILDING A SECOND ONE —
   * the same `sessions` object, not a second call with the same arguments — so
   * there is exactly one place the `authorizedParties` allowlist is configured.
   * See the two constants above.
   *
   * ⚠ AND EVERY STORE IT IS GIVEN IS ONE THAT ALREADY EXISTS. The console reads
   * through its own query module and writes through `domainStore`, `keyStore`
   * and `webhookEndpointStore` — the objects that own the plan limits and the
   * cache eviction. Handing it a second path to those tables would put the
   * domain limit in two places, and the console is where somebody would notice
   * it was missing last.
   */
  console: {
    sessions,
    tenants: tenantResolver(db),
    activeOrg,
    freshAuth,
    queries: consoleQueries(db),
    usage: usageStore({ db, meter: postgresMeter(db), log }),
    onboarding: onboardingStore(db, env.METERING_FREE_PLAN_ID),
    marketing: marketingStore(db),
    profile: tenantProfileStore(db),
    // ⚠ NO CREDENTIAL AND NO OUTBOUND HTTP BEYOND DNS-OVER-HTTPS TO TWO FIXED
    // HOSTS. See console/dns.ts: it resolves names the customer types, which is
    // a capability anybody already has with `dig`, and it must never become a
    // general-purpose fetcher running inside the cluster.
    dns: dnsInspector(),
    /*
     * ⚠ IT IS GIVEN THE SAME `MAIL_NAMESERVERS` THE RECORDS ARE BUILT FROM, so
     * the check and the instructions cannot disagree. Handing it a second list
     * would let the console tell somebody to publish one set of nameservers and
     * then diagnose against another — which would report a correct delegation
     * as pointed elsewhere.
     */
    delegation: delegationChecker({ nameservers: env.MAIL_NAMESERVERS }),
    /*
     * ⚠ THE WHOLE DNS-CONNECTION FEATURE HANGS OFF THE SEALING KEY, which is
     * why all of it arrives together or not at all. A credential that can
     * rewrite a customer's MX records must not be stored in the clear, so
     * without a box to seal it in the routes answer 501 — the same rule
     * `domains` below follows for a DKIM private key.
     *
     * ⚠ AND THE THREE ARE BUILT ONCE, IN ONE SCOPE, BECAUSE THEY REFER TO EACH
     * OTHER. The publisher renews an expiring OAuth credential through the same
     * `dnsOAuth` the callback used and writes it back through the same store
     * the routes read — so a second `dnsConnectionStore(db, secrets)` here, as
     * there used to be, is a second object claiming to be the same thing.
     */
    ...(secrets
      ? (() => {
          const connections = dnsConnectionStore(db, secrets)
          const oauth = dnsOAuth({
            apps: env.DNS_OAUTH_APPS,
            redirectBase: env.DNS_OAUTH_REDIRECT_BASE,
            /*
             * ⚠ DERIVED FROM THE SEALING KEY RATHER THAN BEING ITS OWN
             * VARIABLE, and domain-separated so it is not the same value. It
             * signs the OAuth `state`, which is what stops somebody attaching
             * their DNS credential to another workspace — a real key, but not
             * one an operator should have to remember to set separately from
             * the key this feature already cannot run without.
             */
            stateSecret: createHmac("sha256", env.WEBHOOK_SECRET_KEY ?? "")
              .update("dns-oauth-state")
              .digest("hex"),
            /*
             * ⚠ BOTH OR NEITHER, DECIDED HERE SO THE MODULE NEVER SEES A HALF
             * ONE. A URL without a secret would call an authenticated Worker
             * with no credential and turn every Cloudflare exchange into a 401
             * — a worse failure than the challenge it was meant to fix, and one
             * that reads like a rejected client secret. See `DNS_OAUTH_BROKER_URL`.
             */
            ...(env.DNS_OAUTH_BROKER_URL && env.DNS_OAUTH_BROKER_SECRET
              ? {
                  broker: {
                    url: env.DNS_OAUTH_BROKER_URL,
                    secret: env.DNS_OAUTH_BROKER_SECRET,
                  },
                }
              : {}),
          })

          return {
            dnsConnections: connections,
            dnsOAuth: oauth,
            dnsPublisher: dnsPublisher({
              connections,
              log,
              /*
               * ⚠ WITHOUT THIS A CONNECTION IS GOOD FOR ONE ACCESS TOKEN AND
               * THEN DEAD. The grant was stored when somebody authorised us and
               * never read again, so the first publish after it expired failed
               * `unauthorized` — and the console told the customer to reconnect,
               * asking them to redo an authorisation that had not lapsed, while
               * the refresh token sat unused in the row.
               */
              renew: credentialRenewal({ oauth, connections, log }),
            }),
          }
        })()
      : {}),
    ...(secrets
      ? {
          domains: domainStore({
            db,
            // ⚠ THE SAME GATE AS THE STORE ABOVE. Two stores, one rule —
            // see the note there for why `SES_ENABLED` has to cover this.
            identity: env.SES_ENABLED
              ? sesIdentity(new SESv2Client({ region: env.AWS_REGION }))
              : offlineIdentity(),
            capacity: postgresMeter(db),
            region: env.AWS_REGION,
            ownDomains: env.MAIL_DOMAINS,
            dns: {
              spfInclude: env.MAIL_SPF_INCLUDE,
              bounceHost: env.MAIL_BOUNCE_HOST,
              nameservers: env.MAIL_NAMESERVERS,
            },
            zones: powerDnsZones(db),
            log,
            secrets,
          }),
        }
      : {}),
    keys: { store: keyStore(db), cache: redisKeyCache(cache) },
    ...(secrets ? { webhooks: webhookEndpointStore(db, secrets) } : {}),
    // ⚠ THE SAME POLAR CLIENT AND THE SAME PRODUCT MAP `/billing` USES, NOT A
    // SECOND ONE. Two maps is two price lists, and the one that is wrong is
    // always the one a customer just bought from.
    ...(polar
      ? {
          billing: {
            polar,
            products: env.POLAR_PRODUCTS,
            successUrl: env.POLAR_SUCCESS_URL,
            planChange: planChange({
              db,
              polar,
              subscriptions,
              products: env.POLAR_PRODUCTS,
              freePlanId: env.METERING_FREE_PLAN_ID,
              log,
            }),
          },
        }
      : {}),
    log,
  },
  mailboxes: mailboxProvisioning({
    identity: clerkIdentity(clerk),
    directory: mailboxDirectory(db),
    capacity: postgresMeter(db),
    // ⚠ THE PROJECTION, NOT A SECOND WRITER. Provisioning changes Clerk and
    // then asks the projection to derive the row, exactly as the webhook does;
    // `MAIL_DOMAINS` is passed for the same reason it is there — i10's own
    // domains are hosted regardless of who owns a `core.domains` row.
    project: async (user) => projectClerkUser(db, user, env.MAIL_DOMAINS),
    featureId: MAILBOXES,
  }),
  ...(secrets && webhookQueue
    ? {
        webhookEndpoints: webhookEndpointStore(db, secrets),
        sesWebhooks: {
          events: webhookEventOps({ db, queue: webhookQueue }),
          log,
        },
        // ⚠ THE SAME OPS, A DIFFERENT INTERPRETER. Both routes write through
        // `ingestEvent`, so the dedupe, the suppression write and the customer
        // payload shape are one implementation rather than two that agree today.
        //
        // ⚠ AND IT IS GATED ON THE SECRET SEPARATELY FROM THE REST. Without
        // `STALWART_WEBHOOK_SECRET` the route answers 503 rather than accepting
        // unsigned notifications — a public endpoint that writes suppressions
        // must never be reachable without a signature, not even in a
        // half-configured environment.
        ...(env.STALWART_WEBHOOK_SECRET
          ? {
              stalwartWebhooks: {
                events: webhookEventOps({ db, queue: webhookQueue }),
                log,
                secret: env.STALWART_WEBHOOK_SECRET,
              },
            }
          : {}),
      }
    : {}),
  pingDb: async () => {
    await sql`select 1`
  },
  reportError: captureError,
})

// ⚠ `Bun.serve`, NOT `@hono/node-server`. The adapter existed to give Node a
// `fetch`-shaped listener; Bun has one natively, so the adapter was a
// dependency that translated our handler into Node's req/res and back again
// for no remaining reason. `app.fetch` is handed straight to the runtime.
const server = Bun.serve({ fetch: app.fetch, port: env.PORT })
log.info({ port: server.port, env: env.NODE_ENV }, "i10 api listening")

// Kubernetes sends SIGTERM and then waits terminationGracePeriodSeconds before
// SIGKILL. Closing the listener lets in-flight sends finish; without this a
// rolling deploy drops requests that were already accepted.
let shuttingDown = false
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    // ⚠ GUARDED, BECAUSE Bun.serve DOES NOT REMOVE THE HANDLER FOR US. A second
    // SIGTERM — which kubelet does send if the first one looks ignored — would
    // otherwise start a second teardown while the first is still draining, and
    // the two races would close the pool out from under in-flight queries.
    if (shuttingDown) return
    shuttingDown = true
    log.info({ signal }, "shutting down")

    // ⚠ `stop()` WITH NO ARGUMENT. It stops accepting new connections and
    // resolves once the ones already in flight have finished — the same
    // contract `server.close(cb)` had. Passing `true` would close active
    // connections immediately, which is precisely the dropped-request
    // behaviour this block exists to prevent.
    void server
      .stop()
      // Close the pool after the listener, so in-flight requests can finish
      // their queries rather than failing on a pool that vanished under them.
      .then(() =>
        Promise.allSettled([sql.end({ timeout: 5 }), cache.quit(), queueRedis.quit()]),
      )
      // ⚠ FLUSHED BEFORE THE EXIT, AS ON THE BOOT PATH. `captureException`
      // queues and the transport sends on a timer, so a 500 raised in the
      // last seconds before a rolling deploy took the report with it — and
      // the seconds around a deploy are when the interesting ones happen.
      .then(() => flushObservability())
      .finally(() => process.exit(0))
  })
}
