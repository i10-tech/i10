// ⚠ A NAMED IMPORT. ioredis 6 still has a default export, but under
// NodeNext resolution the module namespace is what `import Redis from` binds,
// and TypeScript then reports "Cannot use namespace 'Redis' as a type" and
// "not constructable" — one mistake surfacing as two confusing errors.
import { Redis } from "ioredis"
import type { KeyCache } from "../auth/api-key.js"

/**
 * i10's Redis, shared with the queues.
 *
 * ⚠ THIS CONNECTION IS FOR CACHING ONLY, AND ITS FAILURES ARE NOT FATAL.
 * Everything reached through it treats an error as a miss, because the cache
 * exists to keep Clerk off the hot path — not to be a dependency of it. A Redis
 * outage should cost latency and Clerk quota, never a refused customer.
 *
 * `maxRetriesPerRequest: 1` is what makes that true. ioredis defaults to 20,
 * which turns a Redis outage into twenty backed-off retries per request and a
 * timeout far longer than simply asking Clerk would have taken.
 */
export function createCacheClient(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 2000,
    // Commands issued while disconnected fail fast rather than queueing, which
    // is the behaviour a fail-open cache wants.
    lazyConnect: false,
  })
}

export function redisKeyCache(client: Redis): KeyCache {
  return {
    get: (key) => client.get(key),
    set: async (key, value, ttlSeconds) => {
      await client.set(key, value, "EX", ttlSeconds)
    },
  }
}
