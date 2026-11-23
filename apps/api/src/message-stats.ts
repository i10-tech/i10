import "./openapi-first.js"
/**
 * Refreshes the console overview's daily rollup (#507), then exits.
 *
 * One call to `core.refresh_message_daily_stats()`, which recomputes every
 * workspace's day that an event arrived for since the last run, late bounces
 * and complaints included. The function's header in
 * drizzle/20261123164856_message_daily_stats_functions says why it scans by
 * event id and why it can be rerun.
 *
 * ⚠ A MISSED RUN COSTS SPEED, NOT CORRECTNESS. `core.message_stats` counts
 * every day since the last refresh from the events, so a stopped job makes the
 * overview slower day by day and never wrong, except that an event arriving
 * late for a day already rolled up shows only after the next run.
 *
 * ⚠ A CronJob RATHER THAN AN INTERVAL IN THE API, for the reason given in
 * sweep.ts: the API runs several replicas.
 */
import { sql } from "drizzle-orm"
import pino from "pino"
import { assertRlsSubject, createDb } from "./db/client.js"
import { loadEnv } from "./env.js"
import { unlockEnv } from "./crypto/unlock.js"
import { captureError, initObservability, withMonitor } from "./observability.js"

const log = pino({ name: "i10-message-stats" })
const env = loadEnv(await unlockEnv(log))

initObservability({
  dsn: env.SENTRY_DSN,
  environment: env.SENTRY_ENVIRONMENT,
  service: "message-stats",
  release: process.env.GIT_SHA,
  log,
})

await withMonitor(
  {
    slug: "i10-message-stats",
    // ⚠ THIS MUST BE THE SCHEDULE IN infra/k8s/i10/workloads/message-stats.yaml.
    schedule: "*/15 * * * *",
    checkinMarginMinutes: 10,
    log,
  },
  async () => {
    const { sql: client, db } = createDb(env.DATABASE_URL)
    try {
      await assertRlsSubject(client, log)
      const [row] = (await db.execute(
        sql`select cells, pruned, complete_before from core.refresh_message_daily_stats()`,
      )) as unknown as { cells: number; pruned: number; complete_before: string }[]
      log.info(row, "message daily stats refreshed")
    } catch (error) {
      log.error({ err: error }, "message daily stats refresh failed")
      captureError(error)
      process.exitCode = 1
    } finally {
      await client.end({ timeout: 5 })
    }
  },
)
