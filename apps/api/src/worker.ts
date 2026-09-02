import { randomUUID } from "node:crypto"
import { SESv2Client } from "@aws-sdk/client-sesv2"
import { Worker } from "groupmq"
import pino from "pino"
import { createCacheClient } from "./cache/redis.js"
import { assertRlsSubject, createDb } from "./db/client.js"
import { loadEnv } from "./env.js"
import { createSendQueue, type SendClass, type SendJob } from "./queue/send-queue.js"
import { resilient, unmetered } from "./send/metering.js"
import { sesTransport } from "./send/ses.js"
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

// ⚠ `unmetered` UNTIL AUTUMN IS WIRED, AND VISIBLY SO. Passing a real Metering
// is a one-line change here; leaving it out is a stub with a name rather than a
// silently absent call at the send site. `resilient` wraps whatever it is so a
// billing failure can never fail a send.
const metering = resilient(unmetered, log)

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

const workers = (["transactional", "bulk"] as const).map(startWorker)

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
