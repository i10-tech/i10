import { sql } from "drizzle-orm"
import { ts, type Database } from "../db/client.js"

/**
 * Prunes expired `authd.mail_devices` rows from the hourly retention job
 * (`apps/api/src/retention.ts`):
 *
 *   - unused codes older than 10 minutes (`first_used_at IS NULL`, using the
 *     partial index `mail_devices_unused_idx`),
 *   - used codes idle for more than 90 days (`last_used_at IS NOT NULL`, using
 *     the partial index `mail_devices_last_used_idx`).
 *
 * Deletes at most `batchSize` (default 1,000) rows per transaction, looping
 * until a batch is short, so one run never logs more than the mail front's
 * per-poll limit (10,000) in a single commit and never holds long locks.
 *
 * Each DELETE picks ids via the partial index with `FOR UPDATE SKIP LOCKED`
 * and re-checks the predicate on the outer DELETE so a concurrent first-use
 * claim or daily touch from authd can never be wiped.
 */

export const UNUSED_DEVICE_TTL_MS = 10 * 60 * 1000
export const IDLE_DEVICE_TTL_MS = 90 * 24 * 60 * 60 * 1000
export const PRUNE_BATCH_SIZE = 1000

export interface PruneResult {
  unused: number
  idle: number
  batches: number
}

export async function pruneMailDevices(
  db: Pick<Database, "transaction">,
  options: { batchSize?: number; now?: Date } = {},
): Promise<PruneResult> {
  const batchSize = Math.max(1, Math.min(options.batchSize ?? PRUNE_BATCH_SIZE, 10_000))
  const unusedCutoff = options.now
    ? ts(new Date(options.now.getTime() - UNUSED_DEVICE_TTL_MS))
    : sql`now() - interval '10 minutes'`
  const idleCutoff = options.now
    ? ts(new Date(options.now.getTime() - IDLE_DEVICE_TTL_MS))
    : sql`now() - interval '90 days'`

  let unused = 0
  let idle = 0
  let batches = 0

  for (;;) {
    const deleted = await db.transaction(async (tx) => {
      const rows = (await tx.execute(sql`
        with picked as (
          select id
            from authd.mail_devices
           where first_used_at is null
             and created_at <= ${unusedCutoff}
           order by created_at
           limit ${batchSize}
             for update skip locked
        )
        delete from authd.mail_devices d
         using picked
         where d.id = picked.id
           and d.first_used_at is null
           and d.created_at <= ${unusedCutoff}
        returning d.id
      `)) as unknown as { id: string }[]
      return rows.length
    })
    unused += deleted
    if (deleted > 0) batches++
    if (deleted < batchSize) break
  }

  for (;;) {
    const deleted = await db.transaction(async (tx) => {
      const rows = (await tx.execute(sql`
        with picked as (
          select id
            from authd.mail_devices
           where last_used_at is not null
             and last_used_at <= ${idleCutoff}
           order by last_used_at
           limit ${batchSize}
             for update skip locked
        )
        delete from authd.mail_devices d
         using picked
         where d.id = picked.id
           and d.last_used_at is not null
           and d.last_used_at <= ${idleCutoff}
        returning d.id
      `)) as unknown as { id: string }[]
      return rows.length
    })
    idle += deleted
    if (deleted > 0) batches++
    if (deleted < batchSize) break
  }

  return { unused, idle, batches }
}
