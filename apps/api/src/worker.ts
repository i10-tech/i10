import { randomUUID } from "node:crypto"
import { SESv2Client } from "@aws-sdk/client-sesv2"
import { Worker } from "groupmq"
import pino from "pino"
import { createQueueClient } from "./cache/redis.js"
import { assertRlsSubject, createDb } from "./db/client.js"
import { loadEnv } from "./env.js"
import { captureError, flushObservability, initObservability } from "./observability.js"
import {
  createSendQueue,
  reviveSendJob,
  type SendClass,
  type SendJob,
} from "./queue/send-queue.js"
import {
  createWebhookQueue,
  webhookBackoff,
  type WebhookJob,
} from "./queue/webhook-queue.js"
import { postgresMetering } from "./metering/service.js"
import { resilient } from "./send/metering.js"
import { createTransport } from "nodemailer"
import { resolveRoute, type DeliveryRoute } from "./domains/route.js"
import { sesTransport } from "./send/ses.js"
import { domainSendingLookup } from "./send/signing-key.js"
import { stalwartTransport } from "./send/stalwart.js"
import type { Transport } from "./send/transport.js"
import { webhookDeliveryOps } from "./webhooks/db.js"
import { deliverWebhook } from "./webhooks/deliver.js"
import { secretBox } from "./webhooks/signing.js"
import { databaseOps, type ClaimedMessage } from "./worker/db-adapter.js"
import { handleBatch } from "./worker/handle-batch.js"

/**
 * The send worker.
 *
 * ⚠ THE SAME IMAGE AS THE API, RUN WITH A DIFFERENT COMMAND. There is no
 * separate Dockerfile and no extra entry in the build matrix — the deployment
 * runs `node dist/worker.js`, exactly as the migration Job runs
 * `node dist/migrate.js`. It shares the database client, the environment schema
 * and the contracts for free, and the two scale independently because they are
 * separate Deployments rather than separate artifacts.
 *
 * ⚠ ONE WORKER PER CLASS, NOT ONE WORKER OVER BOTH. `transactional` and `bulk`
 * are separate groupmq queues precisely so a bulk run cannot queue in front of
 * a password reset; a single worker draining both would reintroduce exactly the
 * head-of-line blocking the split exists to prevent.
 */

const log = pino({ name: "i10-worker" })
const env = loadEnv()

initObservability({
  dsn: env.SENTRY_DSN,
  environment: env.SENTRY_ENVIRONMENT,
  service: "worker",
  release: process.env.GIT_SHA,
  log,
})

/**
 * ⚠ IDENTIFIES THE CLAIM, AND IT MUST BE UNIQUE PER PROCESS. It is written to
 * `claimed_by`, and `markSent` refuses to record a result for a row it does not
 * still hold — two replicas sharing an id would each accept the other's
 * completions, which is the one way the compare-and-swap can be defeated from
 * inside. The pod name is the natural value; the uuid is the fallback that
 * cannot collide.
 */
const workerId = process.env.HOSTNAME
  ? `${process.env.HOSTNAME}-${process.pid}`
  : randomUUID()

const { sql, db } = createDb(env.DATABASE_URL)

// ⚠ BEFORE ANY WORK, FOR THE SAME REASON THE API DOES IT. Connecting as a role
// that bypasses row level security removes the tenant boundary and everything
// keeps working — no error, no wrong answer, just a worker that can read every
// tenant's mail.
try {
  await assertRlsSubject(sql)
} catch (error) {
  log.fatal({ err: error }, "refusing to start")
  captureError(error, { phase: "boot" })
  await sql.end({ timeout: 5 })
  // Flushed before the exit, or the report dies in the buffer with the process.
  await flushObservability()
  process.exit(1)
}

// ⚠ THE QUEUE CLIENT, NOT THE CACHE ONE, AND THE DIFFERENCE IS THE WHOLE POINT
// OF THERE BEING TWO. `createCacheClient` sets `enableOfflineQueue: false` so a
// command issued while disconnected fails instead of waiting — correct for a
// cache, where a miss costs nothing. This process exists to drain a queue, so
// the same policy means a Redis blip drops queue commands on the floor.
//
// It was the cache client until Sentry caught it on its first day: groupmq
// loads its Lua scripts the moment a Worker is constructed, that raced the
// connection, and every worker restart threw "Stream isn't writeable and
// enableOfflineQueue options is false" out of `startWorker`. The startup race
// was the visible half; the silent half was every transient blip after it.
// index.ts always had this right — see the note on `queueRedis` there.
const queueRedis = createQueueClient(env.REDIS_URL)
queueRedis.on("error", (err: Error) => log.error({ err }, "send queue unavailable"))

const ses = sesTransport({
  client: new SESv2Client({ region: env.AWS_REGION }),
  configurationSetName: env.SES_CONFIGURATION_SET,
})

/**
 * Our own MTA, when it is configured and the keys can be unsealed.
 *
 * ⚠ IT REFUSES RATHER THAN FALLS BACK TO SES, AND THAT IS THE WHOLE POINT OF
 * BUILDING IT THIS WAY. A stub that quietly sent through SES would mean a
 * domain pinned to `direct` — including every free tenant once the plan rule
 * applies — leaving by the route somebody deliberately moved it off, with
 * nothing in the logs saying so and `sent_route` recording `direct` either way.
 * `deferred` keeps the message in the queue with its attempt counted, so
 * nothing is lost and the backlog is what raises the alarm.
 *
 * ⚠ AND IT NEEDS `WEBHOOK_SECRET_KEY` AS MUCH AS IT NEEDS AN SMTP HOST. That is
 * what seals the DKIM private keys; without it they cannot be opened, and a
 * message signed with nothing is one that fails DMARC at the recipient.
 */
function directTransport(): Transport {
  const host = env.STALWART_SUBMISSION_HOST
  const user = env.STALWART_SUBMISSION_USER
  const password = env.STALWART_SUBMISSION_PASSWORD

  if (!host || !user || !password || !env.WEBHOOK_SECRET_KEY) {
    const missing = [
      !host && "STALWART_SUBMISSION_HOST",
      !user && "STALWART_SUBMISSION_USER",
      !password && "STALWART_SUBMISSION_PASSWORD",
      !env.WEBHOOK_SECRET_KEY && "WEBHOOK_SECRET_KEY",
    ].filter(Boolean)

    log.warn({ missing }, "DIRECT ROUTE UNAVAILABLE — messages routed direct will wait")
    return {
      async send() {
        return {
          status: "deferred",
          reason: `direct route not configured: ${missing.join(", ")} missing`,
        }
      },
    }
  }

  return stalwartTransport({
    mailer: createTransport({
      host,
      port: env.STALWART_SUBMISSION_PORT,
      // ⚠ STARTTLS ON 587 RATHER THAN IMPLICIT TLS. `secure: true` would speak
      // TLS from the first byte, which is 465's contract, not 587's — against a
      // submission port that expects STARTTLS it hangs until the socket times
      // out rather than failing with anything that names the cause.
      secure: env.STALWART_SUBMISSION_PORT === 465,
      requireTLS: true,
      auth: { user, pass: password },
      // One connection pool, reused across the batch's concurrency.
      pool: true,
    }),
    // ⚠ THE BOUNCE LABEL COMES BACK ON THE SAME ROW AS THE KEY, because it is
    // per domain — `core.domains.bounce_subdomain` — and it is what the
    // customer actually published. The transport builds the VERP envelope from
    // it; see docs/decisions/mail-routing.md.
    domainSending: domainSendingLookup({
      db,
      secrets: secretBox(env.WEBHOOK_SECRET_KEY),
    }),
  })
}

// ⚠ BOTH ARE BUILT AT STARTUP, NOT PER MESSAGE. A transport owns a client and a
// connection pool; constructing one inside the send path would open a socket per
// message and make the route decision expensive enough to matter.
const transports: Record<DeliveryRoute, Transport> = {
  ses,
  direct: directTransport(),
}

// ⚠ RESOLVED FROM WHAT THE CLAIM READ, NOT FROM A FRESH LOOKUP. The override and
// the plan came back on the statement that won the row, so this is pure — and
// the same rule the dashboard and Stalwart read. See domains/route.ts.
const routeFor = (message: ClaimedMessage): DeliveryRoute =>
  resolveRoute({
    override: message.routeOverride ?? "auto",
    planId: message.planId,
    freePlanId: env.METERING_FREE_PLAN_ID,
    sesEnabled: env.SES_ENABLED,
  })

// ⚠ THE WORKER METERS TOO, AND ITS HALF IS THE ONE THAT BILLS. The API checks
// quota; this records what actually went — and it writes to the same
// `core.meter_events` the API reads, on the same connection pool, so there is
// no longer a second system that can be configured differently in the two
// processes.
//
// `resilient` is what makes a billing failure unable to fail a send: the mail
// has already gone, and throwing here would return the row to the queue and
// send it twice to fix a billing record.
const metering = resilient(
  postgresMetering({ db, featureId: env.METERING_FEATURE_ID, log }),
  log,
)
log.info({ feature: env.METERING_FEATURE_ID }, "metering via postgres")

const ops = databaseOps({
  db,
  workerId,
  staleAfter: env.WORKER_CLAIM_STALE_AFTER,
})

function startWorker(cls: SendClass) {
  const queue = createSendQueue({
    redis: queueRedis,
    class: cls,
    jobTimeoutMs: env.WORKER_JOB_TIMEOUT_MS,
    maxAttempts: env.WORKER_MAX_ATTEMPTS,
  })

  const worker = new Worker<SendJob>({
    queue,
    name: `${workerId}:${cls}`,
    handler: (job) =>
      handleBatch<ClaimedMessage>(reviveSendJob(job.data), {
        ...ops,
        route: routeFor,
        transportFor: (route) => transports[route],
        metering,
        log,
        // A message whose outcome could not be written down is our failure, not
        // a provider's, and it leaves a row in `sending` that the mail may
        // already have left. It was silently discarded before this.
        reportError: captureError,
        concurrency: env.WORKER_CONCURRENCY,
      }),
    // ⚠ BATCHES AT ONCE, NOT MESSAGES AT ONCE — TWO DIFFERENT NUMBERS THAT BOTH
    // WANT TO BE CALLED CONCURRENCY. `WORKER_CONCURRENCY` above is the fan-out
    // INSIDE one batch; this is how many batches this worker will hold at the
    // same time, and groupmq defaults it to 1.
    //
    // ⚠ AND LEAVING IT AT 1 REINTRODUCES THE BLOCKING THE QUEUE SPLIT EXISTS TO
    // PREVENT. groupmq already serialises per group, so one batch at a time
    // across ALL groups means tenant B's password reset waits behind the whole
    // of tenant A's batch — head-of-line blocking between tenants, which no
    // amount of per-group ordering was ever meant to allow. The webhook worker
    // below always set this; the send workers never did.
    //
    // ⚠ IT IS DELIBERATELY NOT `WORKER_CONCURRENCY`. What SES sees is
    // replicas × batches in flight × the fan-out inside each, so reusing that
    // number here would square the account's send rate without anything saying
    // so. Small, and raised only alongside the SES quota.
    concurrency: env.WORKER_BATCH_CONCURRENCY,
    // ⚠ THE HANDLER OWNS RETRIES, NOT groupmq. A message that failed is already
    // back in `queued` with its attempt counted, and the row is the record. If
    // groupmq also retried the JOB, the same batch would be re-claimed and the
    // two retry schedules would compound — so the job's own attempts exist only
    // for the case where the handler itself throws.
    //
    // ⚠ THE SAME VALUE AS THE QUEUE ABOVE, AND IT HAS TO COME FROM ONE PLACE.
    // groupmq checks the Worker's budget first (`handleJobFailure`) and
    // `retry.lua` enforces the job's stamped one as a ceiling, so two different
    // numbers give an effective budget equal to the smaller — which was 3
    // against the API's 5, stated nowhere.
    maxAttempts: env.WORKER_MAX_ATTEMPTS,
    // ⚠ REPORTED, UNLIKE THE WEBHOOK WORKER'S — see the note there. The handler
    // already puts a failed message back in `queued` with its attempt counted,
    // so reaching here means the handler ITSELF threw, which is our bug rather
    // than a provider being slow.
    onError: (err, job) => {
      log.error({ err, jobId: job?.id, cls }, "send job failed")
      captureError(err, { jobId: job?.id, cls })
    },
  })

  worker.run()
  log.info({ cls, workerId, concurrency: env.WORKER_CONCURRENCY }, "worker started")
  return worker
}

/**
 * The webhook delivery worker.
 *
 * ⚠ THE SAME PROCESS AS THE SEND WORKER, AND A DIFFERENT QUEUE. Both are
 * I/O-bound waits on somebody else's server, so a second Deployment would cost
 * a pod to save nothing — and one process means one place where a slow
 * shutdown, a Redis reconnect or a database pool problem has to be got right.
 *
 * ⚠ AND IT IS ABSENT RATHER THAN BROKEN WHEN THERE IS NO KEY. Without
 * `WEBHOOK_SECRET_KEY` the stored secrets cannot be decrypted, so there is
 * nothing to sign with — starting a worker that would fail every delivery
 * would fill the failure counters and disable every customer's endpoint.
 */
function startWebhookWorker() {
  if (!env.WEBHOOK_SECRET_KEY) {
    log.warn({}, "WEBHOOK DELIVERY DISABLED — no WEBHOOK_SECRET_KEY")
    return null
  }

  const secrets = secretBox(env.WEBHOOK_SECRET_KEY)
  const queue = createWebhookQueue({
    redis: queueRedis,
    maxAttempts: env.WEBHOOK_MAX_ATTEMPTS,
  })
  const ops = webhookDeliveryOps({ db, secrets })

  const worker = new Worker<WebhookJob>({
    queue,
    name: `${workerId}:webhooks`,
    handler: (job) =>
      deliverWebhook(job.data, {
        ...ops,
        log,
        maxAttempts: env.WEBHOOK_MAX_ATTEMPTS,
      }),
    maxAttempts: env.WEBHOOK_MAX_ATTEMPTS,
    // ⚠ HOW MANY ENDPOINTS ARE IN FLIGHT AT ONCE, NOT HOW MANY EVENTS PER
    // ENDPOINT. groupmq runs one job per group, so this is a count of distinct
    // customer endpoints being POSTed to concurrently — every one of them a
    // ten-second wait on somebody else's server, which is why it is worth
    // being higher than the send worker's.
    concurrency: env.WEBHOOK_CONCURRENCY,
    // ⚠ ON THE WORKER, NOT THE QUEUE — groupmq ignores it on the latter. See
    // queue/webhook-queue.ts.
    backoff: webhookBackoff,
    // Deliberately quiet: a customer's endpoint being down is their operational
    // problem, recorded on the delivery row, and logging it as an error here
    // would drown the log in other people's outages.
    //
    // ⚠ AND NOT REPORTED TO SENTRY EITHER, FOR THE SAME REASON RATHER THAN BY
    // OVERSIGHT. Every customer whose endpoint has a bad afternoon would raise
    // an issue against us, spend the quota, and bury the failures that are
    // actually ours. The delivery row is where this belongs.
    onError: (err, job) =>
      log.warn({ err, jobId: job?.id }, "webhook delivery job failed"),
  })

  worker.run()
  log.info({}, "webhook worker started")
  return worker
}

const workers = [
  ...(["transactional", "bulk"] as const).map(startWorker),
  startWebhookWorker(),
].filter((w) => w !== null)

/**
 * ⚠ STOP TAKING WORK, THEN LET WHAT IS IN FLIGHT FINISH. Kubernetes sends
 * SIGTERM and waits `terminationGracePeriodSeconds` before SIGKILL. A worker
 * killed mid-send leaves rows in `sending` that nothing releases until the
 * stale-claim timeout — mail that is late by minutes rather than seconds, and
 * a duplicate if the provider had in fact accepted it. Closing cleanly is what
 * keeps an ordinary deploy from generating both.
 */
/**
 * ⚠ AND groupmq's OWN DEFAULT IS 30 SECONDS, WHICH SILENTLY DEFEATED ALL OF THE
 * ABOVE. `close()` with no argument waits `gracefulTimeoutMs = 30_000`, then
 * logs a warning, emits `graceful-timeout` and abandons whatever is still in
 * flight — so a batch running at the thirty-second mark produced exactly the
 * stranded `sending` rows the ninety-second grace period in worker.yaml was
 * chosen to prevent. The manifest was right and unused.
 *
 * Sixty seconds leaves the pod thirty of its ninety to close the pool, quit
 * Redis and flush Sentry, and stays under the 120-second job timeout so a batch
 * that outlives even this is one Redis will hand to another worker anyway.
 */
const CLOSE_TIMEOUT_MS = 60_000

let shuttingDown = false
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return
    shuttingDown = true
    log.info({ signal }, "shutting down")

    void Promise.allSettled(workers.map((w) => w.close(CLOSE_TIMEOUT_MS)))
      .then(() => Promise.allSettled([sql.end({ timeout: 10 }), queueRedis.quit()]))
      // ⚠ FLUSHED BEFORE THE EXIT, AS ON THE BOOT PATH. `captureException`
      // queues and the transport sends on a timer, so an error raised in the
      // last seconds before a rolling deploy — which is a common moment for one
      // — died in the buffer with the process. The boot path always got this
      // right; the shutdown path never did.
      .then(() => flushObservability())
      .finally(() => process.exit(0))
  })
}
