import { sql } from "drizzle-orm"
import type { Keyring } from "../crypto/keyring.js"
import { withTenant, type Database } from "../db/client.js"
import { objectKey, type ContentStore, type ObjectStore } from "./object-store.js"
import { inList, readObjects, sealObject } from "./objects.js"

/**
 * Attachments in R2, content-addressed per workspace and sealed under
 * `OBJECT_KEYS` (#136, #168, #188, content/objects.ts).
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
  /** An inline image the html names as `cid:` (#168). Survives the move to R2. */
  content_id?: string | undefined
  content: string
}

/** After the content-store job: the bytes are in R2. */
export interface StoredAttachment {
  filename: string
  content_type?: string | undefined
  content_id?: string | undefined
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

export interface StoreDeps {
  db: Database
  store: ObjectStore
  /** `OBJECT_KEYS`. Without them nothing moves: see content-store.ts. */
  keys: Keyring
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
 * ⚠ EVERY FILE IS IN R2 BEFORE ITS BODY IS REWRITTEN: see `putObjects`.
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
  { db, store, keys }: StoreDeps,
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
      // ⚠ KEPT, OR A RETRY SENDS THE LOGO AS A DOWNLOAD AND THE HTML'S
      // `cid:` POINTS AT NOTHING.
      ...(a.content_id ? { content_id: a.content_id } : {}),
      size: bytes.byteLength,
      sha256,
    }
  })

  const { uploaded, reused } = await putObjects(tenantId, files, { db, store, keys })

  // ⚠ GUARDED ON THE ORIGINAL. The rewrite lands only if the row still holds
  // exactly what was hashed; anything that changed it since wins, and the
  // uploaded objects are swept once their grace passes.
  const updated = (await withTenant(db, tenantId, (tx) =>
    tx.execute(sql`
      update core.message_bodies
         set attachments = ${sql.param(rewritten)}::jsonb,
             attachments_stored_at = now()
       where message_id = ${row.message_id}::uuid
         and created_at = ${row.created_at}::timestamptz
         and attachments_stored_at is null
         and attachments = ${sql.param(original)}::jsonb
      returning message_id
    `),
  )) as unknown as unknown[]
  if (updated.length === 0) return null

  let bytes = 0
  for (const f of files.values()) bytes += f.bytes.byteLength
  return { uploaded, reused, bytes }
}

/**
 * Makes sure every file is sealed in R2 and has its `content_objects` row,
 * before a body is rewritten to point at it. Shared by attachments and inline
 * images.
 *
 * ⚠ THE ORDER CLOSES THE RACE WITH THE SWEEP. For every hash: touch its row
 * (`last_seen_at = now()`); if there is none, insert it and upload. Only then
 * may the caller rewrite the body. The sweep deletes a row only under
 * `FOR UPDATE SKIP LOCKED` and only past its grace, so a touched object is
 * never taken, and one the sweep took first has no row for the touch to find -
 * and is uploaded again.
 *
 * ⚠ THE ROW AND THE UPLOAD ARE ONE TRANSACTION, AND THAT IS THE DEDUP'S
 * SAFETY. The row holds the key the object was sealed with. Two first uploads
 * of one file at once: the second insert waits on the first's uncommitted row.
 * If the first commits, its object is in R2 and the second reuses it; if the
 * first fails, it rolls back and the second inserts and uploads its own. So a
 * row anyone can see always names the key of the object in R2. A commit that
 * fails after the PUT leaves an object without a row, and the next upload of
 * that file overwrites it under a key of its own.
 */
export async function putObjects(
  tenantId: string,
  files: ReadonlyMap<string, { bytes: Uint8Array; type?: string | undefined }>,
  { db, store, keys }: { db: Database; store: ObjectStore; keys: Keyring },
): Promise<{ uploaded: number; reused: number }> {
  let uploaded = 0
  let reused = 0
  const hashes = [...files.keys()]
  if (hashes.length === 0) return { uploaded, reused }
  const present = new Set(
    (
      (await withTenant(db, tenantId, (tx) =>
        tx.execute(sql`
          update core.content_objects set last_seen_at = now()
           where tenant_id = ${tenantId}::uuid and sha256 in (${inList(hashes)})
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
    const sealed = sealObject(keys, { tenantId, sha256 }, file.bytes)
    const inserted = await withTenant(db, tenantId, async (tx) => {
      const mine = (await tx.execute(sql`
        insert into core.content_objects (tenant_id, sha256, size, sealed_key)
        values (${tenantId}::uuid, ${sha256}, ${file.bytes.byteLength}, ${sealed.sealedKey})
        on conflict (tenant_id, sha256) do nothing
        returning sha256
      `)) as unknown as unknown[]
      if (mine.length === 0) {
        const touched = (await tx.execute(sql`
          update core.content_objects set last_seen_at = now()
           where tenant_id = ${tenantId}::uuid and sha256 = ${sha256}
          returning sha256
        `)) as unknown as unknown[]
        // Taken by the sweep between the two statements: the body stays
        // inline and the next run uploads it again.
        if (touched.length === 0)
          throw new Error(`stored file ${sha256} was just swept`)
        return false
      }
      // ⚠ NOT THE FILE'S OWN TYPE: the object is ciphertext. The type is in
      // the attachment entry or the data URI, which is where readers take it.
      await store.put(
        objectKey(tenantId, sha256),
        sealed.bytes,
        "application/octet-stream",
      )
      return true
    })
    if (inserted) uploaded++
    else reused++
  }
  return { uploaded, reused }
}

/**
 * Stored entries back to inline ones, for the worker - which needs the bytes to
 * build the MIME message when a failed message is sent again.
 *
 * ⚠ LOUD WHEN IT CANNOT. A message with a stored file and no store to read it
 * from must fail, not go out without its attachment.
 */
export async function restoreAttachments(
  db: Database,
  store: ContentStore | null,
  tenantId: string,
  attachments: readonly AnyAttachment[] | null,
): Promise<InlineAttachment[] | null> {
  if (!attachments) return null
  if (!attachments.some(isStored)) return attachments as InlineAttachment[]
  const files = await readObjects(
    db,
    store,
    tenantId,
    attachments.filter(isStored).map((a) => a.sha256),
  )
  return attachments.map((a) => {
    if (!isStored(a)) return a as InlineAttachment
    const bytes = files.get(a.sha256)!
    return {
      filename: a.filename,
      ...(a.content_type ? { content_type: a.content_type } : {}),
      ...(a.content_id ? { content_id: a.content_id } : {}),
      content: bytes.toString("base64"),
    }
  })
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
 * Deletes one workspace's objects that no message body names any more - as an
 * attachment, or as an inline image in its html (`inline_objects`, #168).
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
         -- ⚠ AND NO BODY'S HTML REFERENCES IT (#168). Inline images live in
         -- the same objects; without this the sweep deleted a logo every
         -- compacted receipt still pointed at.
         and not exists (
           select 1 from core.message_bodies b
            where b.tenant_id = ${tenantId}::uuid
              and b.inline_objects @> array[o.sha256]
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
