# Redis

## What is deployed

- **`i10-redis`** (`infra/k8s/i10/redis/redis.yaml`): `redis:8.10-alpine`, one
  replica, `maxmemory 384mb`, **`maxmemory-policy noeviction`**, AOF with
  `appendfsync everysec` plus RDB snapshots. It holds the groupmq send and
  webhook queues, and also the API's caches and rate limits.
- **Keep** (`infra/k8s/i10/stalwart/keep.yaml`) holds Stalwart's counters. It
  evicts under its cap. It is not Redis and speaks its own protocol. The repo
  rule is one instance per eviction policy.
- **Two client policies** (`apps/api/src/cache/redis.ts`):
  `createCacheClient` fails open (`maxRetriesPerRequest: 1`, no offline queue,
  2 s connect timeout): an error is a cache miss, never a refused customer.
  `createQueueClient` retries and queues across a reconnect, because a lost
  enqueue delays a send. Never use one client for both.

## What belongs in Redis instead of Postgres

| Belongs in Redis | Why |
| --- | --- |
| Rate-limit windows (`identity/rate-limit.ts`: `INCR`, then `EXPIRE` on the first hit) | one write per request, with a TTL. In Postgres that is a hot row |
| Cooldowns, one-time throttles (`console/code-cooldown.ts`) | short-lived and lossy by design |
| Caches of expensive lookups (the API-key verification cache, `API_KEY_CACHE_TTL_SECONDS`, default and maximum 3600 s in `apps/api/src/env.ts`) | read often, cheap to rebuild |
| Queue scheduling (groupmq) | Postgres stays the record, see below |

**Never only in Redis:** anything needed after a Redis restart or a lost write.
That covers billing and usage (`core.meter_events`), message state
(`core.messages`, where the sweep re-enqueues rows that no job points at), access
decisions, and anything a customer was told succeeded. AOF `everysec` can lose
about a second of writes, so design for losing them.

## Every cache, counter, rate-limit and lock key has a TTL

`i10-redis` is `noeviction`. When memory reaches `maxmemory`, Redis refuses
write commands with an OOM error instead of evicting (Redis docs, "Key
eviction"). The queues share that memory. So a cache key without a TTL, or a key
per user that is never deleted, ends in sends and webhooks failing to enqueue.

⚠ **Queue keys are the exception, and must NEVER get a TTL.** groupmq's job
hashes and its ready, delayed and group sets hold jobs that have not run yet: an
expiry would drop a pending send or webhook with no error anywhere. Their memory
is bounded by the queue's own lifecycle: jobs leave when they are processed, and
completed and failed jobs are trimmed by each queue's `keepCompleted` and `keepFailed` (apps/api/src/queue/). A change
that adds a queue, or keeps more completed or failed jobs, states that retention
and its memory at the brief's scale instead of a TTL.

- Set the TTL in the same command: `SET key value EX <seconds>`, not `SET`
  then `EXPIRE`. For counters, `INCR` then `EXPIRE` when the result is 1 is the
  repo's pattern. A crash between the two leaves a key with no TTL, so fixed
  windows should use a key that names the window (`...:<epoch minute>`) as a
  backstop.
- State the key count and size at the brief's scale in the PR: keys times bytes
  must stay a small part of 384 MB.
- Prefix every key by feature (`sso:rate:`) so it can be counted with `SCAN
  MATCH` (never `KEYS` in production, it blocks the server).

## Cache-aside, done right

1. Read the cache. On a hit, return.
2. On a miss, read Postgres, then `SET ... EX ttl`.
3. **Version the key** when the cached shape or meaning changes:
   `apikey:v2:<hash>`. A deploy then never reads an entry the old code wrote.
4. **Cache only answers that may be served stale for the whole TTL.** The API
   key cache stores only successes. A rejection cached for the TTL would refuse a
   key created a moment ago (`auth/api-key.ts`).
5. **Negative caching** (remembering "not found") needs a short TTL and an
   explicit delete on create, or a new row stays invisible for the TTL. Use it
   only to stop repeated lookups of names that cannot exist (abuse, typos).

### Stampedes

When a hot key expires, every request misses at once and all of them hit
Postgres. Use the cheapest fix that holds:

- **Jittered TTL:** `ttl * (0.9 + 0.2 * random())`, so keys written together do
  not expire together.
- **Single flight in the process:** concurrent misses for one key share one
  promise. authd does this for binds ("One verification per burst" in
  `services/authd/README.md`).
- **Early refresh:** when a hit's remaining TTL is under 10%, one caller
  refreshes it in the background (claimed with `SET lock:<key> 1 NX EX 5`) while
  the others keep serving the old value.
- A lock in Redis is a hint, not a guarantee, because it expires while the
  holder may still be running. Anything that must happen once is guarded in
  Postgres (a compare-and-set, as `db/claim.ts` does).

## Access decisions: instant invalidation or no cache

A cached "yes, allowed" outlives the access it describes unless every path that
removes access deletes it. This repo's rule (`services/authd/README.md`, "The
credential cache"): a long cache is acceptable only because revocation does not
wait for it.

- **Every path that removes access invalidates in the same change, with a test.**
  For authd that is a column on `authd.accounts` read before the cache, a moved
  `clerk_updated_at`, or a raised `credential_epoch`. For API keys it is a
  `del` on revoke, and that delete's failure is NOT swallowed.
- A new feature that removes access (members, mailboxes, domains, billing
  holds, SSO, SCIM) must say in the PR how it reaches every cache of that access.
- Put the version or epoch of what the decision depends on into the cached
  entry or its key, so a change in Postgres makes old entries stop matching
  without a delete to forget.
- Never cache a refusal or an "unavailable" for long. A corrected password or
  a restored provider would stay broken.

## Memory and persistence

- `maxmemory` must stay below the container's memory limit, with room for
  fork-time copy-on-write during an RDB save or AOF rewrite.
- Big values (whole payloads, large lists) are cheaper in Postgres or R2 with a
  small pointer in Redis.
- Lua scripts are cached per server and lost on restart. groupmq does not reload
  them, which is why `createQueueClient` wraps `evalsha` to reload on
  `NOSCRIPT`. Any new code that uses `EVALSHA` needs the same.

Sources: Redis docs, "Key eviction" (`maxmemory-policy`, `noeviction`), `SET`
(`EX`, `NX`), `INCR` (the rate-limiter pattern), "Redis persistence" (AOF
`everysec`); repo files cited above.
