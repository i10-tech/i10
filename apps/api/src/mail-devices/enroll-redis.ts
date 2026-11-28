import { hostname } from "node:os"
import { randomBytes } from "node:crypto"
import { sql } from "drizzle-orm"
import { Redis } from "ioredis"
import type { Database } from "../db/client.js"
import type { MailDeviceEnrollmentsDeps } from "../routes/console/deps.js"
import { DEFAULT_ENROLL_LINK_BASE_URL } from "./enroll-constants.js"
import { newUuidV7, signEdgeLinkToken, type EdgeLinkKeyRing } from "./link-token.js"
import type { MailDeviceEnrolledNotifier } from "./notice.js"
import {
  mintRefusal,
  readMailboxTenant,
  type MailDevicePlatform,
  type MintGateAccount,
} from "./store.js"
// ⚠ THE SAME FILES GO RUNS (services/authd/internal/enrollredis/lua, go:embed),
// so the scripts production runs here are the scripts the Go tests and
// enrollload exercise. bun inlines them into dist/ at build time.
import cancelSessionLua from "../../../../services/authd/internal/enrollredis/lua/cancel_session.lua" with { type: "text" }
import createSessionLua from "../../../../services/authd/internal/enrollredis/lua/create_session.lua" with { type: "text" }

/**
 * Enrollment session store and post-seal notice consumer backed by the
 * dedicated, diskless `i10-enroll-redis` instance
 * (docs/research/enrollment-at-scale.md).
 *
 * Design invariants (db-guard references/redis.md):
 *   - POST /console/mail-devices/enrollments runs ONE read-only SELECT against
 *     `authd.accounts` + `mintRefusal` (0 transactions, 0 locks, 0 Postgres
 *     writes), then ONE atomic Lua script on `i10-enroll-redis`.
 *   - Every key written carries a positive TTL (`enroll:sess:<eid>` 1h,
 *     `enroll:user:<uid>` 30m).
 *   - Every key a Lua script touches is passed in `KEYS[]` and belongs strictly
 *     to the `api` Redis ACL (`enroll:sess:*`, `enroll:user:*`, `enroll:notice`;
 *     read-only `enroll:scep:refusal:*`), see infra/k8s/i10/redis/enroll-redis.yaml.
 *   - Redis unreachable or OOM (`maxmemory-policy noeviction`) fails closed
 *     with 503 (`enrollment_unavailable`) - never falls back to Postgres.
 *   - Because `i10-enroll-redis` is diskless, a Redis restart between Phase 4
 *     seal and notice send can drop an in-flight `enroll:notice` entry.
 */

/** The session's own window to FIRST attest (M4). */
export const ENROLLMENT_ATTEST_WINDOW_MS = 15 * 60 * 1000
/**
 * The M4 hard cap: no attest retry after creation + 30 minutes. ⚠ THE LINK IS
 * SIGNED FOR THIS, NOT FOR THE ATTEST WINDOW: enrolld and enrollctl check its
 * expiry before anything else, so a 15 minute link would refuse the Phase 1
 * reload or Phase 2 retry that M4 allows up to 30. The session itself still
 * refuses a first attest after 15 minutes.
 */
export const ENROLLMENT_HARD_CAP_MS = 30 * 60 * 1000

const SESSION_REDIS_TTL_SEC = 3600 // 1 hour
const USER_LIVE_TTL_SEC = 1800 // 30 minutes (M4 hard cap)
const NOTICE_STREAM_KEY = "enroll:notice"
const NOTICE_CONSUMER_GROUP = "i10-api"
const DEFAULT_NOTICE_BLOCK_MS = 2000
const DEFAULT_NOTICE_CLAIM_IDLE_MS = 30_000
const DEFAULT_NOTICE_RECLAIM_EVERY_MS = 30_000
/** A notice delivered this many times without an ACK is logged and dropped. */
export const NOTICE_MAX_DELIVERIES = 10

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type EnrollmentStatus =
  "open" | "attested" | "sealed" | "refused" | "expired" | "cancelled"

export interface EnrollmentView {
  id: string
  status: EnrollmentStatus
  expiresAt: Date
  refusal: string | null
  platform: MailDevicePlatform | null
  model: string | null
  deviceName: string | null
  deviceId: string | null
  needsMailSetup: boolean
}

export type CreateEnrollmentResult =
  | { ok: true; id: string; url: string; expiresAt: Date }
  | { ok: false; status: 409 | 503; code: string }

export type CancelEnrollmentOutcome = "cancelled" | "already_sealed" | "not_found"

export interface EnrolledNoticePayload {
  email: string
  deviceId: string
  platform: MailDevicePlatform
  model: string
  serialLast4: string
}

/** Raised when i10-enroll-redis fails on GET/DELETE so routes fail closed with 503. */
export class EnrollRedisUnavailableError extends Error {
  constructor(message = "enrollment Redis unavailable") {
    super(message)
    this.name = "EnrollRedisUnavailableError"
  }
}

/** JSON shape stored in `enroll:sess:<eid>` (shared verbatim with Go `enrollredis.Session`). */
export interface RedisSessionRecord {
  id: string
  clerk_user_id: string
  email: string
  tenant_id?: string | null
  expected_epoch: number
  created_by: string
  status: EnrollmentStatus
  refusal?: string
  serial?: string
  product?: string
  os_version?: string
  device_name?: string
  udid_sha256?: string
  apple_signer_sha256?: string
  platform?: MailDevicePlatform
  device_id?: string
  scep_chal_hash?: string
  created_at_ms: number
  expires_at_ms: number
  updated_at_ms: number
}

// ── Atomic Lua scripts (strictly touching api ACL keys: enroll:sess:*, enroll:user:*) ──

/** create_session.lua: cancel the person's live enrollment (M5), create the new one. */
const SCRIPT_CREATE_SESSION: string = createSessionLua
/** cancel_session.lua: cancel an open or attested enrollment of this person. */
const SCRIPT_CANCEL_SESSION: string = cancelSessionLua

/**
 * Dedicated ioredis client for `i10-enroll-redis` (`api` ACL user).
 * Fail-fast settings ensure Redis outages return 503 promptly instead of
 * stalling console requests.
 */
export function createEnrollRedisClient(config: {
  url: string
  username?: string
  password?: string
  blocking?: boolean
}): Redis {
  const client = new Redis(config.url, {
    ...(config.username ? { username: config.username } : {}),
    ...(config.password ? { password: config.password } : {}),
    // ⚠ THE `api` ACL USER MAY RUN ONLY THE COMMANDS THIS FILE SENDS: no INFO
    // (ioredis's ready check) and no CLIENT SETINFO.
    enableReadyCheck: false,
    disableClientInfo: true,
    // ⚠ RESP2, AS THE GO CLIENTS USE. ioredis 6 defaults to RESP3, where
    // `call("XREADGROUP")` answers the stream map flattened
    // (`[stream, entries]`, not `[[stream, entries]]`), and the notice consumer
    // then reads nothing and says nothing (enroll-redis-redis.test.ts).
    protocol: 2,
    maxRetriesPerRequest: config.blocking ? null : 1,
    enableOfflineQueue: Boolean(config.blocking),
    connectTimeout: 2000,
    ...(config.blocking ? {} : { commandTimeout: 3000 }),
    lazyConnect: false,
  })
  return client
}

/** Narrow Redis command subset needed by `createEnrollRedisStore` (easy to mock in unit tests). */
export interface EnrollRedisLike {
  get(key: string): Promise<string | null>
  call(command: string, ...args: (string | number)[]): Promise<unknown>
}

async function runLuaScript(
  redis: EnrollRedisLike,
  cache: Map<string, string>,
  name: string,
  lua: string,
  keys: readonly string[],
  argv: readonly (string | number)[],
): Promise<unknown> {
  let sha = cache.get(name)
  if (!sha) {
    sha = String(await redis.call("SCRIPT", "LOAD", lua))
    cache.set(name, sha)
  }
  try {
    return await redis.call("EVALSHA", sha, keys.length, ...keys, ...argv)
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("NOSCRIPT")) {
      const reloaded = String(await redis.call("SCRIPT", "LOAD", lua))
      cache.set(name, reloaded)
      return await redis.call("EVALSHA", reloaded, keys.length, ...keys, ...argv)
    }
    throw err
  }
}

/**
 * Read-only account gate query (no transaction, no FOR NO KEY UPDATE, no DB
 * write). Matches `lockGateAccount` in `store.ts` column-for-column.
 * Correctness never depends on this read staying fresh: `enrollctl` Phase 4
 * re-checks every invariant under the `authd.accounts` lock before minting.
 */
export async function readGateAccount(
  db: Pick<Database, "execute">,
  clerkUserId: string,
): Promise<MintGateAccount | null> {
  const [row] = (await db.execute(sql`
    select a.clerk_user_id,
           a.email,
           a.active,
           a.tenant_id::text as tenant_id,
           a.credential_epoch,
           (a.suspended_at is not null) as suspended,
           (a.payment_hold_at is not null) as payment_hold,
           (a.deleting_at is not null) as deleting,
           a.banned,
           (a.locked and (a.locked_until is null or a.locked_until > now())) as locked,
           core.mailbox_domain_refused(a.tenant_id, lower(split_part(a.email, '@', 2))) as domain_not_hosted,
           (m.clerk_user_id is not null) as managed,
           m.connection_id::text as managed_connection,
           (pv.active is false) as connection_inactive,
           exists (
             select 1 from authd.required_domains rd
              where rd.domain = lower(split_part(a.email, '@', 2))
                and rd.tenant_id = a.tenant_id
           ) as sso_required,
           exists (
             select 1 from authd.required_domains rd
               join authd.required_exempt ex
                 on ex.connection_id = rd.connection_id
                and ex.tenant_id = rd.tenant_id
              where rd.domain = lower(split_part(a.email, '@', 2))
                and rd.tenant_id = a.tenant_id
                and ex.clerk_user_id = a.clerk_user_id
           ) as sso_exempt
      from authd.accounts a
      left join authd.managed_accounts m on m.clerk_user_id = a.clerk_user_id
      left join authd.passthrough_versions pv on pv.connection_id = m.connection_id
     where a.clerk_user_id = ${clerkUserId}`)) as unknown as MintGateAccount[]
  return row ?? null
}

const sessionKey = (eid: string) => `enroll:sess:${eid}`
const userLiveKey = (uid: string) => `enroll:user:${uid}`
/** Written by cahookrelay, which may not write sessions; read-only here. */
const scepRefusalKey = (eid: string) => `enroll:scep:refusal:${eid}`

export interface EnrollRedisLog {
  warn(fields: Record<string, unknown>, message: string): void
  error(fields: Record<string, unknown>, message: string): void
}

/**
 * Builds the `MailDeviceEnrollmentsDeps` backed by `i10-enroll-redis` + signed
 * edge link tokens.
 */
export function createEnrollRedisStore(deps: {
  db: Pick<Database, "execute">
  redis: EnrollRedisLike
  edgeLinkKeys: EdgeLinkKeyRing
  linkBaseUrl?: string
  log: EnrollRedisLog
  now?: () => Date
}): MailDeviceEnrollmentsDeps {
  const baseUrl = (deps.linkBaseUrl ?? DEFAULT_ENROLL_LINK_BASE_URL).replace(/\/$/, "")
  const now = deps.now ?? (() => new Date())
  const scriptShas = new Map<string, string>()

  return {
    mailboxTenant: ({ clerkUserId }) => readMailboxTenant(deps.db, clerkUserId),

    create: async ({ clerkUserId, tenantId }): Promise<CreateEnrollmentResult> => {
      const account = await readGateAccount(deps.db, clerkUserId)
      if (!account) {
        return { ok: false, status: 409, code: "no_mailbox" }
      }
      const expectedEpoch = Number(account.credential_epoch)
      const refusal = mintRefusal(account, { tenantId, expectedEpoch })
      if (refusal) {
        return { ok: false, status: 409, code: refusal.code }
      }

      const createdAt = now()
      const expiresAt = new Date(createdAt.getTime() + ENROLLMENT_ATTEST_WINDOW_MS)
      const eid = newUuidV7(createdAt)
      const token = signEdgeLinkToken(
        deps.edgeLinkKeys,
        eid,
        new Date(createdAt.getTime() + ENROLLMENT_HARD_CAP_MS),
      )

      const record: RedisSessionRecord = {
        id: eid,
        clerk_user_id: account.clerk_user_id,
        email: account.email.toLowerCase(),
        ...(account.tenant_id !== null ? { tenant_id: account.tenant_id } : {}),
        expected_epoch: expectedEpoch,
        created_by: account.clerk_user_id,
        status: "open",
        created_at_ms: createdAt.getTime(),
        expires_at_ms: expiresAt.getTime(),
        updated_at_ms: createdAt.getTime(),
      }
      const recordJson = JSON.stringify(record)

      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          const prevEid =
            (await deps.redis.get(userLiveKey(account.clerk_user_id))) ?? ""
          const keys = [sessionKey(eid), userLiveKey(account.clerk_user_id)]
          if (prevEid) keys.push(sessionKey(prevEid))
          const reply = await runLuaScript(
            deps.redis,
            scriptShas,
            "create_session",
            SCRIPT_CREATE_SESSION,
            keys,
            [
              eid,
              recordJson,
              SESSION_REDIS_TTL_SEC,
              USER_LIVE_TTL_SEC,
              prevEid,
              createdAt.getTime(),
            ],
          )
          if (reply === "OK") {
            return {
              ok: true,
              id: eid,
              url: `${baseUrl}/${token}`,
              expiresAt,
            }
          }
          if (typeof reply === "string" && reply.startsWith("RETRY:")) {
            continue
          }
          throw new Error(`unexpected CreateSession reply: ${String(reply)}`)
        }
        throw new Error("CreateSession concurrent modification retry limit")
      } catch (err) {
        // Never log the link token, session JSON, or Redis credentials.
        deps.log.error(
          { err: err instanceof Error ? err.message : "redis_error" },
          "enrollment create failed on enroll-redis",
        )
        return { ok: false, status: 503, code: "enrollment_unavailable" }
      }
    },

    get: async ({ id, clerkUserId }): Promise<EnrollmentView | null> => {
      if (!UUID_RE.test(id)) return null
      let raw: string | null
      let scepRefusal: string | null
      try {
        ;[raw, scepRefusal] = await Promise.all([
          deps.redis.get(sessionKey(id)),
          deps.redis.get(scepRefusalKey(id)),
        ])
      } catch (err) {
        deps.log.error(
          { err: err instanceof Error ? err.message : "redis_error" },
          "enrollment get failed on enroll-redis",
        )
        throw new EnrollRedisUnavailableError()
      }
      if (!raw) return null
      let sess: RedisSessionRecord
      try {
        sess = JSON.parse(raw) as RedisSessionRecord
      } catch {
        return null
      }
      if (sess.clerk_user_id !== clerkUserId) return null

      // A live session shows the SCEP refusal cahookrelay recorded (it may not
      // write the session; enrollctl applies it at the next attest or finish).
      const live = sess.status === "open" || sess.status === "attested"
      const pastExpiry = now().getTime() >= sess.expires_at_ms
      let effectiveStatus: EnrollmentStatus = sess.status
      let refusal = sess.refusal ?? null
      if (live && scepRefusal) {
        effectiveStatus = "refused"
        refusal = scepRefusal
      } else if (live && pastExpiry) {
        effectiveStatus = "expired"
      }

      return {
        id: sess.id,
        status: effectiveStatus,
        expiresAt: new Date(sess.expires_at_ms),
        refusal,
        platform: sess.platform ?? null,
        model: sess.product ?? null,
        deviceName: sess.device_name ?? null,
        deviceId: sess.device_id ?? null,
        needsMailSetup: sess.status === "sealed" && sess.platform === "macos",
      }
    },

    cancel: async ({ id, clerkUserId }): Promise<CancelEnrollmentOutcome> => {
      if (!UUID_RE.test(id)) return "not_found"
      try {
        const reply = await runLuaScript(
          deps.redis,
          scriptShas,
          "cancel_session",
          SCRIPT_CANCEL_SESSION,
          [sessionKey(id), userLiveKey(clerkUserId)],
          [id, clerkUserId, now().getTime(), SESSION_REDIS_TTL_SEC],
        )
        if (
          reply === "cancelled" ||
          reply === "already_sealed" ||
          reply === "not_found"
        ) {
          return reply
        }
        throw new Error(`unexpected CancelSession reply: ${String(reply)}`)
      } catch (err) {
        deps.log.error(
          { err: err instanceof Error ? err.message : "redis_error" },
          "enrollment cancel failed on enroll-redis",
        )
        throw new EnrollRedisUnavailableError()
      }
    },
  }
}

// ── enroll:notice stream consumer ─────────────────────────────────────────────

export interface NoticeStreamRedis {
  call(command: string, ...args: (string | number)[]): Promise<unknown>
  quit?(): Promise<unknown>
}

export interface EnrollNoticeConsumerHandle {
  /** Processes one XREADGROUP batch (and optional XAUTOCLAIM). Exported for tests. */
  pollOnce(options?: { reclaim?: boolean }): Promise<number>
  /** Stops the background polling loop cleanly and waits for the current pass to finish. */
  stop(): Promise<void>
}

type StreamEntry = [id: string, fields: string[]]

function parseNoticeFields(fields: string[]): EnrolledNoticePayload | null {
  const map = new Map<string, string>()
  for (let i = 0; i + 1 < fields.length; i += 2) {
    map.set(fields[i]!, fields[i + 1]!)
  }
  const deviceId = map.get("deviceId")
  const email = map.get("email")
  const platform = map.get("platform")
  const model = map.get("model") ?? "Apple device"
  const serialLast4 = map.get("serialLast4") ?? ""
  if (
    !deviceId ||
    !email ||
    (platform !== "ios" && platform !== "ipados" && platform !== "macos")
  ) {
    return null
  }
  return { deviceId, email, platform, model, serialLast4 }
}

/**
 * Consumes `enroll:notice` from `i10-enroll-redis` using consumer group
 * `i10-api`, delivering each post-seal notification email via
 * `mailDeviceEnrolledNotifier` (idempotency key `mail-device-enrolled:<deviceId>`)
 * and XACKing ONLY after delivery succeeds. Stale un-acked entries from crashed
 * pods are reclaimed via XAUTOCLAIM.
 *
 * ⚠ THE GROUP STARTS AT `0`, NOT `$`. These are security notices ("a device
 * was added to your mailbox"). After the diskless Redis restarts, enrollctl may
 * write a notice before any API pod has re-created the group; `$` would skip it.
 *
 * ⚠ THE RECLAIM CURSOR ADVANCES. XAUTOCLAIM answers a page and the id to start
 * the next one from; restarting at `0-0` every pass would re-read the same
 * first page for ever and never reach an older entry behind it. The cursor
 * wraps to `0-0` when XAUTOCLAIM says the scan is complete.
 *
 * ⚠ A POISON ENTRY CANNOT WEDGE THE STREAM. An entry delivered
 * NOTICE_MAX_DELIVERIES times (XPENDING's count) is logged at ERROR with its
 * device id and acknowledged without another send. Each reclaimed entry's
 * count is read on its own (`XPENDING <id> <id> 1`): a range over the claimed
 * ids would also return this consumer's other pending entries between them and
 * miss a claimed one. A count that cannot be read skips the entry this tick.
 *
 * Trade-off: `i10-enroll-redis` is diskless (`save ""`, `appendonly no`), so a
 * Redis restart between Phase 4 seal and notice send can drop an unconsumed
 * notice.
 */
export function startEnrollNoticeConsumer(deps: {
  redis: NoticeStreamRedis
  notify: MailDeviceEnrolledNotifier
  log: EnrollRedisLog
  consumerName?: string
  blockMs?: number
  claimIdleMs?: number
  reclaimEveryMs?: number
  maxDeliveries?: number
  /** Set false in unit tests to drive `pollOnce()` deterministically. */
  autoStart?: boolean
}): EnrollNoticeConsumerHandle {
  const consumer =
    deps.consumerName ??
    `${hostname()}-${process.pid}-${randomBytes(4).toString("hex")}`
  const blockMs = deps.blockMs ?? DEFAULT_NOTICE_BLOCK_MS
  const claimIdleMs = deps.claimIdleMs ?? DEFAULT_NOTICE_CLAIM_IDLE_MS
  const reclaimEveryMs = deps.reclaimEveryMs ?? DEFAULT_NOTICE_RECLAIM_EVERY_MS
  const maxDeliveries = deps.maxDeliveries ?? NOTICE_MAX_DELIVERIES

  let groupReady = false
  let stopped = false
  let lastReclaimAt = 0
  let reclaimCursor = "0-0"

  async function ensureGroup(): Promise<void> {
    if (groupReady) return
    try {
      await deps.redis.call(
        "XGROUP",
        "CREATE",
        NOTICE_STREAM_KEY,
        NOTICE_CONSUMER_GROUP,
        "0",
        "MKSTREAM",
      )
      groupReady = true
    } catch (err) {
      if (err instanceof Error && err.message.includes("BUSYGROUP")) {
        groupReady = true
        return
      }
      throw err
    }
  }

  async function ack(entryId: string): Promise<void> {
    await deps.redis.call("XACK", NOTICE_STREAM_KEY, NOTICE_CONSUMER_GROUP, entryId)
  }

  /**
   * Sends and acks entries. `deliveries` holds the reclaimed entries' delivery
   * counts; null for a fresh read (each entry's first delivery).
   */
  async function processEntries(
    entries: StreamEntry[],
    deliveries: ReadonlyMap<string, number> | null,
  ): Promise<number> {
    let acked = 0
    for (const [entryId, fields] of entries) {
      if (!entryId || !Array.isArray(fields)) continue
      const payload = parseNoticeFields(fields)
      if (!payload) {
        // Malformed entry can never succeed; ack it so it does not loop forever.
        deps.log.warn({ entryId }, "dropping malformed enroll:notice stream entry")
        await ack(entryId)
        continue
      }
      const delivered = deliveries === null ? 1 : deliveries.get(entryId)
      if (delivered === undefined) continue // count unknown: retry next tick
      if (delivered >= maxDeliveries) {
        // Never log the email address.
        deps.log.error(
          { entryId, deviceId: payload.deviceId, deliveries: delivered },
          "dropping enroll:notice entry after too many failed deliveries; the device-added email was NOT sent",
        )
        await ack(entryId)
        continue
      }
      try {
        await deps.notify(payload)
        await ack(entryId)
        acked++
      } catch (err) {
        // Leave un-acked so XAUTOCLAIM retries it; never log email addresses.
        deps.log.warn(
          {
            entryId,
            deviceId: payload.deviceId,
            err: err instanceof Error ? err.message : "send_failed",
          },
          "failed to send mail device enrolled notice; leaving pending for retry",
        )
      }
    }
    return acked
  }

  /**
   * XPENDING's delivery count for each claimed entry (now ours), one
   * `XPENDING <id> <id> 1 <consumer>` per id, sent together (at most 20, the
   * XAUTOCLAIM page). An id whose count cannot be read is left out.
   */
  async function deliveryCounts(entries: StreamEntry[]): Promise<Map<string, number>> {
    const ids = entries.map(([id]) => id).filter(Boolean)
    const rows = await Promise.all(
      ids.map(
        (id) =>
          deps.redis.call(
            "XPENDING",
            NOTICE_STREAM_KEY,
            NOTICE_CONSUMER_GROUP,
            id,
            id,
            1,
            consumer,
          ) as Promise<[string, string, number, number][] | null>,
      ),
    )
    const counts = new Map<string, number>()
    rows.forEach((pending, i) => {
      const row = pending?.[0]
      if (Array.isArray(row) && String(row[0]) === ids[i]) {
        const n = Number(row[3])
        if (Number.isFinite(n)) counts.set(ids[i]!, n)
      }
    })
    return counts
  }

  async function reclaim(): Promise<number> {
    const claimed = (await deps.redis.call(
      "XAUTOCLAIM",
      NOTICE_STREAM_KEY,
      NOTICE_CONSUMER_GROUP,
      consumer,
      claimIdleMs,
      reclaimCursor,
      "COUNT",
      20,
    )) as [string, StreamEntry[], ...unknown[]] | null
    if (!Array.isArray(claimed)) return 0
    reclaimCursor = typeof claimed[0] === "string" ? claimed[0] : "0-0"
    const entries = Array.isArray(claimed[1]) ? claimed[1] : []
    if (entries.length === 0) return 0
    return processEntries(entries, await deliveryCounts(entries))
  }

  async function pollOnce(options?: { reclaim?: boolean }): Promise<number> {
    await ensureGroup()
    let acked = 0

    // 1. Reclaim stale pending entries left behind by crashed replicas.
    const shouldReclaim =
      options?.reclaim ?? Date.now() - lastReclaimAt >= reclaimEveryMs
    if (shouldReclaim) {
      lastReclaimAt = Date.now()
      acked += await reclaim()
    }

    // 2. Read fresh entries.
    const res = (await deps.redis.call(
      "XREADGROUP",
      "GROUP",
      NOTICE_CONSUMER_GROUP,
      consumer,
      "COUNT",
      20,
      "BLOCK",
      blockMs,
      "STREAMS",
      NOTICE_STREAM_KEY,
      ">",
    )) as [string, StreamEntry[]][] | null

    if (Array.isArray(res)) {
      for (const [, entries] of res) {
        if (Array.isArray(entries) && entries.length > 0) {
          acked += await processEntries(entries, null)
        }
      }
    }
    return acked
  }

  let loopPromise: Promise<void> | null = null
  if (deps.autoStart !== false) {
    loopPromise = (async () => {
      while (!stopped) {
        try {
          await pollOnce()
        } catch (err) {
          if (stopped) break
          groupReady = false
          deps.log.warn(
            { err: err instanceof Error ? err.message : "stream_error" },
            "enroll:notice consumer poll failed; backing off",
          )
          await new Promise((resolve) => setTimeout(resolve, 2000))
        }
      }
    })()
  }

  return {
    pollOnce,
    stop: async () => {
      stopped = true
      try {
        await deps.redis.quit?.()
      } catch {
        // ignore shutdown errors on blocking connection
      }
      if (loopPromise) {
        await loopPromise
      }
    },
  }
}
