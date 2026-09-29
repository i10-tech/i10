/**
 * Moves finished messages' attachments to R2, then exits (#136, #168, #188).
 *
 * ⚠ EVERY FIVE MINUTES, SO FILES WAIT IN POSTGRES MINUTES, NOT HOURS. Accept
 * keeps writing them inline - nothing touches object storage before the 202 -
 * and this is the "process later" half of #188.
 *
 * ⚠ A CronJob, NOT AN INTERVAL IN THE WORKER, for the reason sweep.ts gives:
 * the worker scales by replica. Two overlapping runs would be harmless anyway
 * (every rewrite is guarded on the original), and `Forbid` keeps it to one.
 *
 * ⚠ UNCONFIGURED IS A NO-OP, NOT A FAILURE. Without the four CONTENT_STORE_*
 * settings attachments simply stay inline, which is how the product worked
 * before this existed.
 */
import { sql } from "drizzle-orm"
import pino from "pino"
import { storeAttachments } from "./content/attachments.js"
import { objectStoreFrom } from "./content/object-store.js"
import { assertRlsSubject, createDb } from "./db/client.js"
import { loadEnv } from "./env.js"
import { captureError, initObservability, withMonitor } from "./observability.js"

const log = pino({ name: "i10-content-store" })
const env = loadEnv()

initObservability({
  dsn: env.SENTRY_DSN,
  environment: env.SENTRY_ENVIRONMENT,
  service: "content-store",
  release: process.env.GIT_SHA,
  log,
})

await withMonitor(
  {
    slug: "i10-content-store",
    // ⚠ THIS MUST BE THE SCHEDULE IN infra/k8s/i10/workloads/content-store.yaml.
    schedule: "*/5 * * * *",
    checkinMarginMinutes: 3,
    log,
  },
  async () => {
    const store = objectStoreFrom(env)
    if (!store) {
      log.warn("CONTENT_STORE_* is not set; attachments stay in Postgres")
      return
    }
    const { sql: client, db } = createDb(env.DATABASE_URL)
    try {
      await assertRlsSubject(client, log)
      const due = (await db.execute(
        // Workspaces, never content: see 0076.
        sql`select tenant_id from core.content_store_due(500)`,
      )) as unknown as { tenant_id: string }[]

      const total = {
        tenants: due.length,
        moved: 0,
        uploaded: 0,
        reused: 0,
        bytes: 0,
        errors: 0,
      }
      let failed = 0
      for (const { tenant_id: tenantId } of due) {
        try {
          const r = await storeAttachments(tenantId, {
            db,
            store,
            limit: env.CONTENT_STORE_BATCH,
            log,
          })
          total.moved += r.moved
          total.uploaded += r.uploaded
          total.reused += r.reused
          total.bytes += r.bytes
          total.errors += r.errors
        } catch (error) {
          failed++
          log.error({ err: error, tenantId }, "content store pass failed")
        }
      }
      log.info({ ...total, failed }, "content store pass complete")
      // ⚠ NON-ZERO WHEN NOTHING THAT WAS TRIED WORKED: a dead bucket or a revoked
      // token reads, otherwise, like five quiet minutes.
      const tried = total.moved + total.errors
      if (
        (due.length > 0 && failed === due.length) ||
        (tried > 0 && total.moved === 0)
      ) {
        process.exitCode = 1
      }
    } catch (error) {
      log.fatal({ err: error }, "content store pass could not run")
      captureError(error, { phase: "run" })
      process.exitCode = 1
    } finally {
      await client.end({ timeout: 5 })
    }
  },
)
