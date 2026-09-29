/**
 * Enforces retention and frees what it leaves behind, then exits
 * (docs/decisions/storage.md).
 *
 * One run, in this order:
 *   1. Keeps a year of monthly partitions ahead, locked down like 0064's.
 *   2. Deletes every workspace's mail older than its plan keeps it: row, body,
 *      events, webhook deliveries - leaving a tombstone per message.
 *   3. Sweeps templates no body uses that have gone stale, and R2 objects and
 *      body packs (#188) no body names. Step 2 is what makes them unreferenced.
 *   4. Prunes tombstones older than 90 days and drops EMPTY expired partitions.
 *
 * ⚠ HOURLY. Retention is measured in days; an hour late is within any
 * promise, and a Free plan's three days is still three days and an hour at
 * worst.
 *
 * ⚠ BILLING IS NEVER TOUCHED. Usage lives in `core.meter_events`, which this
 * does not delete from, and every period is clamped to at least
 * `RECONCILE_LOOKBACK_DAYS + 1` so the reconcile never counts a hole.
 */
import { sql } from "drizzle-orm"
import pino from "pino"
import { sweepObjects } from "./content/attachments.js"
import { objectStoreFrom, templateAssetsBucketFrom } from "./content/object-store.js"
import { templateAssetStore } from "./templates/assets.js"
import { sweepPacks } from "./content/packs.js"
import { sweepTemplates } from "./content/sweep.js"
import { assertRlsSubject, createDb } from "./db/client.js"
import { loadEnv } from "./env.js"
import {
  captureError,
  captureMessage,
  initObservability,
  withMonitor,
} from "./observability.js"
import { expireTenant } from "./retention/expire.js"

/** How long a tombstone keeps a late complaint suppressible. */
const TOMBSTONE_KEEP = "90 days"

const log = pino({ name: "i10-retention" })
const env = loadEnv()

initObservability({
  dsn: env.SENTRY_DSN,
  environment: env.SENTRY_ENVIRONMENT,
  service: "retention",
  release: process.env.GIT_SHA,
  log,
})

await withMonitor(
  {
    slug: "i10-retention",
    // ⚠ THIS MUST BE THE SCHEDULE IN infra/k8s/i10/workloads/retention.yaml.
    schedule: "23 * * * *",
    checkinMarginMinutes: 15,
    log,
  },
  async () => {
    const { sql: client, db } = createDb(env.DATABASE_URL)
    const store = objectStoreFrom(env)
    const floor = env.RECONCILE_LOOKBACK_DAYS + 1
    const summary = {
      partitionsCreated: 0,
      tenants: 0,
      messages: 0,
      unsent: 0,
      bodies: 0,
      events: 0,
      deliveries: 0,
      templates: 0,
      objects: 0,
      packs: 0,
      templateImages: 0,
      tombstonesPruned: 0,
      partitionsDropped: [] as string[],
      partitionsRefused: [] as string[],
      failed: 0,
    }
    try {
      await assertRlsSubject(client, log)

      // ── 1. Partitions ahead ──
      const [created] = (await db.execute(
        sql`select core.ensure_message_partitions(12) as n`,
      )) as unknown as { n: number }[]
      summary.partitionsCreated = Number(created?.n ?? 0)

      // ── 2. Expire ──
      const due = (await db.execute(
        sql`select tenant_id, retention_days from core.retention_due(${floor})`,
      )) as unknown as { tenant_id: string; retention_days: number }[]
      summary.tenants = due.length
      for (const { tenant_id: tenantId, retention_days: days } of due) {
        try {
          const r = await expireTenant(tenantId, Math.max(days, floor), {
            db,
            batch: env.RETENTION_BATCH,
          })
          summary.messages += r.messages
          summary.unsent += r.unsent
          summary.bodies += r.bodies
          summary.events += r.events
          summary.deliveries += r.deliveries
        } catch (error) {
          summary.failed++
          log.error({ err: error, tenantId }, "could not expire a workspace's mail")
        }
      }

      // ── 3. Sweep what expiring freed ──
      const graceHours = env.CONTENT_OBJECT_GRACE_HOURS
      const staleDays = env.CONTENT_TEMPLATE_STALE_DAYS
      const sweep = (await db.execute(
        sql`select tenant_id from core.content_sweep_due(make_interval(hours => ${Math.min(graceHours, staleDays * 24)}))`,
      )) as unknown as { tenant_id: string }[]
      for (const { tenant_id: tenantId } of sweep) {
        try {
          summary.templates += await sweepTemplates(db, tenantId, staleDays)
          if (store) {
            summary.objects += await sweepObjects(tenantId, { db, store, graceHours })
            summary.packs += await sweepPacks(tenantId, { db, store, graceHours })
          }
        } catch (error) {
          summary.failed++
          log.error({ err: error, tenantId }, "could not sweep a workspace's content")
        }
      }

      // ── 3b. Template images of deleted workspaces (#244) ──
      // Kept while a workspace lives, because sent mail points at them; gone
      // with the workspace. See templates/assets.ts.
      const bucket = templateAssetsBucketFrom(env)
      if (bucket) {
        try {
          summary.templateImages = await templateAssetStore({
            db,
            ...bucket,
          }).sweepDeleted()
        } catch (error) {
          summary.failed++
          log.error(
            { err: error },
            "could not sweep deleted workspaces' template images",
          )
        }
      }

      // ── 4. Tombstones and empty partitions ──
      const [pruned] = (await db.execute(
        sql`select core.prune_expired_messages(${TOMBSTONE_KEEP}::interval, 10000) as n`,
      )) as unknown as { n: number }[]
      summary.tombstonesPruned = Number(pruned?.n ?? 0)

      const parts = (await db.execute(
        sql`select partition_name, dropped from core.drop_empty_message_partitions(${floor})`,
      )) as unknown as { partition_name: string; dropped: boolean }[]
      for (const p of parts) {
        ;(p.dropped ? summary.partitionsDropped : summary.partitionsRefused).push(
          p.partition_name,
        )
      }
      if (summary.partitionsRefused.length > 0) {
        // ⚠ A PARTITION PAST EVERY PLAN'S PERIOD STILL HOLDS ROWS: step 2 is
        // failing for somebody, and their mail is being kept past its promise.
        captureMessage("expired partitions still hold rows", "warning", {
          partitions: summary.partitionsRefused,
        })
      }

      if (summary.unsent > 0) {
        log.warn({ unsent: summary.unsent }, "retention removed mail that never sent")
      }
      log.info(summary, "retention pass complete")
      if (summary.tenants > 0 && summary.failed >= summary.tenants) process.exitCode = 1
    } catch (error) {
      log.fatal({ err: error }, "retention pass could not run")
      captureError(error, { phase: "run" })
      process.exitCode = 1
    } finally {
      await client.end({ timeout: 5 })
    }
  },
)
