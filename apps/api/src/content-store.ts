/**
 * The content job: everything done to stored mail after it is sent, every five
 * minutes, then exits (#136, #168, #171, #188).
 *
 * Per workspace with work, in this order:
 *   1. FINGERPRINTS (risk on): MinHash and link hosts from the stored bodies,
 *      and the farm tripwire. This used to run in the API after every accept;
 *      #171's rule is that nothing beyond a hash runs on the send path.
 *   2. ATTACHMENTS (content store configured): finished messages' files to R2.
 *   3. COMPACTION (always): template matching, linking and promotion
 *      (content/compact.ts). It used to ride the hourly risk run, so switching
 *      risk off stopped it, and the system tenant - exempt from scoring, and
 *      sender of our most templated mail - never compacted at all.
 *
 * ⚠ EVERY FIVE MINUTES, SO WORK WAITS MINUTES, NOT HOURS. Accept writes the raw
 * message and returns; this is the "process later" half of #188, and the farm
 * tripwire fires at this latency.
 *
 * ⚠ A CronJob, NOT AN INTERVAL IN THE WORKER, for the reason sweep.ts gives:
 * the worker scales by replica. Two overlapping runs would be harmless anyway
 * (every rewrite is guarded on the original, every stamp on its own column),
 * and `Forbid` keeps it to one.
 *
 * ⚠ EACH HALF IS OPTIONAL ON ITS OWN SWITCH, AND NONE STOPS THE OTHERS.
 * Without the CONTENT_STORE_* settings attachments stay inline; without
 * RISK_ENABLED nothing is fingerprinted; compaction runs either way.
 */
import { sql } from "drizzle-orm"
import pino from "pino"
import { storeAttachments } from "./content/attachments.js"
import { compactContent, PROMOTE_AT, WINDOW_DAYS } from "./content/compact.js"
import { objectStoreFrom } from "./content/object-store.js"
import { assertRlsSubject, createDb } from "./db/client.js"
import { loadEnv } from "./env.js"
import { captureError, initObservability, withMonitor } from "./observability.js"
import { fingerprintStored } from "./risk/content.js"
import { markDirty } from "./risk/runner.js"
import { riskRuntime } from "./risk/runtime.js"
import { riskTrigger } from "./risk/trigger.js"

const log = pino({ name: "i10-content-store" })
const env = loadEnv()

initObservability({
  dsn: env.SENTRY_DSN,
  environment: env.SENTRY_ENVIRONMENT,
  service: "content-store",
  release: process.env.GIT_SHA,
  log,
})

/** Workspaces per kind of work per run. */
const DUE_LIMIT = 500

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
    if (!store) log.warn("CONTENT_STORE_* is not set; attachments stay in Postgres")
    const { sql: client, db } = createDb(env.DATABASE_URL)
    let runtime: Awaited<ReturnType<typeof riskRuntime>> | null = null
    try {
      await assertRlsSubject(client, log)
      const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString()

      // Workspaces, never content: see 0076 and 0082.
      const ids = async (q: ReturnType<typeof sql>) =>
        ((await db.execute(q)) as unknown as { tenant_id: string }[]).map((r) =>
          String(r.tenant_id),
        )
      const attachmentsDue = new Set(
        store
          ? await ids(sql`select tenant_id from core.content_store_due(${DUE_LIMIT})`)
          : [],
      )
      const compactionDue = new Set(
        await ids(
          sql`select tenant_id from core.content_compaction_due(${DUE_LIMIT}, ${since}::timestamptz, ${PROMOTE_AT})`,
        ),
      )
      const fingerprintDue = new Set(
        env.RISK_ENABLED
          ? await ids(
              sql`select tenant_id from core.content_fingerprint_due(${DUE_LIMIT}, ${since}::timestamptz)`,
            )
          : [],
      )
      const due = [...new Set([...fingerprintDue, ...attachmentsDue, ...compactionDue])]

      /*
       * ⚠ THE RISK ENGINE ONLY WHEN SOMETHING WILL BE FINGERPRINTED. The
       * tripwire re-scores a cluster from here, with the same construction the
       * hourly run uses (risk/runtime.ts), so a hold placed on a tripwire is
       * the same hold the hourly run would place.
       */
      runtime =
        fingerprintDue.size > 0
          ? await riskRuntime({ env, db, sql: client, log })
          : null
      const trigger = runtime ? riskTrigger(runtime.risk.deps) : null

      const total = {
        tenants: due.length,
        fingerprinted: 0,
        moved: 0,
        uploaded: 0,
        reused: 0,
        bytes: 0,
        errors: 0,
        examined: 0,
        inlineExtracted: 0,
        inlineBytes: 0,
        linked: 0,
        derived: 0,
        compacted: 0,
        bytesSaved: 0,
      }
      let failed = 0
      for (const tenantId of due) {
        // ⚠ EACH STEP IN ITS OWN TRY. A workspace whose fingerprints fail still
        // gets its files moved and its mail compacted, and the other way round.
        let ok = true
        if (runtime && trigger && fingerprintDue.has(tenantId)) {
          try {
            const n = await fingerprintStored(tenantId, {
              db,
              redis: runtime.cache,
              threshold: env.RISK_FARM_TRIPWIRE,
              rescore: (tenantIds, why) => trigger.rescore(tenantIds, why),
              trust: runtime.risk.cachedTrust,
              store,
            })
            total.fingerprinted += n
            if (n > 0) await markDirty(runtime.cache, [tenantId])
          } catch (error) {
            ok = false
            log.error({ err: error, tenantId }, "fingerprint pass failed")
          }
        }
        if (store && attachmentsDue.has(tenantId)) {
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
            ok = false
            log.error({ err: error, tenantId }, "attachment pass failed")
          }
        }
        if (compactionDue.has(tenantId)) {
          try {
            const c = await compactContent(tenantId, { db, store, log })
            total.examined += c.scanned
            total.inlineExtracted += c.extracted
            total.inlineBytes += c.inlineBytes
            total.linked += c.matched
            total.derived += c.derived
            total.compacted += c.compacted
            total.bytesSaved += c.bytesSaved
          } catch (error) {
            ok = false
            log.error({ err: error, tenantId }, "compaction pass failed")
          }
        }
        if (!ok) failed++
      }

      // Tripwire re-scores run in the background; the job waits for them.
      await trigger?.idle()
      log.info({ ...total, failed }, "content pass complete")
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
      log.fatal({ err: error }, "content pass could not run")
      captureError(error, { phase: "run" })
      process.exitCode = 1
    } finally {
      await runtime?.close()
      await client.end({ timeout: 5 })
    }
  },
)
