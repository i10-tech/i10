import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import postgres from "postgres"
import { pruneCertBinds } from "../src/mail-devices/prune.js"
import { createDb } from "../src/db/client.js"

/**
 * Schema invariants for `authd.mail_devices` (`cert_key_sha256`,
 * `enrollment_id` partial unique index, `acme_bound_at`) and
 * `authd.mail_device_cert_binds` (Mac liveness rows), exercised as `i10_api`.
 *
 *   TEMPLATES_TEST_DATABASE_URL=postgres://i10:i10@localhost:5433/i10 bun test test/mail-device-cert-db.test.ts
 */
const URL = process.env.TEMPLATES_TEST_DATABASE_URL
const API_URL = URL?.replace(/\/\/[^@]+@/, "//i10_api:i10_api@")
const suite = URL ? describe : describe.skip

let owner: ReturnType<typeof postgres>
let api: ReturnType<typeof postgres>

const sfx = crypto.randomUUID().slice(0, 8)
const person = `user_mdc_${sfx}`

function hash(label: string): Buffer {
  return new Bun.CryptoHasher("sha256").update(`${sfx}/${label}`).digest() as Buffer
}

async function broken(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run()
    return null
  } catch (error) {
    const e = error as { constraint_name?: string; message: string }
    return e.constraint_name ?? e.message
  }
}

let deviceId: string

suite("mail_devices certificate columns and liveness rows against Postgres", () => {
  beforeAll(async () => {
    owner = postgres(URL!, { max: 1, onnotice: () => {} })
    api = postgres(API_URL!, { max: 2, onnotice: () => {} })
    await owner`insert into authd.accounts (clerk_user_id, email, active)
                values (${person}, ${`mdc-${sfx}@mdc.test`}, true)`
    const [device] = await owner<{ id: string }[]>`
      insert into authd.mail_devices (clerk_user_id, email, platform, code_hash, code_kid, created_by)
      values (${person}, ${`mdc-${sfx}@mdc.test`}, 'macos', ${hash("code")}, 1, 'test')
      returning id::text`
    deviceId = device!.id
  })

  afterAll(async () => {
    await owner`delete from authd.accounts where clerk_user_id = ${person}`
    await api.end({ timeout: 5 })
    await owner.end({ timeout: 5 })
  })

  it("liveness rows: a /32 or a /64 only, a 32-byte key, one row per device and network", async () => {
    const key = hash("bind/key")
    for (const addr of ["192.0.2.7/32", "2001:db8:1:2::/64"]) {
      await api`insert into authd.mail_device_cert_binds (device_id, addr, key_sha256)
                values (${deviceId}, ${addr}, ${key})`
    }
    for (const addr of ["192.0.2.0/24", "2001:db8:1:2::1/128", "2001:db8::/48"]) {
      expect(
        await broken(
          () => api`insert into authd.mail_device_cert_binds (device_id, addr, key_sha256)
                    values (${deviceId}, ${addr}, ${key})`,
        ),
      ).toBe("mail_device_cert_binds_addr_check")
    }
    expect(
      await broken(
        () => api`insert into authd.mail_device_cert_binds (device_id, addr, key_sha256)
                  values (${deviceId}, '198.51.100.1/32', ${hash("bind/key").subarray(0, 31)})`,
      ),
    ).toBe("mail_device_cert_binds_key_length")
    expect(
      await broken(
        () => api`insert into authd.mail_device_cert_binds (device_id, addr, key_sha256)
                  values (${deviceId}, '192.0.2.7/32', ${key})`,
      ),
    ).toBe("mail_device_cert_binds_pkey")
    expect(
      await broken(
        () => api`insert into authd.mail_device_cert_binds (device_id, addr, key_sha256)
                  values (${crypto.randomUUID()}, '192.0.2.8/32', ${key})`,
      ),
    ).toBe("mail_device_cert_binds_device_fk")

    // Confirm i10_api keeps SELECT, UPDATE and DELETE on liveness rows + pruneCertBinds works.
    const rows = await api<{ addr: string }[]>`
      select addr::text as addr from authd.mail_device_cert_binds where device_id = ${deviceId}`
    expect(rows.length).toBe(2)
    await api`update authd.mail_device_cert_binds set bound_at = now() - interval '2 days'
               where device_id = ${deviceId}`
    const { sql: dbSql, db } = createDb(API_URL!)
    try {
      const pruned = await pruneCertBinds(db, { batchSize: 1 })
      expect(pruned).toBeGreaterThanOrEqual(2)
    } finally {
      await dbSql.end({ timeout: 5 })
    }
  })

  it("the device key is 32 bytes or nothing, one device per key, and enrollment_id is unique when non-null", async () => {
    expect(
      await broken(
        () => api`update authd.mail_devices set cert_key_sha256 = ${hash("dev").subarray(0, 31)}
                   where id = ${deviceId}`,
      ),
    ).toBe("mail_devices_cert_key_sha256_length")
    await api`update authd.mail_devices set cert_key_sha256 = ${hash("dev")}, acme_bound_at = now() where id = ${deviceId}`

    const eid = crypto.randomUUID()
    const [other] = await owner<{ id: string }[]>`
      insert into authd.mail_devices (clerk_user_id, email, platform, code_hash, code_kid, enrollment_id, created_by)
      values (${person}, ${`mdc-${sfx}@mdc.test`}, 'macos', ${hash("code2")}, 1, ${eid}, 'test')
      returning id::text`
    expect(
      await broken(
        () =>
          api`update authd.mail_devices set cert_key_sha256 = ${hash("dev")} where id = ${other!.id}`,
      ),
    ).toBe("mail_devices_cert_key_sha256_unique")

    // Duplicate non-null enrollment_id is refused by the partial unique index.
    expect(
      await broken(
        () =>
          owner`insert into authd.mail_devices (clerk_user_id, email, platform, code_hash, code_kid, enrollment_id, created_by)
                values (${person}, ${`mdc-${sfx}@mdc.test`}, 'ios', ${hash("code3")}, 1, ${eid}, 'test')`,
      ),
    ).toBe("mail_devices_enrollment_id_unique")

    // Multiple NULL enrollment_id rows (e.g. operator CLI mints) remain allowed.
    await owner`insert into authd.mail_devices (clerk_user_id, email, platform, code_hash, code_kid, created_by)
                values (${person}, ${`mdc-${sfx}@mdc.test`}, 'ios', ${hash("code4")}, 1, 'test')`

    await api`update authd.mail_devices set cert_key_sha256 = null, acme_bound_at = null where id = ${deviceId}`
  })
})
