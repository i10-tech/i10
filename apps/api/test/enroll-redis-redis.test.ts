import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { drizzle } from "drizzle-orm/postgres-js"
import { Redis } from "ioredis"
import postgres from "postgres"
import type { Database } from "../src/db/client.js"
import {
  createEnrollRedisClient,
  createEnrollRedisStore,
  NOTICE_MAX_DELIVERIES,
  startEnrollNoticeConsumer,
  type EnrollRedisLog,
  type RedisSessionRecord,
} from "../src/mail-devices/enroll-redis.js"
import { parseEdgeLinkKeys } from "../src/mail-devices/link-token.js"
import type { MintGateAccount } from "../src/mail-devices/store.js"
import { raiseCredentialEpoch } from "../src/projection/credential-epoch.js"

/**
 * enroll-redis.ts against a real Redis, as the `api` ACL user rendered from
 * infra/k8s/i10/redis/enroll-redis.yaml, through the real ioredis client:
 *   - the handshake and every command the API sends are allowed by the ACL;
 *   - the shared Lua (create, cancel, M5) behaves as the Go tests say;
 *   - the session JSON the API writes is testdata/session-open.json (which Go
 *     decodes strictly), and the one Go writes (testdata/session-sealed.json)
 *     reads correctly here;
 *   - a SCEP refusal cahookrelay recorded shows as refused;
 *   - the notice group starts at 0, so a notice written first is still sent;
 *   - a notice a dead consumer read is reclaimed after the idle time and sent
 *     once; an entry at the delivery cap is acked and logged, unsent, even with
 *     this consumer's own non-idle entry pending between two reclaimed ones;
 *   - with a migrated Postgres too, an account's real 16-digit credential_epoch
 *     comes back from Redis exactly after every script the API runs.
 *
 *   ENROLL_TEST_REDIS_URL=redis://127.0.0.1:6379 \
 *   ENROLL_TEST_DATABASE_URL=postgres://i10:i10@127.0.0.1:5432/i10 \
 *     bun test test/enroll-redis-redis.test.ts
 *
 * ENROLL_TEST_DATABASE_URL is the owner's url; the test logs in as `i10_api`
 * itself. With ENROLL_TEST_REDIS_REQUIRED set (CI), a missing URL fails instead
 * of skipping.
 */
const url = process.env.ENROLL_TEST_REDIS_URL
const dbUrl = process.env.ENROLL_TEST_DATABASE_URL
if (process.env.ENROLL_TEST_REDIS_REQUIRED && (!url || !dbUrl)) {
  throw new Error(
    "ENROLL_TEST_REDIS_URL and ENROLL_TEST_DATABASE_URL are required (ENROLL_TEST_REDIS_REQUIRED is set)",
  )
}
const testdata = resolve(
  import.meta.dir,
  "../../../services/authd/internal/enrollredis/testdata",
)
const fixture = (name: string) =>
  JSON.parse(readFileSync(resolve(testdata, name), "utf8")) as RedisSessionRecord

function apiRules(): string[] {
  const yaml = readFileSync(
    resolve(import.meta.dir, "../../../infra/k8s/i10/redis/enroll-redis.yaml"),
    "utf8",
  )
  const block = /\n {2}users\.acl\.rules: \|\n((?: {4}.*\n)+)/.exec(yaml)?.[1]
  const line = block?.split("\n").find((l) => l.trim().startsWith("api "))
  if (!line) throw new Error("no api rules in enroll-redis.yaml")
  return line.trim().split(/\s+/).slice(1)
}

describe.skipIf(!url)("enroll-redis.ts on a real Redis as the api ACL user", () => {
  const suffix = randomBytes(6).toString("hex")
  const user = `acltest-api-ts-${suffix}`
  const password = `pw-${suffix}`
  let admin: Redis
  let api: Redis
  const ring = parseEdgeLinkKeys("1:AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=")
  const TENANT = "5d7e9c1a-3b2f-4a6d-8e0c-1f2a3b4c5d6e"
  const account = (clerkUserId: string): MintGateAccount => ({
    clerk_user_id: clerkUserId,
    email: "Ada@Acme.test",
    active: true,
    tenant_id: TENANT,
    credential_epoch: "1795872953432402",
    suspended: false,
    payment_hold: false,
    deleting: false,
    banned: false,
    locked: false,
    domain_not_hosted: false,
    managed: false,
    managed_connection: null,
    connection_inactive: false,
    sso_required: false,
    sso_exempt: false,
  })
  const log = { warn: () => {}, error: () => {} }
  // enableOfflineQueue is off (fail fast), so wait for the socket like the API
  // does by booting before it serves.
  const ready = (c: Redis) => new Promise<void>((done) => c.once("ready", () => done()))

  beforeAll(async () => {
    admin = new Redis(url!)
    await admin.call("ACL", "SETUSER", user, "on", `>${password}`, ...apiRules())
    api = createEnrollRedisClient({ url: url!, username: user, password })
    await ready(api)
  })
  afterAll(async () => {
    api?.disconnect()
    await admin?.call("ACL", "DELUSER", user)
    await admin?.quit()
  })

  it("creates, replaces (M5), shows, refuses and cancels sessions; writes the shared JSON", async () => {
    const uid = `user_ts_${suffix}`
    const created = new Date(1764300000000)
    const store = createEnrollRedisStore({
      db: { execute: async () => [account(uid)] } as never,
      redis: api,
      edgeLinkKeys: ring,
      log,
      now: () => created,
    })

    const c1 = await store.create({ clerkUserId: uid, tenantId: TENANT })
    if (!c1.ok) throw new Error(`create failed: ${JSON.stringify(c1)}`)
    const written = JSON.parse(
      (await admin.get(`enroll:sess:${c1.id}`))!,
    ) as RedisSessionRecord
    const open = fixture("session-open.json")
    expect({
      ...written,
      id: open.id,
      clerk_user_id: open.clerk_user_id,
      created_by: open.created_by,
    }).toEqual(open)

    const c2 = await store.create({ clerkUserId: uid, tenantId: TENANT })
    if (!c2.ok) throw new Error("second create failed")
    expect((await store.get({ id: c1.id, clerkUserId: uid }))?.status).toBe("cancelled")
    expect((await store.get({ id: c2.id, clerkUserId: uid }))?.status).toBe("open")
    expect(await store.get({ id: c2.id, clerkUserId: "user_someone_else" })).toBeNull()

    await admin.set(`enroll:scep:refusal:${c2.id}`, "bad_template", "EX", 60)
    expect(await store.get({ id: c2.id, clerkUserId: uid })).toMatchObject({
      status: "refused",
      refusal: "bad_template",
    })
    expect(await store.cancel({ id: c2.id, clerkUserId: uid })).toBe("cancelled")

    // The record Go writes, read through the API's view.
    const sealed = fixture("session-sealed.json")
    const sealedId = c1.id
    await admin.set(
      `enroll:sess:${sealedId}`,
      JSON.stringify({ ...sealed, id: sealedId, clerk_user_id: uid }),
      "EX",
      60,
    )
    expect(await store.get({ id: sealedId, clerkUserId: uid })).toEqual({
      id: sealedId,
      status: "sealed",
      expiresAt: new Date(sealed.expires_at_ms),
      refusal: null,
      platform: "macos",
      model: "Mac15,6",
      deviceName: "Ada's Mac",
      deviceId: sealed.device_id!,
      needsMailSetup: true,
    })
    expect(await store.cancel({ id: sealedId, clerkUserId: uid })).toBe(
      "already_sealed",
    )
  })

  describe.skipIf(!dbUrl)(
    "with the account's real credential_epoch from Postgres",
    () => {
      let owner: ReturnType<typeof postgres>
      let sqlApi: ReturnType<typeof postgres>
      let db: Database
      const tenant = crypto.randomUUID()
      const sfx = tenant.slice(0, 8)
      const uid = `user_ts_epoch_${sfx}`

      beforeAll(async () => {
        owner = postgres(dbUrl!, { max: 1, onnotice: () => {} })
        sqlApi = postgres(dbUrl!.replace(/\/\/[^@]+@/, "//i10_api:i10_api@"), {
          max: 1,
          onnotice: () => {},
        })
        db = drizzle({ client: sqlApi }) as unknown as Database
        await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id, clerk_org_id)
                  values (${tenant}, ${`er-${sfx}`}, 'Epoch', ${uid}, ${`org_er_${sfx}`})`
        await owner`insert into core.domains (tenant_id, name, hosts_mailboxes, verified_at, status)
                  values (${tenant}, ${`epoch-${sfx}.test`}, true, now(), 'verified')`
        // The column's default seeds the epoch from the clock, in microseconds.
        await owner`insert into authd.accounts (clerk_user_id, email, active, tenant_id)
                  values (${uid}, ${`ada@epoch-${sfx}.test`}, true, ${tenant})`
        await raiseCredentialEpoch(db, uid)
      })
      afterAll(async () => {
        try {
          await owner`delete from authd.accounts where clerk_user_id = ${uid}`
          await owner`delete from core.tenants where id = ${tenant}`
        } finally {
          await owner.end()
          await sqlApi.end()
        }
      })

      it("stores it as the same decimal string through create, the M5 cancel and cancel", async () => {
        const [row] = await owner<{ epoch: string }[]>`
        select credential_epoch::text as epoch from authd.accounts where clerk_user_id = ${uid}`
        const epoch = row!.epoch
        expect(epoch).toMatch(/^\d{16}$/)
        const stored = async (id: string) =>
          JSON.parse((await admin.get(`enroll:sess:${id}`))!) as RedisSessionRecord
        const store = createEnrollRedisStore({
          db,
          redis: api,
          edgeLinkKeys: ring,
          log,
        })

        const first = await store.create({ clerkUserId: uid, tenantId: tenant })
        if (!first.ok) throw new Error(`create failed: ${JSON.stringify(first)}`)
        expect(await stored(first.id)).toMatchObject({
          status: "open",
          expected_epoch: epoch,
        })

        // create_session.lua decodes and re-encodes the earlier session to cancel it.
        const second = await store.create({ clerkUserId: uid, tenantId: tenant })
        if (!second.ok)
          throw new Error(`second create failed: ${JSON.stringify(second)}`)
        expect(await stored(first.id)).toMatchObject({
          status: "cancelled",
          expected_epoch: epoch,
        })

        expect(await store.cancel({ id: second.id, clerkUserId: uid })).toBe(
          "cancelled",
        )
        expect(await stored(second.id)).toMatchObject({
          status: "cancelled",
          expected_epoch: epoch,
        })
      })
    },
  )

  it("starts the notice group at 0, so a notice written before the group exists is sent", async () => {
    const reader = createEnrollRedisClient({
      url: url!,
      username: user,
      password,
      blocking: true,
    })
    await admin.call("XGROUP", "DESTROY", "enroll:notice", "i10-api").catch(() => {})
    const deviceId = `ts-notice-${suffix}`
    await admin.xadd(
      "enroll:notice",
      "MAXLEN",
      "~",
      10000,
      "*",
      "deviceId",
      deviceId,
      "email",
      "ada@acme.test",
      "platform",
      "ios",
      "model",
      "iPhone17,2",
      "serialLast4",
      "1234",
    )

    const sent = new Set<string>()
    const consumer = startEnrollNoticeConsumer({
      redis: reader,
      notify: async (p) => void sent.add(p.deviceId),
      log,
      consumerName: `ts-${suffix}`,
      blockMs: 1,
      autoStart: false,
    })
    for (let i = 0; i < 600 && !sent.has(deviceId); i++) {
      await consumer.pollOnce({ reclaim: i === 0 })
    }
    expect(sent.has(deviceId)).toBe(true)
    await consumer.stop()
  }, 60_000)

  describe("reclaiming from a consumer that died", () => {
    const STREAM = "enroll:notice"
    const GROUP = "i10-api"
    const addNotice = (deviceId: string) =>
      admin.xadd(
        STREAM,
        "*",
        "deviceId",
        deviceId,
        "email",
        "ada@acme.test",
        "platform",
        "ios",
        "model",
        "iPhone17,2",
        "serialLast4",
        "1234",
      ) as Promise<string>
    // A fresh group at "$", so only this test's entries are in it.
    const freshGroup = async () => {
      await admin.call("XGROUP", "DESTROY", STREAM, GROUP).catch(() => {})
      await admin.call("XGROUP", "CREATE", STREAM, GROUP, "$", "MKSTREAM")
    }
    const readAs = (consumer: string) =>
      admin.call(
        "XREADGROUP",
        "GROUP",
        GROUP,
        consumer,
        "COUNT",
        100,
        "STREAMS",
        STREAM,
        ">",
      )
    const pendingOf = async (consumer: string) =>
      (
        (await admin.call("XPENDING", STREAM, GROUP, "-", "+", 100, consumer)) as [
          string,
        ][]
      ).map(([id]) => id)
    const consumerAs = (
      name: string,
      sent: string[],
      log: EnrollRedisLog = { warn: () => {}, error: () => {} },
    ) => {
      const reader = createEnrollRedisClient({
        url: url!,
        username: user,
        password,
        blocking: true,
      })
      return startEnrollNoticeConsumer({
        redis: reader,
        notify: async (p) => void sent.push(p.deviceId),
        log,
        consumerName: name,
        blockMs: 1,
        claimIdleMs: 200,
        autoStart: false,
      })
    }

    it("sends a dead consumer's notice once, after the idle time", async () => {
      await freshGroup()
      const deviceId = `ts-dead-${suffix}`
      const id = await addNotice(deviceId)
      await readAs(`dead-${suffix}`) // read, never acked: the pod died

      const sent: string[] = []
      const live = consumerAs(`live-${suffix}`, sent)
      await live.pollOnce({ reclaim: true })
      expect(sent).toEqual([]) // not idle long enough yet
      await Bun.sleep(250)
      await live.pollOnce({ reclaim: true })
      await live.pollOnce({ reclaim: true })
      expect(sent).toEqual([deviceId])
      expect(await pendingOf(`live-${suffix}`)).not.toContain(id)
      expect(await pendingOf(`dead-${suffix}`)).not.toContain(id)
      await live.stop()
    }, 30_000)

    it("drops entries at the delivery cap even with a non-idle entry of ours between them", async () => {
      await freshGroup()
      const liveName = `live2-${suffix}`
      const dead = `dead2-${suffix}`
      const a = await addNotice(`ts-poison-a-${suffix}`)
      const b = await addNotice(`ts-busy-b-${suffix}`)
      const c = await addNotice(`ts-poison-c-${suffix}`)
      await readAs(dead)
      // A and C have failed NOTICE_MAX_DELIVERIES - 1 times and sat idle; the
      // reclaim is their NOTICE_MAX_DELIVERIES-th delivery.
      for (const id of [a, c]) {
        await admin.call(
          "XCLAIM",
          STREAM,
          GROUP,
          dead,
          0,
          id,
          "IDLE",
          600_000,
          "RETRYCOUNT",
          NOTICE_MAX_DELIVERIES - 1,
        )
      }
      // B is this consumer's, and not idle: XAUTOCLAIM leaves it, but it sits
      // between A and C in this consumer's pending list.
      await admin.call("XCLAIM", STREAM, GROUP, liveName, 0, b)

      const sent: string[] = []
      const errors: unknown[] = []
      const live = consumerAs(liveName, sent, {
        warn: () => {},
        error: (fields) => void errors.push(fields),
      })
      await live.pollOnce({ reclaim: true })
      expect(sent).toEqual([])
      expect(await pendingOf(liveName)).toEqual([b])
      expect(errors).toMatchObject([
        {
          entryId: a,
          deviceId: `ts-poison-a-${suffix}`,
          deliveries: NOTICE_MAX_DELIVERIES,
        },
        {
          entryId: c,
          deviceId: `ts-poison-c-${suffix}`,
          deliveries: NOTICE_MAX_DELIVERIES,
        },
      ])
      await admin.call("XACK", STREAM, GROUP, b)
      await live.stop()
    }, 30_000)
  })
})
