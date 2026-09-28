/**
 * Scores workspaces for abuse risk and acts on the result, then exits (#170).
 *
 * ⚠ HOURLY, AND IT SCORES WHAT CHANGED. Accept, the SES webhook and console
 * sightings mark workspaces dirty; this run scores the dirty set, anything not
 * scored in a day, and anything already elevated or held. A quiet workspace
 * costs one score a day however many there are. See runner.ts.
 *
 * ⚠ A CronJob, NOT AN INTERVAL IN THE WORKER OR THE API, for the reason
 * recheck.ts gives: those scale by replica, and an interval inside them would
 * run once per replica. Two overlapping runs are harmless anyway - each
 * workspace is leased in Redis while it is scored - but `Forbid` in the
 * manifest keeps it to one.
 *
 * ⚠ IT EXITS NON-ZERO WHEN IT SCORED NOTHING IT TRIED TO, the one failure a
 * quiet summary would hide: a broken definer grant or a dead database reads
 * like an hour in which nobody sent anything.
 */
import pino from "pino"
import { createClerkClient } from "@clerk/backend"
import { assertRlsSubject, createDb } from "./db/client.js"
import { loadEnv } from "./env.js"
import {
  captureError,
  captureMessage,
  initObservability,
  withMonitor,
} from "./observability.js"
import { systemSenderFor } from "./auth-email/system.js"
import { createCacheClient, createQueueClient } from "./cache/redis.js"
import { postgresMetering } from "./metering/service.js"
import { createSendQueue } from "./queue/send-queue.js"
import { resilient } from "./send/metering.js"
import { runAll } from "./risk/runner.js"
import { riskSystem, systemTenantIds } from "./risk/wire.js"

const log = pino({ name: "i10-risk-score" })
const env = loadEnv()

initObservability({
  dsn: env.SENTRY_DSN,
  environment: env.SENTRY_ENVIRONMENT,
  service: "risk-score",
  release: process.env.GIT_SHA,
  log,
})

await withMonitor(
  {
    slug: "i10-risk-score",
    // ⚠ THIS MUST BE THE SCHEDULE IN infra/k8s/i10/workloads/risk-score.yaml,
    // for the reason recheck.ts gives: Sentry judges a run missing by this string.
    schedule: "7 * * * *",
    checkinMarginMinutes: 15,
    log,
  },
  async () => {
    const { sql, db } = createDb(env.DATABASE_URL)
    try {
      await assertRlsSubject(sql, log)
    } catch (error) {
      log.fatal({ err: error }, "refusing to start")
      captureError(error, { phase: "boot" })
      await sql.end({ timeout: 5 })
      process.exitCode = 1
      return
    }
    if (!env.RISK_ENABLED) {
      log.warn("RISK_ENABLED is off; nothing scored")
      await sql.end({ timeout: 5 })
      return
    }

    const cache = createCacheClient(env.REDIS_URL)
    cache.on("error", (err: Error) => log.warn({ err }, "risk cache unavailable"))
    const queueRedis = createQueueClient(env.REDIS_URL)
    queueRedis.on("error", (err: Error) => log.error({ err }, "send queue unavailable"))

    try {
      const queue = (cls: "transactional" | "bulk") =>
        createSendQueue({
          redis: queueRedis,
          class: cls,
          jobTimeoutMs: env.WORKER_JOB_TIMEOUT_MS,
          maxAttempts: env.WORKER_MAX_ATTEMPTS,
        })
      // The same sender the API and the re-check use, so a hold email here is
      // the same email, from the same tenant, as one the API would send.
      const sender = await systemSenderFor({
        sql,
        db,
        queues: { transactional: queue("transactional"), bulk: queue("bulk") },
        metering: resilient(
          postgresMetering({
            db,
            featureId: env.METERING_FEATURE_ID,
            freePlanId: env.METERING_FREE_PLAN_ID,
            log,
          }),
          log,
        ),
        from: env.AUTH_EMAIL_FROM,
        tenantSlug: env.AUTH_EMAIL_TENANT_SLUG,
        log,
      })
      const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY })
      const consoleUrl = env.CONSOLE_ORIGINS[0]
      const risk = riskSystem({
        db,
        env,
        clerk,
        redis: cache,
        sender,
        ...(consoleUrl ? { consoleUrl } : {}),
        exempt: await systemTenantIds(db, env.AUTH_EMAIL_TENANT_SLUG),
        alert: (message, level, context) => captureMessage(message, level, context),
        log,
      })
      const model = await risk.labels.model(true).catch(() => null)

      const summary = await runAll({
        ...risk.deps,
        model,
        torRedis: cache,
        ...(env.IPINFO_TOKEN ? { ipinfoToken: env.IPINFO_TOKEN } : {}),
        ...(env.WEBRISK_API_KEY ? { webRiskKey: env.WEBRISK_API_KEY } : {}),
      })
      log.info(
        { ...summary, model: model ? `v${model.version}` : null },
        "risk run complete",
      )

      if (summary.failed > 0) {
        captureError(new Error(`${summary.failed} workspace(s) could not be scored`), {
          phase: "risk-score",
        })
      }
      if (
        summary.candidates > 0 &&
        summary.scored === 0 &&
        summary.locked < summary.candidates
      ) {
        log.error(summary, "scored nothing it tried to")
        process.exitCode = 1
      }
    } catch (error) {
      log.error({ err: error }, "risk run failed")
      captureError(error, { phase: "risk-score" })
      process.exitCode = 1
    } finally {
      await cache.quit().catch(() => {})
      await queueRedis.quit().catch(() => {})
      await sql.end({ timeout: 5 })
    }
  },
)
