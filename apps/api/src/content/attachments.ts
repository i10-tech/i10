import { sql, type SQL } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import { objectKey, type ObjectStore } from "./object-store.js"

/**
 * Attachments in R2, content-addressed per workspace (#136, #168, #188).
 *
 * The lifecycle of one file:
 *   1. Accept stores it inline in `message_bodies.attachments`, base64, in the
 *      same transaction as today. Nothing touches R2 before the 202.
 *   2. The worker sends from that row.
 *   3. `storeAttachments`, minutes later, hashes the bytes, uploads them once
 *      per workspace, and rewrites the entry as `{ filename, content_type,
 *      size, sha256 }`.
 *   4. Readers restore through `restoreAttachments` (the worker, for a retry)
 *      or `summariseAttachments` (the console).
 *   5. Retention deletes the body; `sweepObjects` deletes the object once no
 *      body names it any more.
 *
 * ⚠ BYTE-EXACT. The stored object is the decoded bytes the caller sent, and a
 * restore re-encodes exactly those. Nothing is recompressed or cleaned
 * (#188's rule).
 */

/** As the caller sent it: the file itself, base64. */
export interface InlineAttachment {
  filename: string
  content_type?: string | undefined
  content: string
}

/** After the content-store job: the bytes are in R2. */
export interface StoredAttachment {
  filename: string
  content_type?: string | undefined
  size: number
  sha256: string
}

export type AnyAttachment = InlineAttachment | StoredAttachment

export const isStored = (a: unknown): a is StoredAttachment =>
  typeof a === "object" &&
  a !== null &&
  typeof (a as StoredAttachment).sha256 === "string" &&
  typeof (a as InlineAttachment).content !== "string"

const sha256Hex = (bytes: Uint8Array) =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex")

/**
 * ⚠ AN `IN (...)` LIST, NEVER `= any(${array})`. Drizzle expands an array
 * parameter to `($1, $2)` - a ROW, not an array - which works with one element
 * and breaks on the second.
 */
const list = (values: readonly string[]): SQL =>
  sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )

export interface StoreDeps {
  db: Database
  store: ObjectStore
  /** Bodies per workspace per run. */
  limit?: number
  log?: { warn?: (o: object, m: string) => void }
}

export interface StoreResult {
  /** Bodies whose files are now in R2. */
  moved: number
  /** Objects written. */
  uploaded: number
  /** Files that were already there: the dedup (#168). */
  reused: number
  /** Decoded bytes that left Postgres. */
  bytes: number
  /** Bodies that could not be moved this run; they stay inline. */
  errors: number
}

/**
 * Moves one workspace's finished messages' files to R2.
 *
 * ⚠ ONLY FINISHED MESSAGES: sent, failed or canceled. A queued or sending
 * message is the worker's; it keeps its inline copy until it is done.
 *
 * ⚠ ONE BODY AT A TIME, AND THE LIST IS READ WITHOUT THE FILES. A body may
 * carry ten megabytes; reading a batch of them at once is how a job runs out
 * of memory.
 *
 * ⚠ THE ORDER CLOSES THE RACE WITH THE SWEEP. For every hash: touch its
 * `content_objects` row (`last_seen_at = now()`); if there is none, upload,
 * then insert it. Only then is the body rewritten. The sweep deletes a row
 * only under `FOR UPDATE SKIP LOCKED` and only when `last_seen_at` is older
 * than its grace, so a touched object is never taken, and one the sweep took
 * first simply has no row left for the touch to find - and is uploaded again.
 */
export async function storeAttachments(
  tenantId: string,
  deps: StoreDeps,
): Promise<StoreResult> {
  const { db } = deps
  const result: StoreResult = { moved: 0, uploaded: 0, reused: 0, bytes: 0, errors: 0 }

  const pending = (await withTenant(db, tenantId, (tx) =>
    tx.execute(sql`
      select b.message_id, b.created_at::text as created_at
        from core.message_bodies b
        join core.messages m on m.id = b.message_id and m.created_at = b.created_at
       where b.tenant_id = ${tenantId}::uuid
         and b.attachments is not null
         and b.attachments_stored_at is null
         and m.status in ('sent', 'failed', 'canceled')
       order by b.created_at
       limit ${deps.limit ?? 200}
    `),
  )) as unknown as { message_id: string; created_at: string }[]

  for (const row of pending) {
    try {
      const moved = await storeOne(tenantId, row, deps)
      if (!moved) continue
      result.moved++
      result.uploaded += moved.uploaded
      result.reused += moved.reused
      result.bytes += moved.bytes
    } catch (error) {
      result.errors++
      // ⚠ ONE BAD BODY DOES NOT STOP THE REST. It stays inline, which is a
      // correct state, and the next run tries it again.
      deps.log?.warn?.(
        { err: error, tenantId, messageId: row.message_id },
        "could not move a message's attachments",
      )
    }
  }
  return result
}

async function storeOne(
  tenantId: string,
  // ⚠ `created_at` AS POSTGRES'S OWN TEXT, NOT A JS DATE. It is the partition
  // key and carries microseconds; a Date keeps milliseconds, and an UPDATE
  // keyed on the rounded value matches nothing (content/job.ts learned this).
  row: { message_id: string; created_at: string },
  { db, store }: StoreDeps,
) {
  const [body] = (await withTenant(db, tenantId, (tx) =>
    tx.execute(sql`
      select attachments from core.message_bodies
       where message_id = ${row.message_id}::uuid
         and created_at = ${row.created_at}::timestamptz
         and attachments_stored_at is null
    `),
  )) as unknown as { attachments: unknown }[]
  if (!body || !Array.isArray(body.attachments)) return null
  const original = body.attachments as AnyAttachment[]

  // Decode and hash every inline file; stored ones pass through untouched.
  const files = new Map<string, { bytes: Uint8Array; type?: string | undefined }>()
  const rewritten: StoredAttachment[] = original.map((a) => {
    if (isStored(a)) return a
    const bytes = Buffer.from((a as InlineAttachment).content ?? "", "base64")
    const sha256 = sha256Hex(bytes)
    files.set(sha256, { bytes, type: a.content_type })
    return {
      filename: a.filename,
      ...(a.content_type ? { content_type: a.content_type } : {}),
      size: bytes.byteLength,
      sha256,
    }
  })

  let uploaded = 0
  let reused = 0
  const hashes = [...files.keys()]
  if (hashes.length > 0) {
    const present = new Set(
      (
        (await withTenant(db, tenantId, (tx) =>
          tx.execute(sql`
            update core.content_objects set last_seen_at = now()
             where tenant_id = ${tenantId}::uuid and sha256 in (${list(hashes)})
            returning sha256
          `),
        )) as unknown as { sha256: string }[]
      ).map((r) => r.sha256),
    )
    for (const [sha256, file] of files) {
      if (present.has(sha256)) {
        reused++
        continue
      }
      await store.put(objectKey(tenantId, sha256), file.bytes, file.type)
      // ⚠ THE ROW ONLY AFTER THE UPLOAD SUCCEEDED. A row is the promise that
      // the object exists; the next message with this file trusts it and skips
      // the PUT.
      await withTenant(db, tenantId, (tx) =>
        tx.execute(sql`
          insert into core.content_objects (tenant_id, sha256, size)
          values (${tenantId}::uuid, ${sha256}, ${file.bytes.byteLength})
          on conflict (tenant_id, sha256) do update set last_seen_at = now()
        `),
      )
      uploaded++
    }
  }

  // ⚠ GUARDED ON THE ORIGINAL. The rewrite lands only if the row still holds
  // exactly what was hashed; anything that changed it since wins, and the
  // uploaded objects are swept once their grace passes.
  const updated = (await withTenant(db, tenantId, (tx) =>
    tx.execute(sql`
      update core.message_bodies
         set attachments = ${JSON.stringify(rewritten)}::jsonb,
             attachments_stored_at = now()
       where message_id = ${row.message_id}::uuid
         and created_at = ${row.created_at}::timestamptz
         and attachments_stored_at is null
         and attachments = ${JSON.stringify(original)}::jsonb
      returning message_id
    `),
  )) as unknown as unknown[]
  if (updated.length === 0) return null

  let bytes = 0
  for (const f of files.values()) bytes += f.bytes.byteLength
  return { uploaded, reused, bytes }
}

/**
 * Stored entries back to inline ones, for the worker - which needs the bytes to
 * build the MIME message when a failed message is sent again.
 *
 * ⚠ LOUD WHEN IT CANNOT. A message with a stored file and no store to read it
 * from must fail, not go out without its attachment.
 */
export async function restoreAttachments(
  store: ObjectStore | null,
  tenantId: string,
  attachments: readonly AnyAttachment[] | null,
): Promise<InlineAttachment[] | null> {
  if (!attachments) return null
  if (!attachments.some(isStored)) return attachments as InlineAttachment[]
  if (!store) {
    throw new Error(
      "message has attachments in the content store, and no content store is configured",
    )
  }
  return Promise.all(
    attachments.map(async (a) => {
      if (!isStored(a)) return a as InlineAttachment
      const bytes = await store.get(objectKey(tenantId, a.sha256))
      return {
        filename: a.filename,
        ...(a.content_type ? { content_type: a.content_type } : {}),
        content: Buffer.from(bytes).toString("base64"),
      }
    }),
  )
}

/** Name, type and decoded size of each file, whichever shape it is stored in. */
export function summariseAttachments(
  value: unknown,
): { filename?: string; content_type?: string; size?: number }[] | null {
  if (!Array.isArray(value)) return null
  return value.map((a) => {
    const item = (a ?? {}) as Record<string, unknown>
    const content = typeof item.content === "string" ? item.content : undefined
    // ⚠ THE DECODED SIZE, NOT THE BASE64 LENGTH. Reporting the encoded length
    // overstates every attachment by a third, and the number a person compares
    // it against - their provider's limit - is in decoded bytes.
    const size =
      typeof item.size === "number"
        ? item.size
        : content
          ? Math.floor((content.length * 3) / 4)
          : undefined
    return {
      ...(typeof item.filename === "string" ? { filename: item.filename } : {}),
      ...(typeof item.content_type === "string"
        ? { content_type: item.content_type }
        : {}),
      ...(size !== undefined ? { size } : {}),
    }
  })
}

export interface SweepObjectsDeps {
  db: Database
  store: ObjectStore
  graceHours: number
  limit?: number
}

/**
 * Deletes one workspace's objects that no message body names any more.
 *
 * ⚠ THE BODY ROW IS THE REFERENCE, SO THERE IS NOTHING TO KEEP IN STEP.
 * Retention deleting a body, a tenant deletion, a flush by hand - each makes
 * objects unreferenced without knowing they exist, and this finds them.
 *
 * ⚠ R2 FIRST, THEN THE ROW, INSIDE THE LOCK. The row is locked `FOR UPDATE
 * SKIP LOCKED` for the whole step, so a concurrent `storeAttachments` touch
 * either waits and then finds no row (and uploads again), or got there first
 * and made the row fresh (and this skips it). A delete of R2 that succeeds
 * with a commit that then fails leaves a row for a missing object; the next
 * run deletes it again, which is why the store's delete is idempotent.
 */
export async function sweepObjects(
  tenantId: string,
  deps: SweepObjectsDeps,
): Promise<number> {
  return withTenant(deps.db, tenantId, async (tx) => {
    const doomed = (await tx.execute(sql`
      select o.sha256 from core.content_objects o
       where o.tenant_id = ${tenantId}::uuid
         and o.last_seen_at < now() - make_interval(hours => ${deps.graceHours})
         and not exists (
           select 1 from core.message_bodies b
            where b.tenant_id = ${tenantId}::uuid
              and b.attachments @> jsonb_build_array(jsonb_build_object('sha256', o.sha256))
         )
       order by o.last_seen_at
       limit ${deps.limit ?? 200}
       for update skip locked
    `)) as unknown as { sha256: string }[]
    for (const { sha256 } of doomed) {
      await deps.store.delete(objectKey(tenantId, sha256))
      await tx.execute(sql`
        delete from core.content_objects
         where tenant_id = ${tenantId}::uuid and sha256 = ${sha256}
      `)
    }
    return doomed.length
  })
}
