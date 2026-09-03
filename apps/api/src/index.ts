import { serve } from "@hono/node-server"
import { createClerkClient } from "@clerk/backend"
import pino from "pino"
import { createApp } from "./app.js"
import { subscriptionOps } from "./billing/db.js"
import { subscriptionGrants } from "./billing/grants.js"
import { polarClient } from "./billing/polar.js"
import { createCacheClient, createQueueClient, redisKeyCache } from "./cache/redis.js"
import { assertRlsSubject, createDb } from "./db/client.js"
import { loadEnv } from "./env.js"
import { createSendQueue } from "./queue/send-queue.js"
import { createWebhookQueue } from "./queue/webhook-queue.js"
import { acceptDatabaseOps } from "./send/accept-db.js"
import { emailLookup } from "./send/lookup.js"
import { autumnClient, autumnMetering } from "./send/autumn.js"
import { resilient, unmetered } from "./send/metering.js"
import { webhookEventOps } from "./webhooks/db.js"
import { secretBox } from "./webhooks/signing.js"
import { webhookEndpointStore } from "./webhooks/store.js"

const log = pino({ name: "i10-api" })
const env = loadEnv()

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
  await sql.end({ timeout: 5 })
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
 * ⚠ THE ONE PLACE THAT DECIDES WHETHER SENDING IS METERED AT ALL, AND IT SAYS
 * SO IN THE BOOT LOG. No key means `unmetered`: everything allowed, nothing
 * counted. That is right for a local checkout and catastrophic to discover in
 * production a month later, so it is a line you can grep for rather than a
 * silent default.
 *
 * `resilient` wraps whichever it is, so a metering outage degrades to
 * "unavailable" — which `shouldSend` turns into a send — instead of refusing a
 * paying customer's password resets.
 */
const metering = resilient(
  env.AUTUMN_SECRET_KEY
    ? autumnMetering({
        baseUrl: env.AUTUMN_URL,
        secretKey: env.AUTUMN_SECRET_KEY,
        featureId: env.AUTUMN_FEATURE_ID,
        freePlanId: env.AUTUMN_FREE_PLAN_ID,
        timeoutMs: env.AUTUMN_TIMEOUT_MS,
        log,
      })
    : unmetered,
  log,
)
log.info(
  { metered: Boolean(env.AUTUMN_SECRET_KEY), feature: env.AUTUMN_FEATURE_ID },
  env.AUTUMN_SECRET_KEY ? "metering via autumn" : "UNMETERED — no AUTUMN_SECRET_KEY",
)

/**
 * ⚠ WEBHOOKS ARE ON OR OFF IN ONE PLACE, AND THE KEY IS WHAT DECIDES. Without
 * `WEBHOOK_SECRET_KEY` there is nowhere safe to keep a customer's signing
 * secret, so the endpoint routes answer 501 and no SES event is ingested —
 * visible, rather than a silent downgrade to unsigned or plaintext.
 */
const secrets = env.WEBHOOK_SECRET_KEY ? secretBox(env.WEBHOOK_SECRET_KEY) : null
// ⚠ `maxAttempts` HERE, NOT ONLY ON THE WORKER'S QUEUE. groupmq resolves the
// budget at `add()` time and stores it on the job, so the ENQUEUING side is
// what decides how many retries a delivery gets. Left to the default, raising
// WEBHOOK_MAX_ATTEMPTS would make groupmq give up before `deliverWebhook`
// considers the attempt final — and the row would sit `pending` forever with
// the endpoint never disabled.
const webhookQueue = secrets
  ? createWebhookQueue({ redis: queueRedis, maxAttempts: env.WEBHOOK_MAX_ATTEMPTS })
  : null

log.info(
  { webhooks: Boolean(secrets) },
  secrets ? "webhooks enabled" : "WEBHOOKS DISABLED — no WEBHOOK_SECRET_KEY",
)

/**
 * Billing: Polar takes the money, Autumn holds the entitlement.
 *
 * ⚠ THE AUTUMN CLIENT IS CONSTRUCTED HERE AND HANDED ONLY TO `subscriptionGrants`.
 * Everything else in this process gets `metering`, which exposes quota and
 * usage and nothing else. That is what keeps "only one code path grants a plan"
 * a fact about the wiring rather than a rule somebody has to remember.
 *
 * ⚠ AND WITHOUT AUTUMN THERE IS NO GRANTING AT ALL, so the receiver answers 503
 * and Polar keeps the event on its retry schedule. Recording subscription rows
 * we cannot turn into entitlements would look like it was working and leave
 * every paying customer on free-tier limits.
 */
const subscriptions = subscriptionOps(db)

const grants = env.AUTUMN_SECRET_KEY
  ? subscriptionGrants({
      subscriptions,
      entitlements: autumnClient({
        baseUrl: env.AUTUMN_URL,
        secretKey: env.AUTUMN_SECRET_KEY,
        featureId: env.AUTUMN_FEATURE_ID,
        freePlanId: env.AUTUMN_FREE_PLAN_ID,
        timeoutMs: env.AUTUMN_TIMEOUT_MS,
        log,
      }),
      log,
    })
  : null

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
  freePlanId: env.AUTUMN_FREE_PLAN_ID,
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
const sendQueues = {
  transactional: createSendQueue({
    redis: queueRedis,
    class: "transactional",
    jobTimeoutMs: env.WORKER_JOB_TIMEOUT_MS,
  }),
  bulk: createSendQueue({
    redis: queueRedis,
    class: "bulk",
    jobTimeoutMs: env.WORKER_JOB_TIMEOUT_MS,
  }),
}

const depthSources = {
  ...sendQueues,
  ...(webhookQueue ? { webhooks: webhookQueue } : {}),
}

const app = createApp({
  apiKeyAuth: {
    verify: (secret) => clerk.apiKeys.verify(secret),
    cache: redisKeyCache(cache),
    ttlSeconds: env.API_KEY_CACHE_TTL_SECONDS,
  },
  clerkWebhooks: {
    db,
    signingSecret: env.CLERK_WEBHOOK_SECRET,
    hostedDomains: env.MAIL_DOMAINS,
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
          log,
        },
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
      ]).finally(() => process.exit(0))
    })
  })
}
