import { createClerkClient } from "@clerk/backend"
import type pino from "pino"
import { systemSenderFor } from "../auth-email/system.js"
import { createCacheClient, createQueueClient } from "../cache/redis.js"
import type { Database } from "../db/client.js"
import type { Env } from "../env.js"
import { postgresMetering } from "../metering/service.js"
import { captureMessage } from "../observability.js"
import { createSendQueue } from "../queue/send-queue.js"
import { resilient } from "../send/metering.js"
import { riskSystem, systemTenantIds } from "./wire.js"

/**
 * The risk engine with everything it needs to ACT, for a job process: Redis,
 * the system sender (for hold emails), Clerk and the switches (#170).
 *
 * ⚠ ONE CONSTRUCTION FOR BOTH JOBS THAT SCORE. The hourly risk run scores its
 * candidates; the content-store job re-scores a cluster when the farm
 * tripwire fires (#171). A hold placed by one must be the same hold, sent
 * from the same tenant, as one placed by the other - so neither builds its own.
 */
export async function riskRuntime({
  env,
  db,
  sql,
  log,
}: {
  env: Env
  db: Database
  sql: Parameters<typeof systemSenderFor>[0]["sql"]
  log: pino.Logger
}) {
  const cache = createCacheClient(env.REDIS_URL)
  cache.on("error", (err: Error) => log.warn({ err }, "risk cache unavailable"))
  const queueRedis = createQueueClient(env.REDIS_URL)
  queueRedis.on("error", (err: Error) => log.error({ err }, "send queue unavailable"))

  const queue = (cls: "transactional" | "bulk") =>
    createSendQueue({
      redis: queueRedis,
      class: cls,
      jobTimeoutMs: env.WORKER_JOB_TIMEOUT_MS,
      maxAttempts: env.WORKER_MAX_ATTEMPTS,
    })
  // The same sender the API and the re-check use, so a hold email here is the
  // same email, from the same tenant, as one the API would send.
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

  return {
    risk,
    cache,
    async close() {
      await cache.quit().catch(() => {})
      await queueRedis.quit().catch(() => {})
    },
  }
}
