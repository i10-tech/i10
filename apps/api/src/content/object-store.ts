import { S3Client } from "bun"
import type { Env } from "../env.js"

/**
 * Where message content lives once it leaves Postgres (#136, #168, #188): the
 * private `i10-content` bucket in R2, through Bun's own S3 client.
 *
 * ⚠ BUN'S CLIENT, NOT `@aws-sdk/client-s3`. Every process that uses this runs
 * on Bun, and its client is built in - one dependency fewer in an image that
 * already bundles the SES SDK, and nothing for `bun build` to drop.
 *
 * ⚠ NEVER A PUBLIC URL, NEVER A PRESIGNED ONE HANDED OUT. Customers reach
 * content only through our API, behind the tenant check; the bucket has no
 * custom domain and no r2.dev URL.
 */
export interface ObjectStore {
  put(key: string, bytes: Uint8Array, contentType?: string): Promise<void>
  get(key: string): Promise<Uint8Array>
  delete(key: string): Promise<void>
}

/**
 * `<tenant_id>/sha256/<hex>`.
 *
 * ⚠ THE TENANT FIRST, AND THE HASH IS THE WHOLE REST. Two workspaces sending
 * the same file get two objects: dedup is per workspace (#171), because a
 * shared object would tell one workspace that another had sent it.
 */
export const objectKey = (tenantId: string, sha256: string) =>
  `${tenantId}/sha256/${sha256}`

/** The configured store, or `null` when the four settings are unset. */
export function objectStoreFrom(
  env: Pick<
    Env,
    | "CONTENT_STORE_ENDPOINT"
    | "CONTENT_STORE_BUCKET"
    | "CONTENT_STORE_ACCESS_KEY_ID"
    | "CONTENT_STORE_SECRET_ACCESS_KEY"
  >,
): ObjectStore | null {
  if (
    !env.CONTENT_STORE_ENDPOINT ||
    !env.CONTENT_STORE_BUCKET ||
    !env.CONTENT_STORE_ACCESS_KEY_ID ||
    !env.CONTENT_STORE_SECRET_ACCESS_KEY
  ) {
    return null
  }
  return r2Store(
    new S3Client({
      endpoint: env.CONTENT_STORE_ENDPOINT,
      bucket: env.CONTENT_STORE_BUCKET,
      accessKeyId: env.CONTENT_STORE_ACCESS_KEY_ID,
      secretAccessKey: env.CONTENT_STORE_SECRET_ACCESS_KEY,
      // R2 has one region and it is called `auto`.
      region: "auto",
    }),
  )
}

export function r2Store(client: S3Client): ObjectStore {
  return {
    async put(key, bytes, contentType) {
      await client.write(key, bytes, {
        type: contentType ?? "application/octet-stream",
      })
    },
    async get(key) {
      return new Uint8Array(await client.file(key).arrayBuffer())
    },
    // ⚠ IDEMPOTENT: deleting a missing key succeeds, which is what lets a sweep
    // that died between the delete and its commit simply run again.
    async delete(key) {
      await client.delete(key)
    },
  }
}

/** For tests: the same contract, in memory. */
export function memoryStore(): ObjectStore & {
  objects: Map<string, Uint8Array>
  puts: number
} {
  const objects = new Map<string, Uint8Array>()
  const store = {
    objects,
    puts: 0,
    async put(key: string, bytes: Uint8Array) {
      store.puts++
      objects.set(key, bytes)
    },
    async get(key: string) {
      const found = objects.get(key)
      if (!found) throw new Error(`no such object: ${key}`)
      return found
    },
    async delete(key: string) {
      objects.delete(key)
    },
  }
  return store
}
