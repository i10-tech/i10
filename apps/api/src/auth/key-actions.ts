import { cacheKeyFor, type KeyCache } from "./api-key.js"
import type { CreatedKey, KeyStore } from "./store.js"

/**
 * Revoking and rotating a key, as the console's key routes and the
 * deprovisioning flow (#345) both do it.
 *
 * ⚠ ONE PATH, SO THE TWO CANNOT DRIFT. Revocation is two acts - the row and
 * the Redis entry - and a copy that forgot the second would leave a key the
 * admin was told is dead working for up to the cache TTL.
 */
export interface KeyActionDeps {
  store: KeyStore
  cache?: KeyCache
}

export type RevokeResult =
  | { status: "revoked" }
  | { status: "not_found" }
  /** The row is revoked; the cache entry could not be removed. Retry converges. */
  | { status: "cache_failed" }

export async function revokeKey(
  keys: KeyActionDeps,
  tenantId: string,
  id: string,
  log: { error: (o: object, m: string) => void },
): Promise<RevokeResult> {
  const revoked = await keys.store.revoke(tenantId, id)
  if (!revoked) return { status: "not_found" }
  /*
   * ⚠ THE CACHE EVICTION IS HALF OF REVOCATION AND ITS FAILURE IS AN ERROR.
   * A verified key lives in Redis for the TTL; without deleting that entry
   * the key keeps working for up to a minute after the customer was told it
   * was dead. Reporting success while a leaked credential is still live is
   * the worst possible answer - they stop looking. The row stays revoked, so
   * a retry converges.
   */
  if (keys.cache) {
    try {
      await keys.cache.del(cacheKeyFor(revoked.secretHash))
    } catch (error) {
      log.error(
        { err: String(error), tenantId, keyId: id },
        "revoked a key but could not evict it from the cache",
      )
      return { status: "cache_failed" }
    }
  }
  return { status: "revoked" }
}

export type RotateResult =
  { status: "rotated"; created: CreatedKey } | { status: "not_found" }

export async function rotateKey(
  keys: KeyActionDeps,
  tenantId: string,
  id: string,
  log: { error: (o: object, m: string) => void },
  options?: { createdBy?: string | null },
): Promise<RotateResult> {
  const rotated = await keys.store.rotate(tenantId, id, options)
  if (!rotated) return { status: "not_found" }
  if (keys.cache) {
    try {
      await keys.cache.del(cacheKeyFor(rotated.revokedHash))
    } catch (error) {
      // The new key is minted and the old one revoked in the row; the cache
      // entry lapses within its TTL, and failing here would hide the secret
      // that exists nowhere else.
      log.error(
        { err: String(error), tenantId },
        "rotated a key but could not evict the old one from the cache",
      )
    }
  }
  return { status: "rotated", created: rotated.created }
}
