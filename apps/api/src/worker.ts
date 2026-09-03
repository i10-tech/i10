import { randomUUID } from "node:crypto"
import { SESv2Client } from "@aws-sdk/client-sesv2"
import { Worker } from "groupmq"
import pino from "pino"
import { createCacheClient } from "./cache/redis.js"
import { assertRlsSubject, createDb } from "./db/client.js"
import { loadEnv } from "./env.js"
import { createSendQueue, type SendClass, type SendJob } from "./queue/send-queue.js"
import {
  createWebhookQueue,
  webhookBackoff,
  type WebhookJob,
} from "./queue/webhook-queue.js"
import { autumnMetering } from "./send/autumn.js"
import { resilient, unmetered } from "./send/metering.js"
import { sesTransport } from "./send/ses.js"
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
  await sql.end({ timeout: 5 })
  process.exit(1)
}

const redis = createCacheClient(env.REDIS_URL)
redis.on("error", (err: Error) => log.error({ err }, "redis error"))

const transport = sesTransport({
  client: new SESv2Client({ region: env.AWS_REGION }),
  configurationSetName: env.SES_CONFIGURATION_SET,
})

// ⚠ THE WORKER METERS TOO, AND ITS HALF IS THE ONE THAT BILLS. The API checks
// quota; this records what actually went. No key means `unmetered` — allowed,
// uncounted — which is right locally and must be visible in the boot log rather
// than inferred from an invoice.
//
// `resilient` is what makes a billing failure unable to fail a send: the mail
// has already gone, and throwing here would return the row to the queue and
// send it twice to fix a billing record.
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
  { metered: Boolean(env.AUTUMN_SECRET_KEY) },
  env.AUTUMN_SECRET_KEY ? "metering via autumn" : "UNMETERED — no AUTUMN_SECRET_KEY",
)

const ops = databaseOps({
  db,
  workerId,
  staleAfter: env.WORKER_CLAIM_STALE_AFTER,
})

function startWorker(cls: SendClass) {
  const queue = createSendQueue({
    redis,
    class: cls,
    jobTimeoutMs: env.WORKER_JOB_TIMEOUT_MS,
  })

  const worker = new Worker<SendJob>({
    queue,
    name: `${workerId}:${cls}`,
    handler: (job) =>
      handleBatch<ClaimedMessage>(job.data, {
        ...ops,
        transport,
        metering,
        log,
        concurrency: env.WORKER_CONCURRENCY,
      }),
    // ⚠ THE HANDLER OWNS RETRIES, NOT groupmq. A message that failed is already
    // back in `queued` with its attempt counted, and the row is the record. If
    // groupmq also retried the JOB, the same batch would be re-claimed and the
    // two retry schedules would compound — so the job's own attempts exist only
    // for the case where the handler itself throws.
    maxAttempts: 3,
    onError: (err, job) => log.error({ err, jobId: job?.id, cls }, "send job failed"),
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
    redis,
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
let shuttingDown = false
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return
    shuttingDown = true
    log.info({ signal }, "shutting down")

    void Promise.allSettled(workers.map((w) => w.close()))
      .then(() => Promise.allSettled([sql.end({ timeout: 10 }), redis.quit()]))
      .finally(() => process.exit(0))
  })
}
