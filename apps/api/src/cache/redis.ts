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

/**
 * The connection the send queues run on.
 *
 * ⚠ A SECOND CLIENT WITH THE OPPOSITE FAILURE POLICY, NOT A SHARED ONE. The
 * cache above is allowed to fail — an error there is a miss. This one is a
 * dependency: a batch that cannot be enqueued waits for the stale-message sweep
 * instead of going out now, so it is worth retrying and worth queueing commands
 * across a reconnect. One client cannot hold both policies, which is why there
 * are two.
 *
 * groupmq's worker duplicates this client for its blocking `bzpopmin` with
 * `maxRetriesPerRequest: null` of its own, so these settings govern the
 * enqueue and bookkeeping commands rather than the block.
 */
export function createQueueClient(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: 5,
    enableOfflineQueue: true,
    connectTimeout: 5000,
  })
}

export function redisKeyCache(client: Redis): KeyCache {
  return {
    get: (key) => client.get(key),
    set: async (key, value, ttlSeconds) => {
      await client.set(key, value, "EX", ttlSeconds)
    },
    /**
     * ⚠ THIS IS WHAT MAKES REVOCATION IMMEDIATE RATHER THAN EVENTUAL. Without an
     * eviction the floor on withdrawing a leaked key is the TTL, which is the
     * behaviour self-issuing the keys was meant to remove. Redis is shared
     * across every API pod, so one delete reaches all of them.
     *
     * ⚠ AND A FAILURE HERE IS NOT SWALLOWED BY THE CALLER. Unlike a get or a
     * set — where an error is a miss and costs one lookup — a delete that
     * silently failed would leave a revoked key working for the rest of its TTL
     * while the route reported success.
     */
    del: async (key) => {
      await client.del(key)
    },
  }
}
