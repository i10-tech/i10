import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import type { Database } from "../src/db/client.js"
import { MailDeviceError, parseMailDeviceCodeKeys } from "../src/mail-devices/code.js"
import {
  createEnrollRedisStore,
  type EnrollRedisLike,
  type RedisSessionRecord,
} from "../src/mail-devices/enroll-redis.js"
import { parseEdgeLinkKeys } from "../src/mail-devices/link-token.js"
import {
  dbDeviceStore,
  mailDeviceService,
  type DeviceViewer,
} from "../src/mail-devices/service.js"
import { mint } from "../src/mail-devices/store.js"

/**
 * Who sees and revokes which mail devices (#383 PR 5), against Postgres: the
 * `DeviceScope` filter in the store is the tenant boundary (authd has no RLS),
 * and the service picks the scope.
 *
 *   TEMPLATES_TEST_DATABASE_URL=postgres://i10:i10@localhost:5433/i10 bun test test/mail-devices-service-db.test.ts
 */
const URL = process.env.TEMPLATES_TEST_DATABASE_URL
const API_URL = URL?.replace(/\/\/[^@]+@/, "//i10_api:i10_api@")
const suite = URL ? describe : describe.skip

let owner: ReturnType<typeof postgres>
let sqlApi: ReturnType<typeof postgres>
let db: Database
/** Every statement the API connection sent, for the query counts. */
const seen: string[] = []

const acme = crypto.randomUUID()
const rival = crypto.randomUUID()
const sfx = acme.slice(0, 8)
const acmeDomain = `acme-${sfx}.test`
const rivalDomain = `rival-${sfx}.test`

const admin = `user_mds_admin_${sfx}`
const ada = `user_mds_ada_${sfx}`
const bob = `user_mds_bob_${sfx}`
/** i10's own domain: no workspace on the account. */
const solo = `user_mds_solo_${sfx}`
const rivalAdmin = `user_mds_rival_${sfx}`
const people = [admin, ada, bob, solo, rivalAdmin]
const addressOf: Record<string, string> = {
  [admin]: `admin@${acmeDomain}`,
  [ada]: `ada@${acmeDomain}`,
  [bob]: `bob@${acmeDomain}`,
  [solo]: `solo@i10-${sfx}.test`,
  [rivalAdmin]: `boss@${rivalDomain}`,
}
const tenantOf: Record<string, string | null> = {
  [admin]: acme,
  [ada]: acme,
  [bob]: acme,
  [solo]: null,
  [rivalAdmin]: rival,
}

const audit: object[] = []
const service = () =>
  mailDeviceService({
    store: dbDeviceStore(db),
    log: { info: (o) => audit.push(o) },
  })

const acmeAdmin: DeviceViewer = { userId: admin, tenantId: acme, isAdmin: true }
const adaInAcme: DeviceViewer = { userId: ada, tenantId: acme, isAdmin: false }
const rivalBoss: DeviceViewer = { userId: rivalAdmin, tenantId: rival, isAdmin: true }
/** solo is signed in to the console in acme as a member, but their mailbox is i10's. */
const soloInAcme: DeviceViewer = { userId: solo, tenantId: acme, isAdmin: false }

const sha = (s: string) => createHash("sha256").update(s).digest()

const TEST_KEYS = parseMailDeviceCodeKeys(
  "1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=,7:gIGCg4SFhoeIiYqLjI2Oj5CRkpOUlZaXmJmam5ydnp+goaKjpKWmp6ipqqusra6v",
)

const epochOf = async (person: string) =>
  Number(
    (
      await owner<{ credential_epoch: string | number }[]>`
        select credential_epoch from authd.accounts where clerk_user_id = ${person}`
    )[0]!.credential_epoch,
  )

async function addDevice(
  person: string,
  opts: {
    createdAt?: string
    platform?: string
    key?: boolean
    /** Set as enrollctl's mint sets it, for a device that came from an enrollment. */
    enrollmentId?: string
  } = {},
): Promise<string> {
  const [row] = await owner`
    insert into authd.mail_devices
      (clerk_user_id, email, tenant_id, platform, device_name, code_hash, code_kid,
       created_by, created_at, cert_key_sha256, enrollment_id)
    values (${person}, ${addressOf[person]!}, ${tenantOf[person]!}, ${opts.platform ?? "ios"},
            ${`${person} phone`}, ${randomBytes(32)}, 1, 'test',
            ${opts.createdAt ?? new Date().toISOString()}::timestamptz,
            ${opts.key ? randomBytes(32) : null}, ${opts.enrollmentId ?? null}::uuid)
    returning id::text as id`
  return row!.id as string
}

/** An enrollment-minted device, inserted inside the caller's transaction. */
async function addDeviceIn(
  tx: postgres.TransactionSql,
  person: string,
  enrollmentId: string,
): Promise<string> {
  const [row] = await tx`
    insert into authd.mail_devices
      (clerk_user_id, email, tenant_id, platform, code_hash, code_kid, created_by, enrollment_id)
    values (${person}, ${addressOf[person]!}, ${tenantOf[person]!}, 'ios', ${randomBytes(32)}, 1,
            ${person}, ${enrollmentId}::uuid)
    returning id::text as id`
  return row!.id as string
}

const idsOf = async (person: string) =>
  (
    await owner`select id::text as id from authd.mail_devices where clerk_user_id = ${person} order by id`
  ).map((r) => r.id as string)

/** The ids a list answered, or the outcome when it was not a page. */
async function listed(
  viewer: DeviceViewer,
  query: Parameters<ReturnType<typeof service>["list"]>[1],
) {
  const outcome = await service().list(viewer, query)
  return outcome.status === "ok" ? outcome.page.data.map((d) => d.id) : outcome.status
}

async function counted<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; queries: number }> {
  seen.length = 0
  const result = await fn()
  return { result, queries: seen.length }
}

suite("mail device service against Postgres", () => {
  beforeAll(async () => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    sqlApi = postgres(API_URL!, {
      max: 2,
      onnotice: () => {},
      debug: (_conn, query) => seen.push(query),
    })
    db = drizzle({ client: sqlApi }) as unknown as Database

    for (const [id, name] of [
      [acme, "Acme"],
      [rival, "Rival"],
    ] as const) {
      await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id, clerk_org_id)
                  values (${id}, ${`mds-${id.slice(0, 8)}`}, ${name}, ${`owner-${id}`}, ${`org_mds_${id.slice(0, 8)}`})`
    }
    for (const [tenant, name] of [
      [acme, acmeDomain],
      [rival, rivalDomain],
    ] as const) {
      await owner`insert into core.domains (tenant_id, name, hosts_mailboxes, verified_at, status)
                  values (${tenant}, ${name}, true, now(), 'verified')`
    }
    for (const person of people) {
      await owner`insert into authd.accounts (clerk_user_id, email, active, tenant_id)
                  values (${person}, ${addressOf[person]!}, true, ${tenantOf[person]!})`
    }
  })

  beforeEach(async () => {
    audit.length = 0
    await owner`delete from authd.mail_devices where clerk_user_id = any(${people})`
  })

  afterAll(async () => {
    try {
      await owner`delete from authd.mail_devices where clerk_user_id = any(${people})`
      await owner`delete from authd.accounts where clerk_user_id = any(${people})`
      await owner`delete from core.tenants where id in (${acme}, ${rival})`
    } finally {
      await owner.end()
      await sqlApi.end()
    }
  })

  it("a member lists only their own devices; another member's address and the workspace are 404", async () => {
    const adaPhone = await addDevice(ada)
    await addDevice(bob)

    expect(await listed(adaInAcme, { scope: "mine" })).toEqual([adaPhone])
    expect(
      await listed(adaInAcme, { scope: "mine", address: addressOf[ada]! }),
    ).toEqual([adaPhone])
    expect(await listed(adaInAcme, { scope: "mine", address: addressOf[bob]! })).toBe(
      "not_found",
    )
    expect(await listed(adaInAcme, { scope: "workspace" })).toBe("not_found")
    // An address with no account answers exactly as another person's does.
    expect(
      await listed(adaInAcme, { scope: "mine", address: `nobody@${acmeDomain}` }),
    ).toBe("not_found")
  })

  it("a member cannot revoke another member's device, even knowing its id", async () => {
    const bobPhone = await addDevice(bob)
    expect(await service().revoke(adaInAcme, bobPhone)).toBeNull()
    expect(await idsOf(bob)).toEqual([bobPhone])
    expect(audit).toEqual([])
  })

  it("an admin lists and revokes any device of their workspace, and none of another's", async () => {
    const adaPhone = await addDevice(ada)
    const rivalPhone = await addDevice(rivalAdmin)

    expect(await listed(acmeAdmin, { scope: "workspace" })).toEqual([adaPhone])
    expect(
      await listed(acmeAdmin, { scope: "mine", address: addressOf[ada]! }),
    ).toEqual([adaPhone])
    expect(
      await listed(acmeAdmin, { scope: "mine", address: addressOf[rivalAdmin]! }),
    ).toBe("not_found")

    expect(await service().revoke(acmeAdmin, rivalPhone)).toBeNull()
    expect(await idsOf(rivalAdmin)).toEqual([rivalPhone])
    expect(await service().revoke(rivalBoss, adaPhone)).toBeNull()
    expect(await idsOf(ada)).toEqual([adaPhone])

    const gone = await service().revoke(acmeAdmin, adaPhone)
    expect(gone?.id).toBe(adaPhone)
    expect(await idsOf(ada)).toEqual([])
    expect(audit).toEqual([
      {
        audit: "mail_device.revoked",
        tenantId: acme,
        actorUserId: admin,
        userId: ada,
        deviceId: adaPhone,
        address: addressOf[ada],
      },
    ])
  })

  it("own devices on i10's own domain (no workspace) are the person's, and never the workspace's", async () => {
    const soloPhone = await addDevice(solo)

    expect(await listed(soloInAcme, { scope: "mine" })).toEqual([soloPhone])
    expect(await listed(acmeAdmin, { scope: "workspace" })).toEqual([])
    expect(await listed(acmeAdmin, { scope: "mine", address: addressOf[solo]! })).toBe(
      "not_found",
    )
    expect(await service().revoke(acmeAdmin, soloPhone)).toBeNull()

    expect((await service().revoke(soloInAcme, soloPhone))?.id).toBe(soloPhone)
    expect(await idsOf(solo)).toEqual([])
    // The audit names the device's workspace (none), not the console's.
    expect(audit.at(-1)).toMatchObject({ audit: "mail_device.revoked", tenantId: null })
  })

  it("own scope follows the account's workspace now: a device left from an old one is not listed", async () => {
    // A row the projection would have reconciled away; the scope must not show it.
    const stale = await addDevice(ada)
    await owner`update authd.mail_devices set tenant_id = ${rival} where id = ${stale}`
    expect(await listed(adaInAcme, { scope: "mine" })).toEqual([])
    expect(await listed(rivalBoss, { scope: "workspace" })).toEqual([stale])
  })

  it("revoke-all signs out only the caller's devices", async () => {
    const adaOne = await addDevice(ada)
    const adaTwo = await addDevice(ada, { platform: "macos", key: true })
    const bobPhone = await addDevice(bob)
    const soloPhone = await addDevice(solo)

    expect(await service().revokeAll(adaInAcme)).toEqual({ status: "ok", revoked: 2 })
    expect(await idsOf(ada)).toEqual([])
    expect(await idsOf(bob)).toEqual([bobPhone])
    expect(await idsOf(solo)).toEqual([soloPhone])
    expect(audit).toEqual([
      {
        audit: "mail_device.revoked_all",
        tenantId: acme,
        actorUserId: ada,
        userId: ada,
        address: null,
        deviceIds: expect.arrayContaining([adaOne, adaTwo]),
      },
    ])

    // A member naming someone else is refused, and nothing moves.
    expect(await service().revokeAll(adaInAcme, addressOf[bob]!)).toEqual({
      status: "not_found",
    })
    expect(await idsOf(bob)).toEqual([bobPhone])
  })

  it("revoke-all waits for a mint holding the account lock, and ends its device too", async () => {
    let minted = ""
    let revoking: Promise<unknown> | undefined
    await owner.begin(async (tx) => {
      // What mint does: account lock first, then the insert.
      await tx`select 1 from authd.accounts where clerk_user_id = ${ada} for no key update`
      const [row] = await tx`
        insert into authd.mail_devices
          (clerk_user_id, email, tenant_id, platform, code_hash, code_kid, created_by)
        values (${ada}, ${addressOf[ada]!}, ${tenantOf[ada]!}, 'ios', ${randomBytes(32)}, 1, 'test')
        returning id::text as id`
      minted = row!.id as string
      revoking = service().revokeAll(adaInAcme)
      await Bun.sleep(150)
    })
    expect(await revoking).toEqual({ status: "ok", revoked: 1 })
    expect(minted).not.toBe("")
    expect(await idsOf(ada)).toEqual([])
  })

  it("revoke-all raises credential_epoch by exactly one", async () => {
    const adaBefore = await epochOf(ada)
    const bobBefore = await epochOf(bob)
    await addDevice(ada)

    expect(await service().revokeAll(adaInAcme)).toEqual({ status: "ok", revoked: 1 })
    expect(await epochOf(ada)).toBe(adaBefore + 1)
    expect(await epochOf(bob)).toBe(bobBefore)
  })

  it("refuses a mint that read the epoch before revoke-all, and inserts nothing", async () => {
    const expectedEpoch = await epochOf(ada)
    expect(await service().revokeAll(adaInAcme)).toEqual({ status: "ok", revoked: 0 })

    // ⚠ Catch directly rather than `expect(...).rejects` (hangs postgres.js under bun).
    let code: string | null = null
    try {
      await mint(db, TEST_KEYS, {
        clerkUserId: ada,
        tenantId: acme,
        expectedEpoch,
        platform: "ios",
        deviceName: "Stale Phone",
        createdBy: "test",
      })
    } catch (error) {
      code = error instanceof MailDeviceError ? error.code : String(error)
    }
    expect(code).toBe("epoch_mismatch")
    expect(await idsOf(ada)).toEqual([])
  })

  it("a live enrollment opened before revoke-all carries the old epoch, which enrollctl's locked read no longer has", async () => {
    // The enrollment is a session in the enrollment Redis (I10-62). This port
    // records the create script's arguments and answers OK; it keeps no state.
    const written: RedisSessionRecord[] = []
    const redis: EnrollRedisLike = {
      get: async () => null,
      call: async (command, ...args) => {
        if (command === "SCRIPT") return "sha-create"
        // EVALSHA sha numkeys ...keys eid recordJson ...
        const numKeys = Number(args[1])
        written.push(JSON.parse(String(args[2 + numKeys + 1])) as RedisSessionRecord)
        return "OK"
      },
    }
    const enrollments = createEnrollRedisStore({
      db,
      redis,
      edgeLinkKeys: parseEdgeLinkKeys("1:AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA="),
      log: { warn: () => {}, error: () => {} },
    })

    const before = await epochOf(ada)
    const created = await enrollments.create({ clerkUserId: ada, tenantId: acme })
    expect(created.ok).toBe(true)
    expect(written.map((r) => r.expected_epoch)).toEqual([before])

    expect(await service().revokeAll(adaInAcme)).toEqual({ status: "ok", revoked: 0 })

    // What enrollctl's batcher reads under the account lock before it mints
    // (services/authd/internal/enrollctl/batcher.go, lockAndLoadAccounts): the
    // raised epoch, which its mint gate refuses as epoch_mismatch
    // (batcher_test.go, "epoch moved").
    const locked = await owner.begin(
      (tx) => tx<{ credential_epoch: string | number }[]>`
        select credential_epoch from authd.enroll_lock_gate_accounts(array[${ada}]::text[])`,
    )
    expect(locked.map((r) => Number(r.credential_epoch))).toEqual([before + 1])
    expect(await idsOf(ada)).toEqual([])
  })

  it("revoke-all waits for enrollctl's account lock, and ends the device it minted", async () => {
    let minted = ""
    let revoking: Promise<unknown> | undefined
    await owner.begin(async (tx) => {
      // What enrollctl's batcher does: the gate function locks the account
      // FOR SHARE, then it inserts the device.
      await tx`select 1 from authd.enroll_lock_gate_accounts(array[${ada}]::text[])`
      minted = await addDeviceIn(tx, ada, crypto.randomUUID())
      revoking = service().revokeAll(adaInAcme)
      await Bun.sleep(150)
    })
    expect(await revoking).toEqual({ status: "ok", revoked: 1 })
    expect(minted).not.toBe("")
    expect(await idsOf(ada)).toEqual([])
  })

  it("an admin's revoke-all for an address reaches one person of their workspace only", async () => {
    await addDevice(ada)
    const bobPhone = await addDevice(bob)
    const rivalPhone = await addDevice(rivalAdmin)

    expect(await service().revokeAll(acmeAdmin, addressOf[ada]!)).toEqual({
      status: "ok",
      revoked: 1,
    })
    expect(await idsOf(ada)).toEqual([])
    expect(await idsOf(bob)).toEqual([bobPhone])

    expect(await service().revokeAll(acmeAdmin, addressOf[rivalAdmin]!)).toEqual({
      status: "not_found",
    })
    expect(await service().revokeAll(acmeAdmin, addressOf[solo]!)).toEqual({
      status: "not_found",
    })
    expect(await idsOf(rivalAdmin)).toEqual([rivalPhone])
  })

  it("revokes an enrolled device in its owner's scope, and takes its liveness rows with it", async () => {
    const mac = await addDevice(ada, {
      platform: "macos",
      key: true,
      enrollmentId: crypto.randomUUID(),
    })
    await owner`insert into authd.mail_device_cert_binds (device_id, addr, key_sha256)
                values (${mac}, '192.0.2.1/32', ${sha(`bind/${mac}`)})`

    expect(await service().revoke(adaInAcme, mac)).toMatchObject({
      id: mac,
      clerkUserId: ada,
      tenantId: acme,
    })
    const [left] = await owner`
      select (select count(*)::int from authd.mail_devices where id = ${mac}) as devices,
             (select count(*)::int from authd.mail_device_cert_binds where device_id = ${mac}) as binds`
    expect(left).toEqual({ devices: 0, binds: 0 })
  })

  it("never returns a code hash or a key hash, only whether a key is bound", async () => {
    await addDevice(ada, { platform: "macos", key: true })
    const outcome = await service().list(adaInAcme, { scope: "mine" })
    if (outcome.status !== "ok") throw new Error(outcome.status)
    const [device] = outcome.page.data
    expect(device?.has_certificate_key).toBe(true)
    expect(Object.keys(device!).sort()).toEqual(
      [
        "object",
        "id",
        "email",
        "platform",
        "device_name",
        "model",
        "serial",
        "created_at",
        "first_used_at",
        "last_used_at",
        "created_by",
        "has_certificate_key",
      ].sort(),
    )
  })

  it("pages newest first by created_at then id, across rows a millisecond would not tell apart", async () => {
    // Three rows inside one millisecond, two of them at the same microsecond.
    const a = await addDevice(ada, { createdAt: "2026-11-26T10:00:00.123400Z" })
    const b = await addDevice(ada, { createdAt: "2026-11-26T10:00:00.123456Z" })
    const c = await addDevice(ada, { createdAt: "2026-11-26T10:00:00.123456Z" })
    const [first, second] = [b, c].sort().reverse()

    const walked: string[] = []
    let cursor: string | undefined
    for (let i = 0; i < 5; i++) {
      const outcome = await service().list(adaInAcme, {
        scope: "mine",
        limit: 1,
        ...(cursor ? { cursor } : {}),
      })
      if (outcome.status !== "ok") throw new Error(outcome.status)
      walked.push(...outcome.page.data.map((d) => d.id))
      if (!outcome.page.next_cursor) break
      cursor = outcome.page.next_cursor
    }
    expect(walked).toEqual([first!, second!, a])

    expect(await listed(adaInAcme, { scope: "mine", cursor: "not-a-cursor" })).toBe(
      "invalid",
    )
  })

  it("sends one statement per list and revoke, whatever the number of devices", async () => {
    for (const n of [1, 30]) {
      await owner`delete from authd.mail_devices where clerk_user_id = any(${people})`
      const ids: string[] = []
      for (let i = 0; i < n; i++) ids.push(await addDevice(ada))

      expect(
        (await counted(() => service().list(adaInAcme, { scope: "mine" }))).queries,
      ).toBe(1)
      expect(
        (await counted(() => service().list(acmeAdmin, { scope: "workspace" })))
          .queries,
      ).toBe(1)
      // An address costs one more: which account it is.
      expect(
        (
          await counted(() =>
            service().list(acmeAdmin, { scope: "mine", address: addressOf[ada]! }),
          )
        ).queries,
      ).toBe(2)
      expect((await counted(() => service().revoke(adaInAcme, ids[0]!))).queries).toBe(
        1,
      )
      // An admin's revoke tries the open workspace first, so a workspace device is 1 statement.
      if (n > 1)
        expect(
          (await counted(() => service().revoke(acmeAdmin, ids[1]!))).queries,
        ).toBe(1)
      // begin, the credential-epoch update, the delete, commit: none grows with the devices.
      expect((await counted(() => service().revokeAll(adaInAcme))).queries).toBe(4)
    }
  })
})
