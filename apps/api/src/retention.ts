import "./openapi-first.js"
/**
 * Enforces retention and frees what it leaves behind, then exits
 * (docs/decisions/storage.md).
 *
 * One run, in this order:
 *   0. Prunes the mail front's access-change log (`authd.access_changes`) of
 *      rows older than an hour: the cutoff is fixed inside the function.
 *   0b. Prunes expired mail device codes (`authd.mail_devices`, #383): unused
 *      codes older than 10 minutes and used codes idle past 90 days, in batches
 *      of 1,000 per transaction.
 *   1. Keeps a year of monthly partitions ahead, locked down like 0064's.
 *   2. Deletes every workspace's mail older than its plan keeps it: row, body,
 *      events, webhook deliveries - leaving a tombstone per message.
 *   3. Sweeps templates no body uses that have gone stale, and R2 objects and
 *      body packs (#188) no body names. Step 2 is what makes them unreferenced.
 *      Then deleted workspaces' template images (#244), and mailbox jobs
 *      (#392): fails the ones whose worker was lost, and deletes export and
 *      import archives nobody will use again (mailboxes/sweep.ts).
 *      Then the mailboxes whose 30 day deletion grace is over are purged
 *      (mailboxes/lifecycle.ts).
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
import { createClerkClient } from "@clerk/backend"
import { jmapAs } from "./mail/jmap-as.js"
import { clerkAddressRemoval } from "./mailboxes/clerk.js"
import { mailboxJobStore } from "./mailboxes/jobs.js"
import { mailboxLifecycleStore } from "./mailboxes/lifecycle-store.js"
import { purgeDueMailboxes } from "./mailboxes/lifecycle.js"
import { mailboxSweepStore, sweepMailboxJobs } from "./mailboxes/sweep.js"
import { assertRlsSubject, createDb } from "./db/client.js"
import {
  pruneCertBinds,
  pruneCertPermits,
  pruneMailDevices,
} from "./mail-devices/prune.js"
import { loadEnv } from "./env.js"
import { unlockEnv } from "./crypto/unlock.js"
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
const env = loadEnv(await unlockEnv(log))

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
      mailboxJobsLost: 0,
      mailboxArchives: 0,
      mailboxRows: 0,
      mailboxesPurged: 0,
      mailboxesWaitingForExport: 0,
      accessChangesPruned: 0,
      mailDevicesUnusedPruned: 0,
      mailDevicesIdlePruned: 0,
      certPermitsPruned: 0,
      certBindsPruned: 0,
      tombstonesPruned: 0,
      partitionsDropped: [] as string[],
      partitionsRefused: [] as string[],
      failed: 0,
    }
    try {
      await assertRlsSubject(client, log)

      // ── 0. The access-change log ──
      // ⚠ FIRST, AND ON ITS OWN. The triggers on every table the mail gate reads
      // write it whether or not a mail front runs to read it, so this job, which
      // runs wherever the writers do, keeps it bounded. A failure in any later
      // step must not let it grow. Each call deletes at most 10,000 rows, and
      // none only when nothing older than the hour is left.
      try {
        for (let calls = 0; calls < 100; calls++) {
          const [pruned] = (await db.execute(
            sql`select authd.prune_access_changes() as n`,
          )) as unknown as { n: number }[]
          const n = Number(pruned?.n ?? 0)
          summary.accessChangesPruned += n
          if (n === 0) break
        }
      } catch (error) {
        log.error({ err: error }, "could not prune the access-change log")
        captureError(error, { phase: "access_changes" })
      }

      // ── 0b. Mail device codes (#383) ──
      // Unused codes older than 10 minutes and used codes idle past 90 days.
      // Batched at 1,000 rows per transaction using the partial indexes.
      try {
        const devices = await pruneMailDevices(db)
        summary.mailDevicesUnusedPruned = devices.unused
        summary.mailDevicesIdlePruned = devices.idle
      } catch (error) {
        log.error({ err: error }, "could not prune expired mail device codes")
        captureError(error, { phase: "mail_devices" })
      }

      // ── 0c. Device certificate permits and Mac liveness rows (#383 PR 3) ──
      // Permits a day past expiry; liveness rows a day old (authd reads them for
      // 75 minutes). Batched like the codes, each in its own try so one failing
      // never stops the other.
      try {
        summary.certPermitsPruned = await pruneCertPermits(db)
      } catch (error) {
        log.error({ err: error }, "could not prune device certificate permits")
        captureError(error, { phase: "mail_device_cert_permits" })
      }
      try {
        summary.certBindsPruned = await pruneCertBinds(db)
      } catch (error) {
        log.error({ err: error }, "could not prune Mac liveness rows")
        captureError(error, { phase: "mail_device_cert_binds" })
      }

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

      // ── 3c. Mailbox archives and lost jobs (#392) ──
      // Every workspace's, deleted ones and ones whose tenant row is gone
      // included. See mailboxes/sweep.ts.
      try {
        const swept = await sweepMailboxJobs({
          store: mailboxSweepStore(db),
          objects: store,
          log,
        })
        summary.mailboxJobsLost = swept.lost
        summary.mailboxArchives = swept.archives
        summary.mailboxRows = swept.rows
        summary.failed += swept.failed
      } catch (error) {
        summary.failed++
        log.error({ err: error }, "could not sweep mailbox jobs")
      }

      // ── 3d. Mailboxes whose 30 day deletion grace is over ──
      // Destroys the Stalwart account, takes the address off the person's Clerk
      // user and removes our rows (mailboxes/lifecycle.ts). It needs Stalwart and
      // Clerk, so a deployment without them leaves every deleting mailbox deleting
      // (sign-in refused, nothing destroyed) rather than half of a purge.
      try {
        if (
          env.STALWART_URL &&
          env.STALWART_API_TOKEN &&
          env.STALWART_IMPERSONATE_TOKEN
        ) {
          const jmap = jmapAs({
            baseUrl: env.STALWART_URL,
            registryToken: env.STALWART_API_TOKEN,
            impersonationToken: env.STALWART_IMPERSONATE_TOKEN,
          })
          const purged = await purgeDueMailboxes({
            store: mailboxLifecycleStore(db),
            accounts: { destroy: (address) => jmap.destroyAccount({ address }) },
            clerk: clerkAddressRemoval(
              createClerkClient({ secretKey: env.CLERK_SECRET_KEY }),
            ),
            exports: mailboxJobStore(db),
            log,
          })
          summary.mailboxesPurged = purged.purged
          summary.mailboxesWaitingForExport = purged.waiting
          summary.failed += purged.failed
        } else {
          log.warn({}, "stalwart is not configured; deleted mailboxes were not purged")
        }
      } catch (error) {
        summary.failed++
        log.error({ err: error }, "could not purge deleted mailboxes")
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
