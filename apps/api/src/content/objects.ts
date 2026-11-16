import { sql, type SQL } from "drizzle-orm"
import {
  gcmOpen,
  gcmSeal,
  newDataKey,
  unwrapKey,
  wrapKey,
  type KeyPurpose,
} from "../crypto/envelope.js"
import type { Keyring } from "../crypto/keyring.js"
import { withTenant, type Database } from "../db/client.js"
import { objectKey, type ContentStore } from "./object-store.js"

/**
 * Files in R2, sealed: attachments and data-URI images (#136, #168). Each
 * object has a random key of its own, wrapped by an `OBJECT_KEYS` master key
 * and kept on its `content_objects` row (crypto/envelope.ts).
 *
 *   object      nonce(12) | AES-256-GCM(file) | tag(16)
 *   wrapped key kid-length(1) | kid | nonce(12) | AES-256-GCM(object key) | tag(16)
 *
 * Both are bound to `i10/object/v1/<tenant>/<sha256>`, so an object or a key
 * copied to another workspace or another hash does not open.
 *
 * ⚠ THE NAME IS STILL THE HASH OF THE PLAIN FILE. Dedup needs it, and it means
 * someone who can list the bucket can test whether a workspace stored a file
 * they already hold. docs/decisions/storage.md says so.
 */

export interface ObjectIds {
  tenantId: string
  sha256: string
}

/** `content_objects.sealed_key`, under `OBJECT_KEYS`. */
export const OBJECT_KEY: KeyPurpose<ObjectIds> = {
  what: "stored file",
  aad: ({ tenantId, sha256 }) => Buffer.from(`i10/object/v1/${tenantId}/${sha256}`),
}

export interface SealedObject {
  bytes: Buffer
  /** Base64, for `content_objects.sealed_key`. */
  sealedKey: string
}

export function sealObject(
  ring: Keyring,
  ids: ObjectIds,
  plain: Uint8Array,
): SealedObject {
  const dataKey = newDataKey()
  const bytes = gcmSeal(dataKey, plain, OBJECT_KEY.aad(ids))
  const sealedKey = wrapKey(OBJECT_KEY, ring, ids, dataKey)
  // ⚠ CHECKED HERE, before the row is written or the object uploaded.
  if (!openObject(ring, ids, bytes, sealedKey).equals(plain)) {
    throw new Error("a sealed file does not open to the original")
  }
  return { bytes, sealedKey }
}

export function openObject(
  ring: Keyring,
  ids: ObjectIds,
  sealed: Uint8Array,
  sealedKey: string,
): Buffer {
  const dataKey = unwrapKey(OBJECT_KEY, ring, ids, sealedKey)
  try {
    return gcmOpen(dataKey, sealed, OBJECT_KEY.aad(ids))
  } catch {
    throw new Error(`stored file ${ids.sha256} does not open`)
  }
}

/**
 * ⚠ AN `IN (...)` LIST, NEVER `= any(${array})`. Drizzle expands an array
 * parameter to `($1, $2)` - a ROW, not an array - which works with one element
 * and breaks on the second.
 */
export const inList = (values: readonly string[]): SQL =>
  sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )

/**
 * Files by hash, opened: one query for the keys, then one GET per file.
 *
 * ⚠ LOUD WHEN IT CANNOT. No store, no `OBJECT_KEYS`, no row, or bytes that do
 * not open: each is a file we cannot show or resend as it was sent. Errors name
 * the hash and never a key.
 */
export async function readObjects(
  db: Database,
  store: ContentStore | null,
  tenantId: string,
  hashes: readonly string[],
): Promise<Map<string, Buffer>> {
  const wanted = [...new Set(hashes)]
  if (wanted.length === 0) return new Map()
  if (!store) {
    throw new Error(
      "message has files in the content store, and no content store is configured",
    )
  }
  const ring = store.objectKeys
  if (!ring) {
    throw new Error(
      "message has files in the content store, and OBJECT_KEYS is not set",
    )
  }
  // ⚠ A SHORT TRANSACTION OF ITS OWN, so the reads from R2 below hold nothing
  // open in Postgres.
  const rows = (await withTenant(db, tenantId, (tx) =>
    tx.execute(sql`
      select sha256, sealed_key from core.content_objects
       where tenant_id = ${tenantId}::uuid and sha256 in (${inList(wanted)})
    `),
  )) as unknown as { sha256: string; sealed_key: string }[]
  const keys = new Map(rows.map((r) => [r.sha256, r.sealed_key]))
  const opened = await Promise.all(
    wanted.map(async (sha256) => {
      const sealedKey = keys.get(sha256)
      if (!sealedKey) throw new Error(`stored file ${sha256} has no key`)
      const sealed = await store.get(objectKey(tenantId, sha256))
      return [
        sha256,
        openObject(ring, { tenantId, sha256 }, sealed, sealedKey),
      ] as const
    }),
  )
  return new Map(opened)
}
