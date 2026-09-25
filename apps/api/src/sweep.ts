/**
 * Re-enqueues messages the queue has lost track of, then exits.
 *
 * ⚠ THIS CLOSES A GAP THE REST OF THE CODEBASE ALREADY ASSUMED WAS CLOSED. Four
 * files describe a stale-message sweep as the thing that makes a lost enqueue,
 * an abandoned batch or a deferred send "late, but never lost". The SQL function
 * they name has existed since `0002_tenancy.sql` and nothing has ever called it.
 * The ordinary path into it is not exotic: a message SES throttles goes back to
 * `queued` with its claim cleared, the job that carried it completes, and
 * without this pass nothing points at that row ever again.
 *
 * ⚠ A CronJob RATHER THAN AN INTERVAL IN THE WORKER, FOR THE REASON GIVEN IN
 * reconcile.ts. The worker Deployment scales on queue depth, so an interval
 * inside it would run once per replica — every replica reading the same stranded
 * rows and enqueueing the same batches. The claim would make that survivable
 * rather than wrong, but it would be N times the work to reach the same place,
 * and Kubernetes already owns "run this once, on a schedule".
 *
 * ⚠ AND IT IS DELIBERATELY THE DUMBEST THING THAT WORKS. It reads ids, groups
 * them, and enqueues. It does not send, it does not write to `core.messages`,
 * and it holds no lock. Every decision about who actually sends stays where it
 * already was — the compare-and-swap in db/claim.ts — so a row this picks up
 * while a worker genuinely still holds it is refused there and dropped, and a
 * pass that overlaps a worker is a non-event rather than a race.
 */
import pino from "pino"
import { createQueueClient } from "./cache/redis.js"
import { assertRlsSubject, createDb } from "./db/client.js"
import { loadEnv } from "./env.js"
import {
  captureError,
  captureMessage,
  initObservability,
  withMonitor,
} from "./observability.js"
import { createSendQueue, enqueueBatch, type SendClass } from "./queue/send-queue.js"
import {
  planSweep,
  sweepJobId,
  sweepStatement,
  type StrandedRow,
} from "./send/sweep.js"

const log = pino({ name: "i10-sweep" })
const env = loadEnv()

initObservability({
  dsn: env.SENTRY_DSN,
  environment: env.SENTRY_ENVIRONMENT,
  service: "sweep",
  release: process.env.GIT_SHA,
  log,
})

await withMonitor(
  {
    slug: "i10-message-sweep",
    // ⚠ THIS MUST BE THE SCHEDULE IN infra/k8s/i10/workloads/message-sweep.yaml.
    // Sentry decides a run is missing by comparing the clock to this string, so
    // a manifest edited without editing here leaves the job working and the
    // alerting wrong.
    schedule: "*/5 * * * *",
    checkinMarginMinutes: 3,
    log,
  },
  async () => {
    // ⚠ ONE CLOCK FOR THE WHOLE PASS, READ ONCE. It names every job this run
    // enqueues — see `sweepJobId` — so a second call to `Date.now()` partway
    // through would split one pass across two id namespaces and lose the
    // collapse that makes planning a batch twice harmless.
    const runStartedAt = new Date()

    const { sql, db } = createDb(env.DATABASE_URL)

    // The same check the API, the worker and the reconciler make. This job
    // reaches across every tenant, through one narrow SECURITY DEFINER
    // function rather than by holding a role that can see everything — so the
    // role still has to be the one row level security applies to.
    try {
      await assertRlsSubject(sql, log)
    } catch (error) {
      log.fatal({ err: error }, "refusing to start")
      captureError(error, { phase: "boot" })
      await sql.end({ timeout: 5 })
      // An exit code rather than `process.exit`, so the check-in and its flush
      // still run — the same reason reconcile.ts does it this way.
      process.exitCode = 1
      return
    }

    // ⚠ THE QUEUE CLIENT, LIKE THE WORKER'S AND THE API'S. This process exists
    // to enqueue; a command issued during a Redis blip must wait rather than
    // fail, which is the whole difference between the two clients in
    // cache/redis.ts.
    const redis = createQueueClient(env.REDIS_URL)
    redis.on("error", (err: Error) => log.error({ err }, "send queue unavailable"))

    const queues: Record<SendClass, ReturnType<typeof createSendQueue>> = {
      transactional: createSendQueue({
        redis,
        class: "transactional",
        jobTimeoutMs: env.WORKER_JOB_TIMEOUT_MS,
        maxAttempts: env.WORKER_MAX_ATTEMPTS,
      }),
      bulk: createSendQueue({
        redis,
        class: "bulk",
        jobTimeoutMs: env.WORKER_JOB_TIMEOUT_MS,
        maxAttempts: env.WORKER_MAX_ATTEMPTS,
      }),
    }

    try {
      const rows = (await db.execute(
        sweepStatement(
          env.SWEEP_QUEUED_GRACE,
          // ⚠ THE CLAIM'S OWN INTERVAL, NOT A SETTING OF THIS JOB'S. See the
          // note on `sweepStatement`: the two predicates have to agree or the
          // sweep enqueues rows the claim will refuse.
          env.WORKER_CLAIM_STALE_AFTER,
          env.SWEEP_MAX_ROWS,
        ),
      )) as unknown as {
        id: string
        created_at: string | Date
        tenant_id: string
        queue: string
      }[]

      const stranded: StrandedRow[] = rows.map((r) => ({
        id: r.id,
        createdAt: new Date(r.created_at),
        tenantId: r.tenant_id,
        queue: r.queue as SendClass,
      }))

      const batches = planSweep(stranded)

      let enqueued = 0
      let failed = 0
      for (const batch of batches) {
        try {
          await enqueueBatch(queues[batch.class], batch.job, {
            jobId: sweepJobId(runStartedAt, batch.job),
          })
          enqueued += batch.job.messages.length
        } catch (error) {
          // ⚠ ONE BATCH AT A TIME, AND A FAILURE DOES NOT ABANDON THE REST. The
          // rows are still `queued`, so anything missed here is simply found by
          // the next pass — but stopping at the first failure would let one bad
          // tenant hold up every other tenant's recovery indefinitely.
          failed += 1
          log.error(
            { err: error, tenantId: batch.job.tenantId, cls: batch.class },
            "could not re-enqueue a swept batch",
          )
          captureError(error, { tenantId: batch.job.tenantId, cls: batch.class })
        }
      }

      log.info(
        { found: stranded.length, batches: batches.length, enqueued, failed },
        stranded.length === 0 ? "nothing stranded" : "re-enqueued stranded messages",
      )

      // ⚠ REACHING THE CAP IS REPORTED, BECAUSE IT MEANS THE SWEEP IS NO LONGER
      // KEEPING UP. Below it, a pass that finds rows is the mechanism working.
      // At it, there were more stranded messages than one pass can carry, and
      // the next pass starts behind — which is a problem upstream of this job
      // and is not fixed by raising the limit.
      if (stranded.length >= env.SWEEP_MAX_ROWS) {
        captureMessage(
          `the message sweep hit its cap of ${env.SWEEP_MAX_ROWS} rows; ` +
            "messages are being stranded faster than they are being recovered",
          "warning",
          { found: stranded.length, batches: batches.length },
        )
      }

      // A batch that could not be enqueued is the one failure this job can have
      // that leaves work undone, so it is what the exit code reports.
      if (failed > 0) process.exitCode = 1
    } catch (error) {
      log.error({ err: error }, "sweep failed")
      captureError(error)
      process.exitCode = 1
    } finally {
      await Promise.allSettled([sql.end({ timeout: 5 }), redis.quit()])
    }
  },
)
