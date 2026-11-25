import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import postgres from "postgres"

/**
 * The rules `authd.mail_device_cert_permits` and `authd.mail_device_cert_binds`
 * hold by themselves (#383 PR 3, docs/research/mail-device-binding.md section 11):
 * every transition the CA webhook handlers make is accepted, every state no
 * handler can reach is refused by a named CHECK, and the partial unique indexes
 * say which permit a serial, nonce, key, challenge or active SCEP transaction id
 * belongs to. Exercised as `i10_api`, confirming the role keeps DML on both
 * tables through the schema's default privileges.
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

/** A distinct 32-byte hash per label, so no two fixtures collide on a unique index. */
function hash(label: string): Buffer {
  return new Bun.CryptoHasher("sha256").update(`${sfx}/${label}`).digest() as Buffer
}

/**
 * The constraint a statement broke, or null when it succeeded. ⚠ Not
 * `expect(...).rejects`: under bun 1.4.2 that never settles on a postgres.js
 * query and hangs the file.
 */
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

async function acmePermit(serial: string, nonce = hash(`nonce/${serial}`)) {
  const [row] = await api<{ id: string }[]>`
    insert into authd.mail_device_cert_permits (clerk_user_id, device_id, kind, serial, nonce_sha256, expires_at)
    values (${person}, ${deviceId}, 'acme', ${serial}, ${nonce}, now() + interval '10 minutes')
    returning id`
  return row!.id
}

async function scepPermit(label: string) {
  const [row] = await api<{ id: string }[]>`
    insert into authd.mail_device_cert_permits (clerk_user_id, kind, serial, challenge_hash, expires_at)
    values (${person}, 'scep', ${`SCEP-${label}`}, ${hash(`challenge/${label}`)}, now() + interval '10 minutes')
    returning id`
  return row!.id
}

async function statusOf(id: string) {
  const [row] = await api<{ status: string }[]>`
    select status from authd.mail_device_cert_permits where id = ${id}`
  return row?.status
}

suite("device certificate permits and liveness rows against Postgres", () => {
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
    // The account's delete cascades to its devices, permits and liveness rows.
    await owner`delete from authd.accounts where clerk_user_id = ${person}`
    await api.end({ timeout: 5 })
    await owner.end({ timeout: 5 })
  })

  it("accepts every ACME transition the handlers make: open -> authorized -> expired, and open -> expired", async () => {
    const id = await acmePermit(`ACME-A-${sfx}`)
    expect(await statusOf(id)).toBe("open")

    // AUTHORIZING binds the key.
    const key = hash("acme-a/key")
    await api`update authd.mail_device_cert_permits
                 set status = 'authorized', key_sha256 = ${key}, updated_at = now()
               where id = ${id} and status = 'open'`
    expect(await statusOf(id)).toBe("authorized")
    // A second key arriving for an authorized permit (the "detected" path) ends it.
    await api`update authd.mail_device_cert_permits set status = 'expired', updated_at = now()
               where id = ${id} and status = 'authorized'`
    expect(await statusOf(id)).toBe("expired")

    // A permit replaced while open, before any key.
    const replaced = await acmePermit(`ACME-B-${sfx}`)
    await api`update authd.mail_device_cert_permits set status = 'expired' where id = ${replaced}`
    expect(await statusOf(replaced)).toBe("expired")
  })

  it("accepts every SCEP transition: open -> challenged -> authorized -> notified -> expired, and expiry from each", async () => {
    const id = await scepPermit("full")
    const key = hash("scep-full/key")
    await api`update authd.mail_device_cert_permits
                 set status = 'challenged', transaction_id = ${`txn-${sfx}-full`}, key_sha256 = ${key}
               where id = ${id} and status = 'open'`
    await api`update authd.mail_device_cert_permits set status = 'authorized'
               where id = ${id} and status = 'challenged' and key_sha256 = ${key}`
    await api`update authd.mail_device_cert_permits
                 set status = 'notified', issued_cert_sha256 = ${hash("scep-full/cert")}
               where transaction_id = ${`txn-${sfx}-full`} and key_sha256 = ${key} and status = 'authorized'`
    expect(await statusOf(id)).toBe("notified")
    await api`update authd.mail_device_cert_permits set status = 'expired' where id = ${id}`
    expect(await statusOf(id)).toBe("expired")

    for (const [label, steps] of [
      ["open", 0],
      ["challenged", 1],
      ["authorized", 2],
    ] as const) {
      const p = await scepPermit(`expire-${label}`)
      if (steps >= 1)
        await api`update authd.mail_device_cert_permits
                     set status = 'challenged', transaction_id = ${`txn-${sfx}-${label}`},
                         key_sha256 = ${hash(`expire-${label}/key`)}
                   where id = ${p}`
      if (steps >= 2)
        await api`update authd.mail_device_cert_permits set status = 'authorized' where id = ${p}`
      await api`update authd.mail_device_cert_permits set status = 'expired' where id = ${p}`
      expect(await statusOf(p)).toBe("expired")
    }
  })

  it("refuses every state no handler reaches, each by its named CHECK", async () => {
    const acme = await acmePermit(`ACME-C-${sfx}`)
    const scep = await scepPermit("refusals")
    const set = (id: string, assignments: string) => () =>
      api.unsafe(
        `update authd.mail_device_cert_permits set ${assignments} where id = $1`,
        [id],
      )
    const short = `'\\x${"01".repeat(31)}'`
    const long = `'\\x${"01".repeat(33)}'`
    const key = `'\\x${"0a".repeat(32)}'`

    const cases: [string, () => Promise<unknown>, string][] = [
      [
        "unknown kind",
        set(scep, `kind = 'est', challenge_hash = null`),
        "mail_device_cert_permits_kind_check",
      ],
      [
        "unknown status",
        set(scep, `status = 'issued', key_sha256 = ${key}, transaction_id = 't'`),
        "mail_device_cert_permits_status_check",
      ],
      [
        "ACME challenged",
        set(acme, `status = 'challenged', key_sha256 = ${key}`),
        "mail_device_cert_permits_status_kind",
      ],
      [
        "ACME notified",
        set(
          acme,
          `status = 'notified', key_sha256 = ${key}, issued_cert_sha256 = ${key}`,
        ),
        "mail_device_cert_permits_status_kind",
      ],
      [
        "empty serial",
        set(acme, `serial = ''`),
        "mail_device_cert_permits_serial_check",
      ],
      [
        "ACME without a device",
        set(acme, `device_id = null`),
        "mail_device_cert_permits_device_kind",
      ],
      [
        "SCEP naming a device",
        set(scep, `device_id = '${deviceId}'`),
        "mail_device_cert_permits_device_kind",
      ],
      [
        "ACME without its nonce",
        set(acme, `nonce_sha256 = null`),
        "mail_device_cert_permits_nonce_kind",
      ],
      [
        "SCEP with a nonce",
        set(scep, `nonce_sha256 = ${key}`),
        "mail_device_cert_permits_nonce_kind",
      ],
      [
        "ACME with a challenge",
        set(acme, `challenge_hash = ${key}`),
        "mail_device_cert_permits_challenge_kind",
      ],
      [
        "SCEP without its challenge",
        set(scep, `challenge_hash = null`),
        "mail_device_cert_permits_challenge_kind",
      ],
      [
        "an open ACME permit holding a key",
        set(acme, `key_sha256 = ${key}`),
        "mail_device_cert_permits_key_state",
      ],
      [
        "an open SCEP permit holding a key",
        set(scep, `key_sha256 = ${key}`),
        "mail_device_cert_permits_key_state",
      ],
      [
        "ACME authorized without a key",
        set(acme, `status = 'authorized'`),
        "mail_device_cert_permits_key_state",
      ],
      [
        "SCEP challenged without a key",
        set(scep, `status = 'challenged', transaction_id = 't'`),
        "mail_device_cert_permits_key_state",
      ],
      [
        "SCEP authorized without a key",
        set(scep, `status = 'authorized', transaction_id = 't'`),
        "mail_device_cert_permits_key_state",
      ],
      [
        "SCEP challenged without a transaction id",
        set(scep, `status = 'challenged', key_sha256 = ${key}`),
        "mail_device_cert_permits_transaction_state",
      ],
      [
        "SCEP authorized without a transaction id",
        set(scep, `status = 'authorized', key_sha256 = ${key}`),
        "mail_device_cert_permits_transaction_state",
      ],
      [
        "an open SCEP permit with a transaction id",
        set(scep, `transaction_id = 't'`),
        "mail_device_cert_permits_transaction_state",
      ],
      [
        "ACME authorized with a transaction id",
        set(acme, `status = 'authorized', key_sha256 = ${key}, transaction_id = 't'`),
        "mail_device_cert_permits_transaction_state",
      ],
      [
        "ACME expired with a transaction id",
        set(acme, `status = 'expired', transaction_id = 't'`),
        "mail_device_cert_permits_transaction_state",
      ],
      [
        "notified without the certificate's hash",
        set(scep, `status = 'notified', transaction_id = 't', key_sha256 = ${key}`),
        "mail_device_cert_permits_issued_state",
      ],
      [
        "a certificate hash in challenged",
        set(
          scep,
          `status = 'challenged', transaction_id = 't', key_sha256 = ${key}, issued_cert_sha256 = ${key}`,
        ),
        "mail_device_cert_permits_issued_state",
      ],
      [
        "a certificate hash in authorized",
        set(
          scep,
          `status = 'authorized', transaction_id = 't', key_sha256 = ${key}, issued_cert_sha256 = ${key}`,
        ),
        "mail_device_cert_permits_issued_state",
      ],
      [
        "ACME expired with a certificate hash",
        set(acme, `status = 'expired', issued_cert_sha256 = ${key}`),
        "mail_device_cert_permits_issued_state",
      ],
      [
        "a 31-byte nonce",
        set(acme, `nonce_sha256 = ${short}`),
        "mail_device_cert_permits_hash_lengths",
      ],
      [
        "a 33-byte challenge",
        set(scep, `challenge_hash = ${long}`),
        "mail_device_cert_permits_hash_lengths",
      ],
      [
        "a 31-byte key",
        set(acme, `status = 'authorized', key_sha256 = ${short}`),
        "mail_device_cert_permits_hash_lengths",
      ],
      [
        "a 33-byte certificate hash",
        set(scep, `status = 'expired', issued_cert_sha256 = ${long}`),
        "mail_device_cert_permits_hash_lengths",
      ],
      [
        "an empty transaction id",
        set(scep, `status = 'expired', transaction_id = ''`),
        "mail_device_cert_permits_transaction_length",
      ],
      [
        "a 256-byte transaction id",
        set(scep, `status = 'expired', transaction_id = repeat('t', 256)`),
        "mail_device_cert_permits_transaction_length",
      ],
      [
        "an expiry before creation",
        set(acme, `expires_at = created_at`),
        "mail_device_cert_permits_expiry_check",
      ],
    ]
    for (const [what, run, constraint] of cases) {
      expect({ what, broke: await broken(run) }).toEqual({ what, broke: constraint })
    }
    // Every refused write left both permits as they were.
    expect([await statusOf(acme), await statusOf(scep)]).toEqual(["open", "open"])
    // The longest transaction id the CHECK allows still fits the active partial unique index.
    await set(
      scep,
      `status = 'challenged', key_sha256 = ${key}, transaction_id = repeat('t', 255)`,
    )()
    await api`delete from authd.mail_device_cert_permits where id in (${acme}, ${scep})`
  })

  it("one open ACME permit per serial; nonces, keys, challenges and active SCEP transaction ids each name one permit", async () => {
    const serial = `ACME-D-${sfx}`
    const firstNonce = hash(`nonce/${serial}/1`)
    const first = await acmePermit(serial, firstNonce)
    expect(await broken(() => acmePermit(serial))).toBe(
      "mail_device_cert_permits_open_acme_serial",
    )
    // Once the first is no longer open (authorized, or marked expired when a
    // new one is created), the serial can have a new open permit.
    await api`update authd.mail_device_cert_permits set status = 'expired' where id = ${first}`
    // A nonce is globally unique across all ACME permits, even after expiry.
    expect(await broken(() => acmePermit(`ACME-D-OTHER-${sfx}`, firstNonce))).toBe(
      "mail_device_cert_permits_nonce_unique",
    )
    const second = await acmePermit(serial, hash(`nonce/${serial}/2`))
    await api`update authd.mail_device_cert_permits set status = 'authorized', key_sha256 = ${hash("d/key")}
               where id = ${second}`
    const third = await acmePermit(serial, hash(`nonce/${serial}/3`))
    expect(await statusOf(third)).toBe("open")

    // A key bound once is never claimed by another permit.
    expect(
      await broken(
        () => api`update authd.mail_device_cert_permits set status = 'authorized', key_sha256 = ${hash("d/key")}
                   where id = ${third}`,
      ),
    ).toBe("mail_device_cert_permits_key_unique")

    const challenge = hash("challenge/dup")
    await api`insert into authd.mail_device_cert_permits (clerk_user_id, kind, serial, challenge_hash, expires_at)
              values (${person}, 'scep', 'SCEP-dup', ${challenge}, now() + interval '10 minutes')`
    expect(
      await broken(
        () => api`insert into authd.mail_device_cert_permits (clerk_user_id, kind, serial, challenge_hash, expires_at)
                  values (${person}, 'scep', 'SCEP-dup', ${challenge}, now() + interval '10 minutes')`,
      ),
    ).toBe("mail_device_cert_permits_challenge_unique")

    const txn = `txn-${sfx}-dup`
    const a = await scepPermit("txn-a")
    const b = await scepPermit("txn-b")
    const c = await scepPermit("txn-c")
    await api`update authd.mail_device_cert_permits
                 set status = 'challenged', transaction_id = ${txn}, key_sha256 = ${hash("txn-a/key")}
               where id = ${a}`
    // Two active SCEP permits cannot share a transaction id (`challenged` vs `challenged`).
    expect(
      await broken(
        () => api`update authd.mail_device_cert_permits
                     set status = 'challenged', transaction_id = ${txn}, key_sha256 = ${hash("txn-b/key")}
                   where id = ${b}`,
      ),
    ).toBe("mail_device_cert_permits_transaction_unique")
    // Still blocked while the first is `authorized`.
    await api`update authd.mail_device_cert_permits set status = 'authorized' where id = ${a}`
    expect(
      await broken(
        () => api`update authd.mail_device_cert_permits
                     set status = 'challenged', transaction_id = ${txn}, key_sha256 = ${hash("txn-b/key")}
                   where id = ${b}`,
      ),
    ).toBe("mail_device_cert_permits_transaction_unique")
    // Once `notified`, the client-chosen transaction id is free for a later enrollment.
    await api`update authd.mail_device_cert_permits
                 set status = 'notified', issued_cert_sha256 = ${hash("txn-a/cert")}
               where id = ${a}`
    await api`update authd.mail_device_cert_permits
                 set status = 'challenged', transaction_id = ${txn}, key_sha256 = ${hash("txn-b/key")}
               where id = ${b}`
    expect(await statusOf(b)).toBe("challenged")
    // Once `expired`, the transaction id is free again too.
    await api`update authd.mail_device_cert_permits set status = 'expired' where id = ${b}`
    await api`update authd.mail_device_cert_permits
                 set status = 'challenged', transaction_id = ${txn}, key_sha256 = ${hash("txn-c/key")}
               where id = ${c}`
    expect(await statusOf(c)).toBe("challenged")
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
    // Confirm i10_api keeps SELECT, UPDATE and DELETE on liveness rows (key change + prune).
    const rows = await api<{ addr: string }[]>`
      select addr::text as addr from authd.mail_device_cert_binds where device_id = ${deviceId}`
    expect(rows.length).toBe(2)
    await api`update authd.mail_device_cert_binds set bound_at = now() where device_id = ${deviceId}`
    await api`delete from authd.mail_device_cert_binds where device_id = ${deviceId}`
  })

  it("the device key is 32 bytes or nothing, and one device per key", async () => {
    expect(
      await broken(
        () => api`update authd.mail_devices set cert_key_sha256 = ${hash("dev").subarray(0, 31)}
                   where id = ${deviceId}`,
      ),
    ).toBe("mail_devices_cert_key_sha256_length")
    await api`update authd.mail_devices set cert_key_sha256 = ${hash("dev")} where id = ${deviceId}`
    const [other] = await owner<{ id: string }[]>`
      insert into authd.mail_devices (clerk_user_id, email, platform, code_hash, code_kid, created_by)
      values (${person}, ${`mdc-${sfx}@mdc.test`}, 'macos', ${hash("code2")}, 1, 'test')
      returning id::text`
    expect(
      await broken(
        () =>
          api`update authd.mail_devices set cert_key_sha256 = ${hash("dev")} where id = ${other!.id}`,
      ),
    ).toBe("mail_devices_cert_key_sha256_unique")
    await api`update authd.mail_devices set cert_key_sha256 = null where id = ${deviceId}`
  })
})
