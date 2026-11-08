/**
 * Copies what members sent as a team address into the team's own Sent, then
 * exits.
 *
 * ⚠ THE DESIGN AND ITS REASONS ARE IN `team-inboxes/sent-copy.ts`; this file is
 * only the process around it. A CronJob rather than an interval in the API, for
 * the reason given in sweep.ts: the API runs several replicas, and an interval
 * inside it would run once per replica.
 *
 * ⚠ IT DOES NOTHING WITHOUT STALWART CONFIGURED, AND SAYS SO. A deployment with
 * no `STALWART_URL`, `STALWART_API_TOKEN` or `STALWART_IMPERSONATE_TOKEN` has
 * nowhere to copy to; the run is a no-op that exits cleanly rather than failing
 * every five minutes.
 */
import pino from "pino"
import { assertRlsSubject, createDb } from "./db/client.js"
import { loadEnv } from "./env.js"
import { captureError, initObservability, withMonitor } from "./observability.js"
import { teamMailFor } from "./team-inboxes/wire.js"
import { copyTeamSent } from "./team-inboxes/sent-copy.js"
import { sentCopyStore } from "./team-inboxes/store.js"

const log = pino({ name: "i10-team-sent" })
const env = loadEnv()

initObservability({
  dsn: env.SENTRY_DSN,
  environment: env.SENTRY_ENVIRONMENT,
  service: "team-sent",
  release: process.env.GIT_SHA,
  log,
})

await withMonitor(
  {
    slug: "i10-team-sent",
    // ⚠ THIS MUST BE THE SCHEDULE IN infra/k8s/i10/workloads/team-sent.yaml, for
    // the reason given in sweep.ts.
    schedule: "*/5 * * * *",
    checkinMarginMinutes: 3,
    log,
  },
  async () => {
    const mail = teamMailFor(env)
    if (!mail) {
      log.warn("stalwart is not configured; no team inbox sent mail was copied")
      return
    }

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

    try {
      const result = await copyTeamSent({ store: sentCopyStore(db), mail, log })
      log.info(result, "team inbox sent mail copied")
      // A team or member that failed leaves work undone, which is what the exit
      // code reports; the next pass picks it up again.
      if (result.failed > 0) process.exitCode = 1
    } catch (error) {
      log.error({ err: error }, "team sent copy failed")
      captureError(error)
      process.exitCode = 1
    } finally {
      await sql.end({ timeout: 5 })
    }
  },
)
