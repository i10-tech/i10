import { sql, type SQL } from "drizzle-orm"
import { ts, type Database } from "../db/client.js"

/**
 * Prunes expired `authd.mail_devices` and `authd.mail_device_cert_binds` rows
 * from the hourly retention job (`apps/api/src/retention.ts`):
 *
 *   - unused device codes older than 10 minutes (`first_used_at IS NULL`, using
 *     the partial index `mail_devices_unused_idx`),
 *   - used device codes idle for more than 90 days (`last_used_at IS NOT NULL`,
 *     using the partial index `mail_devices_last_used_idx`),
 *   - Mac liveness rows (`authd.mail_device_cert_binds`) older than a day.
 *
 * Enrollment sessions and SCEP/ACME state live in `i10-enroll-redis` with
 * bounded TTLs and need no Postgres pruning.
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

/** How long a Mac liveness row outlives its active window. */
const ONE_DAY_MS = 24 * 60 * 60 * 1000
/** Upper bound on transactions per run, so a stuck DELETE never loops forever. */
const MAX_PRUNE_BATCHES = 1000

/**
 * Deletes "the Mac is online" rows (`authd.mail_device_cert_binds`) older than a
 * day, through `mail_device_cert_binds_bound_at_idx`. authd reads a row only
 * within 75 minutes of `bound_at`, so an older one opens nothing.
 *
 * THE OUTER DELETE RE-CHECKS `bound_at`. authd refreshes a row in place
 * (autocommit upsert), and a refreshed row must survive.
 */
export async function pruneCertBinds(
  db: Pick<Database, "transaction">,
  options: { batchSize?: number; now?: Date } = {},
): Promise<number> {
  const cutoff = options.now
    ? ts(new Date(options.now.getTime() - ONE_DAY_MS))
    : sql`now() - interval '1 day'`
  return pruneInBatches(
    db,
    options.batchSize,
    (limit) => sql`
    with picked as (
      select device_id, addr from authd.mail_device_cert_binds
       where bound_at < ${cutoff}
       order by bound_at
       limit ${limit}
         for update skip locked
    )
    delete from authd.mail_device_cert_binds b
     using picked
     where b.device_id = picked.device_id and b.addr = picked.addr
       and b.bound_at < ${cutoff}
    returning b.device_id`,
  )
}

async function pruneInBatches(
  db: Pick<Database, "transaction">,
  requested: number | undefined,
  statement: (limit: number) => SQL,
): Promise<number> {
  const batchSize = Math.max(1, Math.min(requested ?? PRUNE_BATCH_SIZE, 10_000))
  let deleted = 0
  for (let batch = 0; batch < MAX_PRUNE_BATCHES; batch++) {
    const rows = await db.transaction(
      async (tx) => (await tx.execute(statement(batchSize))) as unknown as unknown[],
    )
    deleted += rows.length
    if (rows.length < batchSize) break
  }
  return deleted
}
