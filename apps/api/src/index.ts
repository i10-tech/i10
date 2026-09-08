import { serve } from "@hono/node-server"
import { createClerkClient } from "@clerk/backend"
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
import { loadEnv } from "./env.js"
import { captureError, flushObservability, initObservability } from "./observability.js"
import { createSendQueue } from "./queue/send-queue.js"
import { createWebhookQueue } from "./queue/webhook-queue.js"
import { acceptDatabaseOps } from "./send/accept-db.js"
import { SESv2Client } from "@aws-sdk/client-sesv2"
import { domainStore } from "./domains/store.js"
import { sesIdentity } from "./domains/identity.js"
import { powerDnsZones } from "./domains/powerdns.js"
import { postgresMeter } from "./metering/service.js"
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

const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY })

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
            log,
          }),
          log,
        },
        // Same two dependencies, no `products` and no `grants`: it can read a
        // checkout and read our row, and there is nothing else it could do.
        checkoutStatus: { polar, subscriptions, log },
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
          identity: sesIdentity(new SESv2Client({ region: env.AWS_REGION })),
          capacity: postgresMeter(db),
          region: env.AWS_REGION,
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
          // ⚠ THE SAME BOX THE WEBHOOK SECRETS USE. Without a key there is
          // nowhere safe to keep a DKIM private key, so the routes answer 501
          // rather than storing one in the clear — the same rule webhooks
          // already follow.
          secrets,
        }),
      }
    : {}),
  ...(secrets && webhookQueue
    ? {
        webhookEndpoints: webhookEndpointStore(db, secrets),
        sesWebhooks: {
          events: webhookEventOps({ db, queue: webhookQueue }),
          log,
        },
      }
    : {}),
  pingDb: async () => {
    await sql`select 1`
  },
  reportError: captureError,
})

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  log.info({ port: info.port, env: env.NODE_ENV }, "i10 api listening")
})

// Kubernetes sends SIGTERM and then waits terminationGracePeriodSeconds before
// SIGKILL. Closing the listener lets in-flight sends finish; without this a
// rolling deploy drops requests that were already accepted.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    log.info({ signal }, "shutting down")
    server.close(() => {
      // Close the pool after the listener, so in-flight requests can finish
      // their queries rather than failing on a pool that vanished under them.
      void Promise.allSettled([
        sql.end({ timeout: 5 }),
        cache.quit(),
        queueRedis.quit(),
      ])
        // ⚠ FLUSHED BEFORE THE EXIT, AS ON THE BOOT PATH. `captureException`
        // queues and the transport sends on a timer, so a 500 raised in the
        // last seconds before a rolling deploy took the report with it — and
        // the seconds around a deploy are when the interesting ones happen.
        .then(() => flushObservability())
        .finally(() => process.exit(0))
    })
  })
}
