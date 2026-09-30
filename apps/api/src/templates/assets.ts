import { createHash } from "node:crypto"
import { and, eq, sql } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import { templateAssets as assets } from "../db/core.js"
import type { ObjectStore } from "../content/object-store.js"

/**
 * Images for templates (#244): uploaded in the visual editor, served publicly
 * from the template assets bucket so that the emails can load them.
 *
 * ⚠ A SEPARATE, PUBLIC BUCKET. Message content lives in a private one that is
 * never reachable without the API; these are the opposite, since every
 * recipient's mail client fetches them. R2 tokens cannot be scoped to a
 * prefix, so the separation is a bucket.
 *
 * ⚠ THE TYPE IS READ FROM THE BYTES, AND ONLY FOUR ARE TAKEN. The name and the
 * declared type are whatever the browser said. SVG is refused outright: it is
 * a document that can carry script, served from a host we own.
 */

/** Largest image taken. Under the console's 5 MB action limit with room to spare. */
export const MAX_ASSET_BYTES = 4 * 1024 * 1024

const TYPES = [
  {
    type: "image/png",
    ext: "png",
    magic: (b: Uint8Array) =>
      starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  {
    type: "image/jpeg",
    ext: "jpg",
    magic: (b: Uint8Array) => starts(b, [0xff, 0xd8, 0xff]),
  },
  {
    type: "image/gif",
    ext: "gif",
    magic: (b: Uint8Array) =>
      starts(b, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
      starts(b, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]),
  },
  {
    type: "image/webp",
    ext: "webp",
    magic: (b: Uint8Array) =>
      starts(b, [0x52, 0x49, 0x46, 0x46]) &&
      b[8] === 0x57 &&
      b[9] === 0x45 &&
      b[10] === 0x42 &&
      b[11] === 0x50,
  },
] as const

function starts(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, i) => bytes[i] === byte)
}

/** The image's type from its first bytes, or null. */
export function sniffImage(bytes: Uint8Array): { type: string; ext: string } | null {
  const found = TYPES.find((t) => t.magic(bytes))
  return found ? { type: found.type, ext: found.ext } : null
}

/**
 * The workspace's folder in the bucket: a hash of its id, not the id.
 *
 * ⚠ THE URL IS PUBLIC AND GOES OUT IN EVERY EMAIL. It must not name the
 * workspace, and it must still be one prefix per workspace so a deletion can
 * find everything. A fixed-salt hash is both.
 */
export function assetFolder(tenantId: string): string {
  return createHash("sha256")
    .update(`i10-template-assets:${tenantId}`)
    .digest("hex")
    .slice(0, 32)
}

export interface Asset {
  url: string
  sha256: string
  content_type: string
  size: number
}

export interface TemplateAssets {
  /**
   * The origin images are served from, e.g. `https://assets.i10.tech`: what a
   * preview's CSP lets images load from without asking (#248).
   */
  origin: string
  upload(
    tenantId: string,
    bytes: Uint8Array,
  ): Promise<{ ok: true; asset: Asset } | { ok: false; problem: string }>
  /** Deletes the images of deleted workspaces; returns how many. */
  sweepDeleted(limit?: number): Promise<number>
}

export function templateAssetStore(deps: {
  db: Database
  store: ObjectStore
  publicUrl: string
}): TemplateAssets {
  const base = deps.publicUrl.replace(/\/+$/, "")
  const urlOf = (key: string) => `${base}/${key}`

  return {
    origin: new URL(base).origin,
    async upload(tenantId, bytes) {
      if (bytes.byteLength === 0) return { ok: false, problem: "The file is empty." }
      if (bytes.byteLength > MAX_ASSET_BYTES) {
        return {
          ok: false,
          problem: `Images may be at most ${MAX_ASSET_BYTES / 1024 / 1024} MB. Smaller images also load faster in inboxes.`,
        }
      }
      const kind = sniffImage(bytes)
      if (!kind) {
        return {
          ok: false,
          problem: "Only PNG, JPEG, GIF and WebP images can be used in emails.",
        }
      }
      const sha256 = createHash("sha256").update(bytes).digest("hex")
      const key = `${assetFolder(tenantId)}/${sha256}.${kind.ext}`
      const asset = {
        url: urlOf(key),
        sha256,
        content_type: kind.type,
        size: bytes.byteLength,
      }

      // ⚠ THE SAME IMAGE AGAIN WRITES NOTHING: the row says the object is there.
      const [existing] = await withTenant(deps.db, tenantId, (tx) =>
        tx
          .select({ key: assets.key })
          .from(assets)
          .where(and(eq(assets.tenantId, tenantId), eq(assets.sha256, sha256)))
          .limit(1),
      )
      if (existing) return { ok: true, asset: { ...asset, url: urlOf(existing.key) } }

      // ⚠ THE OBJECT FIRST, THEN THE ROW. A row must never name a missing
      // object; an object without a row is only a second upload's cost.
      await deps.store.put(key, bytes, kind.type)
      await withTenant(deps.db, tenantId, (tx) =>
        tx
          .insert(assets)
          .values({
            tenantId,
            sha256,
            key,
            contentType: kind.type,
            size: bytes.byteLength,
          })
          .onConflictDoNothing(),
      )
      return { ok: true, asset }
    },

    async sweepDeleted(limit = 50) {
      const due = (await deps.db.execute(
        sql`select tenant_id from core.template_assets_orphaned(${limit})`,
      )) as unknown as { tenant_id: string }[]
      let deleted = 0
      for (const { tenant_id: tenantId } of due) {
        deleted += await withTenant(deps.db, tenantId, async (tx) => {
          const rows = await tx
            .select({ sha256: assets.sha256, key: assets.key })
            .from(assets)
            .where(eq(assets.tenantId, tenantId))
            .limit(1000)
            .for("update", { skipLocked: true })
          // R2 first: a delete that succeeds with a commit that then fails
          // leaves a row for a missing object, and the next run deletes again.
          for (const row of rows) {
            await deps.store.delete(row.key)
            await tx
              .delete(assets)
              .where(and(eq(assets.tenantId, tenantId), eq(assets.sha256, row.sha256)))
          }
          return rows.length
        })
      }
      return deleted
    },
  }
}
