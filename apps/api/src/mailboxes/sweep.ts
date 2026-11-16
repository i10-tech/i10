import { and, eq, isNull, lt, notInArray, sql } from "drizzle-orm"
import type { ObjectStore } from "../content/object-store.js"
import type { Database } from "../db/client.js"
import { withTenant } from "../db/client.js"
import { mailboxJobs } from "../db/core.js"
import { UPLOAD_TTL_S } from "./jobs.js"

/**
 * The hourly mailbox job sweep, run by `i10-retention` (#392).
 *
 *   1. Fails a job whose worker was lost: `running`, and quiet for
 *      `LOST_AFTER_MS`.
 *   2. Deletes every archive in R2 nobody is going to use again, and the rows
 *      of a workspace whose tenant row is gone. What is due when is in the
 *      header of the `mailbox_jobs_sweep_due` migration.
 *
 * ⚠ STEP 1 RUNS FIRST, so a lost import's plain upload is deleted in the same
 * run: a failed import with an object is due at once.
 *
 * ⚠ R2 FIRST, THEN THE ROW. Both writes are idempotent, so a run that dies
 * between them leaves a row naming a missing object, and the next run deletes
 * it again and clears the row.
 */

/** An import's upload is kept this long after the job last moved, then goes. */
export const IMPORT_ARCHIVE_KEEP_MS = 24 * 60 * 60 * 1000

/**
 * How long a `running` job may go without a progress write before it is
 * failed as lost.
 *
 * ⚠ 3 HOURS IS FAR PAST ANY LIVE JOB'S SILENCE. Every progress write touches
 * `updated_at`: an export writes every 50 messages and every folder, an import
 * every 25 messages (migration.ts). So an export is quiet for at most 50
 * messages of `LIMITS.maxMessageBytes` (50 MiB) each, and an import at most for
 * reading through its whole upload (`LIMITS.maxArchiveBytes`, 4 GiB, unpacking
 * to at most `maxUnpackedBytes`) before its first message. That is minutes at
 * R2 speed. groupmq's own stall window is `jobTimeoutMs`, 10 minutes, in
 * queue/mailbox-queue.ts; its `maxAttempts: 1` fails the job in Redis without
 * our handler, which is the row this rule is for.
 */
export const LOST_AFTER_MS = 3 * 60 * 60 * 1000

/** What a lost job tells the customer. */
const LOST_ERROR = "The job stopped before it finished. Start it again."

const PAGE = 100

const seconds = (ms: number) => sql`make_interval(secs => ${ms / 1000})`

export interface DueArchive {
  tenantId: string
  jobId: string
  objectKey: string | null
  /** The tenant row is gone: the job row is deleted once its object is. */
  tenantGone: boolean
}

export interface MailboxSweepStore {
  lost(
    after: string | null,
    limit: number,
  ): Promise<{ tenantId: string; jobId: string }[]>
  /** False when the job moved since the list. */
  failLost(tenantId: string, jobId: string): Promise<boolean>
  archivesDue(after: string | null, limit: number): Promise<DueArchive[]>
  clearObject(tenantId: string, jobId: string, objectKey: string): Promise<void>
  /** False when the row still has an object, or is pending or running. */
  deleteRow(tenantId: string, jobId: string): Promise<boolean>
}

/**
 * ⚠ THE LISTS ARE SECURITY DEFINER FUNCTIONS, EVERY WRITE IS UNDER ITS TENANT.
 * `mailbox_jobs`'s policy casts `app.tenant_id` to uuid, so `i10_api` cannot
 * read it across workspaces; the functions answer ids and keys only.
 */
export function mailboxSweepStore(db: Database): MailboxSweepStore {
  const row = (tenantId: string, jobId: string) =>
    and(eq(mailboxJobs.id, jobId), eq(mailboxJobs.tenantId, tenantId))

  return {
    async lost(after, limit) {
      const rows = (await db.execute(
        sql`select tenant_id, job_id from core.mailbox_jobs_lost(${after}::uuid, ${seconds(LOST_AFTER_MS)}, ${limit})`,
      )) as unknown as { tenant_id: string; job_id: string }[]
      return rows.map((r) => ({ tenantId: r.tenant_id, jobId: r.job_id }))
    },

    async failLost(tenantId, jobId) {
      const changed = await withTenant(db, tenantId, (tx) =>
        tx
          .update(mailboxJobs)
          .set({
            status: "failed",
            errorCode: "worker_lost",
            error: LOST_ERROR,
            completedAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              row(tenantId, jobId),
              // Re-checked here: a job that moved since the list is alive.
              eq(mailboxJobs.status, "running"),
              lt(mailboxJobs.updatedAt, sql`now() - ${seconds(LOST_AFTER_MS)}`),
            ),
          )
          .returning({ id: mailboxJobs.id }),
      )
      return changed.length > 0
    },

    async archivesDue(after, limit) {
      const rows = (await db.execute(
        sql`select tenant_id, job_id, object_key, tenant_gone
              from core.mailbox_archives_due(${after}::uuid, ${seconds(IMPORT_ARCHIVE_KEEP_MS)}, ${seconds(UPLOAD_TTL_S * 1000)}, ${limit})`,
      )) as unknown as {
        tenant_id: string
        job_id: string
        object_key: string | null
        tenant_gone: boolean
      }[]
      return rows.map((r) => ({
        tenantId: r.tenant_id,
        jobId: r.job_id,
        objectKey: r.object_key,
        tenantGone: r.tenant_gone,
      }))
    },

    async clearObject(tenantId, jobId, objectKey) {
      await withTenant(db, tenantId, (tx) =>
        tx
          .update(mailboxJobs)
          .set({ objectKey: null, updatedAt: sql`now()` })
          .where(and(row(tenantId, jobId), eq(mailboxJobs.objectKey, objectKey))),
      )
    },

    async deleteRow(tenantId, jobId) {
      const deleted = await withTenant(db, tenantId, (tx) =>
        tx
          .delete(mailboxJobs)
          .where(
            and(
              row(tenantId, jobId),
              // Never a row that still names an object, or may yet write one.
              isNull(mailboxJobs.objectKey),
              notInArray(mailboxJobs.status, ["pending", "running"]),
            ),
          )
          .returning({ id: mailboxJobs.id }),
      )
      return deleted.length > 0
    },
  }
}

export interface MailboxSweepDeps {
  store: MailboxSweepStore
  /** Without one, archives are left alone; lost jobs are still failed. */
  objects: ObjectStore | null
  log?: {
    warn: (o: object, m: string) => void
    error: (o: object, m: string) => void
  }
}

export async function sweepMailboxJobs(deps: MailboxSweepDeps) {
  const { store, objects, log } = deps
  const counts = { lost: 0, archives: 0, rows: 0, failed: 0 }

  // One failing row must not stop the rest; the next run tries it again.
  const each = async <T extends { tenantId: string; jobId: string }>(
    list: (after: string | null) => Promise<T[]>,
    run: (item: T) => Promise<void>,
    failure: string,
  ) => {
    for (let after: string | null = null; ;) {
      const page = await list(after)
      for (const item of page) {
        try {
          await run(item)
        } catch (error) {
          counts.failed++
          log?.error(
            { err: error, tenantId: item.tenantId, jobId: item.jobId },
            failure,
          )
        }
      }
      if (page.length < PAGE) return
      after = page.at(-1)!.jobId
    }
  }

  await each(
    (after) => store.lost(after, PAGE),
    async ({ tenantId, jobId }) => {
      if (await store.failLost(tenantId, jobId)) counts.lost++
    },
    "could not fail a lost mailbox job",
  )

  if (!objects) {
    log?.warn({}, "no content store configured; mailbox archives were not swept")
    return counts
  }

  await each(
    (after) => store.archivesDue(after, PAGE),
    async ({ tenantId, jobId, objectKey, tenantGone }) => {
      if (objectKey) {
        await objects.delete(objectKey)
        await store.clearObject(tenantId, jobId, objectKey)
        counts.archives++
      }
      if (tenantGone && (await store.deleteRow(tenantId, jobId))) counts.rows++
    },
    "could not sweep a mailbox job's archive",
  )
  return counts
}
