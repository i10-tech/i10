import { serve } from "@hono/node-server"
import { createClerkClient } from "@clerk/backend"
import pino from "pino"
import { createApp } from "./app.js"
import { createCacheClient, createQueueClient, redisKeyCache } from "./cache/redis.js"
import { assertRlsSubject, createDb } from "./db/client.js"
import { loadEnv } from "./env.js"
import { createSendQueue } from "./queue/send-queue.js"
import { acceptDatabaseOps } from "./send/accept-db.js"
import { autumnMetering } from "./send/autumn.js"
import { resilient, unmetered } from "./send/metering.js"

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
      // ⚠ ONE QUEUE PER CLASS, BOTH BUILT HERE. Constructing them lazily at the
      // first send would put a Redis connection on the latency path of somebody
      // waiting for a password reset.
      queues: {
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
      },
    }),
    metering,
    log,
  },
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
