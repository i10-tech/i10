import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { SQL } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { createHookHandlers } from "../src/ca-hooks/handlers.js"
import { HANDLER_DEADLINE_MS } from "../src/ca-hooks/listener.js"
import type { Database } from "../src/db/client.js"
import { MailDeviceError } from "../src/mail-devices/code.js"
import {
  createAcmePermit,
  HookDeadlineExceeded,
  sha256,
} from "../src/mail-devices/permits.js"
import { pruneCertBinds, pruneCertPermits } from "../src/mail-devices/prune.js"
import { bindKey, unbindKey } from "../src/mail-devices/store.js"
import {
  acmeBody,
  freshKey,
  scepAuthorizeBody,
  scepChallengeBody,
  scepNotifyBody,
  throwawayCertificate,
} from "./support/ca-hooks.js"

/**
 * The device CA's webhook handlers and the operator's key commands against
 * Postgres (#383 PR 3, docs/research/mail-device-binding.md section 11,
 * "Certificate permits" and "Revision 5 rules"), run as `i10_api`:
 *
 *   - every handler's first call, retry and refusal, and what each leaves behind
 *   - the "different key on an authorized permit" detection, and that it needs the nonce
 *   - permit creation, supersession and conflict
 *   - `bind-key` / `unbind-key`, the retention prunes
 *   - the lock order under the three races the design names
 *
 *   TEMPLATES_TEST_DATABASE_URL=postgres://i10:i10@localhost:5433/i10 bun test test/ca-hooks-db.test.ts
 */
const URL = process.env.TEMPLATES_TEST_DATABASE_URL
const API_URL = URL?.replace(/\/\/[^@]+@/, "//i10_api:i10_api@")
const suite = URL ? describe : describe.skip

let owner: ReturnType<typeof postgres>
let api: ReturnType<typeof postgres>
let db: Database
type Handlers = ReturnType<typeof createHookHandlers>
/** The handlers, with the listener's deadline unless a test names one. */
let hooks: {
  [K in keyof Handlers]: (
    body: unknown,
    now: Date,
    deadline?: Date,
  ) => ReturnType<Handlers[K]>
}

/** The listener's deadline for a request read now. */
const deadlineFromNow = (ms = HANDLER_DEADLINE_MS) => new Date(Date.now() + ms)

function withDeadlines(handlers: Handlers): typeof hooks {
  return Object.fromEntries(
    Object.entries(handlers).map(([kind, handler]) => [
      kind,
      (body: unknown, now: Date, deadline?: Date) =>
        handler(body, now, deadline ?? deadlineFromNow()),
    ]),
  ) as typeof hooks
}

const sfx = crypto.randomUUID().slice(0, 8)
const people: string[] = []
const tenants: string[] = []
const INTERMEDIATE_NOT_AFTER = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000)

interface DeviceState {
  cert_key_sha256: Buffer | null
  first_used_at: Date | null
  last_used_at: Date | null
  binds: number
}

interface PermitState {
  status: string
  key_sha256: Buffer | null
  transaction_id: string | null
  issued_cert_sha256: Buffer | null
}

let counter = 0
const label = () => `${sfx}${(counter++).toString(36)}`

/** A fresh person (i10's own domain, nothing held) with one device. */
async function mac(
  options: {
    platform?: string
    serial?: string | null
    createdMinutesAgo?: number
    used?: boolean
  } = {},
) {
  const tag = label()
  const person = `user_cah_${tag}`
  const email = `cah-${tag}@cah-${sfx}.test`
  const serial =
    options.serial === undefined ? `C02${tag.toUpperCase()}` : options.serial
  people.push(person)
  await owner`insert into authd.accounts (clerk_user_id, email, active) values (${person}, ${email}, true)`
  const created = options.createdMinutesAgo ?? 0
  const [row] = await owner<{ id: string }[]>`
    insert into authd.mail_devices
           (clerk_user_id, email, platform, serial, code_hash, code_kid, created_by, created_at,
            first_used_at, last_used_at)
    values (${person}, ${email}, ${options.platform ?? "macos"}, ${serial}, ${sha256(tag)}, 1, 'test',
            now() - make_interval(mins => ${created}),
            ${options.used ? owner`now()` : null}, ${options.used ? owner`now()` : null})
    returning id::text`
  return { person, email, serial: serial ?? "", deviceId: row!.id }
}

async function device(id: string): Promise<DeviceState> {
  const [row] = await owner<DeviceState[]>`
    select cert_key_sha256, first_used_at, last_used_at,
           (select count(*)::int from authd.mail_device_cert_binds b where b.device_id = d.id) as binds
      from authd.mail_devices d where id = ${id}`
  return row!
}

async function permit(id: string): Promise<PermitState> {
  const [row] = await owner<PermitState[]>`
    select status, key_sha256, transaction_id, issued_cert_sha256
      from authd.mail_device_cert_permits where id = ${id}`
  return row!
}

/** A stale liveness row under some key, which a key change must delete. */
async function liveness(deviceId: string, addr = "192.0.2.10/32") {
  await owner`insert into authd.mail_device_cert_binds (device_id, addr, key_sha256)
              values (${deviceId}, ${addr}, ${sha256(`liveness/${addr}`)})`
}

/** The constraint or message a call failed with, or null. Never `.rejects` (hangs under bun). */
async function failure(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run()
    return null
  } catch (error) {
    return error instanceof MailDeviceError ? error.code : String(error)
  }
}

/** A Mac with an open ACME permit, and the body its real AUTHORIZING would carry. */
async function enrolling(options: Parameters<typeof mac>[0] = {}) {
  const m = await mac(options)
  const opened = await createAcmePermit(db, { deviceId: m.deviceId })
  const key = freshKey()
  const body = (k = key, nonce = opened.nonce) =>
    acmeBody({ serial: m.serial, nonce, spki: k.spki, now: new Date() })
  return { ...m, ...opened, key, body }
}

const acme = (body: unknown, deadline?: Date) =>
  hooks["acme-authorize"](body, new Date(), deadline)

/** The operator's bind-key for `m`, with the CN its own certificate would carry. */
const bind = (
  m: { deviceId: string; serial: string },
  keySha256: Buffer,
  options: { commonName?: string | null; replace?: boolean } = {},
) =>
  bindKey(db, {
    deviceId: m.deviceId,
    keySha256,
    commonName: options.commonName === undefined ? m.serial : options.commonName,
    replace: options.replace ?? false,
  })

/** What a failed handler call threw: its SQLSTATE, the deadline, or the message. */
async function hookFailure(run: Promise<unknown>): Promise<string> {
  return run.then(
    () => "returned",
    (error: unknown) =>
      error instanceof HookDeadlineExceeded
        ? "deadline"
        : String((error as { cause?: { code?: string } }).cause?.code ?? error),
  )
}

suite("device CA webhook handlers against Postgres", () => {
  beforeAll(async () => {
    owner = postgres(URL!, { max: 3, onnotice: () => {} })
    api = postgres(API_URL!, { max: 8, onnotice: () => {} })
    db = drizzle({ client: api }) as unknown as Database
    hooks = withDeadlines(
      createHookHandlers({ db, intermediateNotAfter: INTERMEDIATE_NOT_AFTER }),
    )
  })

  afterAll(async () => {
    // Each account's delete cascades to its devices, permits and liveness rows.
    if (people.length > 0) {
      await owner`delete from authd.accounts where clerk_user_id = any(${`{${people.join(",")}}`}::text[])`
    }
    if (tenants.length > 0) {
      await owner`delete from core.tenants where id = any(${`{${tenants.join(",")}}`}::uuid[])`
    }
    await api.end({ timeout: 5 })
    await owner.end({ timeout: 5 })
  })

  describe("ACME AUTHORIZING", () => {
    it("binds the key, claims the first use, drops liveness rows and authorizes the permit", async () => {
      const e = await enrolling()
      await liveness(e.deviceId)
      expect(await acme(e.body())).toEqual({ allow: true, outcome: "allowed" })

      const d = await device(e.deviceId)
      expect(d.cert_key_sha256?.equals(e.key.sha)).toBe(true)
      expect(d.first_used_at).not.toBeNull()
      expect(d.last_used_at).not.toBeNull()
      expect(d.binds).toBe(0)
      const p = await permit(e.permitId)
      expect(p.status).toBe("authorized")
      expect(p.key_sha256?.equals(e.key.sha)).toBe(true)
    })

    it("allows step-ca's retry of the same body, and changes nothing", async () => {
      const e = await enrolling()
      const body = e.body()
      await acme(body)
      const before = await device(e.deviceId)
      expect(await acme(body)).toEqual({ allow: true, outcome: "allowed_retry" })
      expect(await device(e.deviceId)).toEqual(before)
    })

    it("re-runs the gate on a retry: a hold placed between the two refuses it", async () => {
      const e = await enrolling()
      const body = e.body()
      await acme(body)
      await owner`update authd.accounts set suspended_at = now() where clerk_user_id = ${e.person}`
      expect(await acme(body)).toEqual({
        allow: false,
        outcome: "refused_mailbox_suspended",
      })
    })

    it("refuses a retry once the key is no longer the device's", async () => {
      const e = await enrolling()
      const body = e.body()
      await acme(body)
      await unbindKey(db, { deviceId: e.deviceId })
      expect(await acme(body)).toEqual({
        allow: false,
        outcome: "refused_device_key_changed",
      })
      expect((await device(e.deviceId)).cert_key_sha256).toBeNull()
    })

    it("refuses a retry after the permit's ten minutes", async () => {
      const e = await enrolling()
      const body = e.body()
      await acme(body)
      await owner`update authd.mail_device_cert_permits
                     set created_at = now() - interval '20 minutes', expires_at = now() - interval '1 second'
                   where id = ${e.permitId}`
      expect(await acme(body)).toEqual({ allow: false, outcome: "no_permit" })
    })

    it("refuses an unknown nonce, another serial, and an expired permit, writing nothing", async () => {
      const e = await enrolling()
      expect(await acme(e.body(e.key, "some-other-nonce-0123"))).toEqual({
        allow: false,
        outcome: "no_permit",
      })
      const other = acmeBody({
        serial: "C02ELSEWHERE",
        nonce: e.nonce,
        spki: e.key.spki,
        now: new Date(),
      })
      expect(await acme(other)).toEqual({ allow: false, outcome: "no_permit" })
      await owner`update authd.mail_device_cert_permits
                     set created_at = now() - interval '20 minutes', expires_at = now() - interval '1 second'
                   where id = ${e.permitId}`
      expect(await acme(e.body())).toEqual({ allow: false, outcome: "no_permit" })
      expect((await device(e.deviceId)).cert_key_sha256).toBeNull()
      expect((await permit(e.permitId)).status).toBe("open")
    })

    it.each([
      ["suspended", "suspended_at = now()", "refused_mailbox_suspended"],
      ["on payment hold", "payment_hold_at = now()", "refused_payment_hold"],
      ["being deleted", "deleting_at = now()", "refused_mailbox_deleting"],
      ["banned", "banned = true", "refused_account_banned"],
      ["inactive", "active = false", "refused_account_inactive"],
    ] as const)(
      "refuses an account that is %s, writing nothing",
      async (_label, set, outcome) => {
        const e = await enrolling()
        await owner.unsafe(
          `update authd.accounts set ${set} where clerk_user_id = $1`,
          [e.person],
        )
        expect(await acme(e.body())).toEqual({ allow: false, outcome })
        expect((await device(e.deviceId)).cert_key_sha256).toBeNull()
        expect((await permit(e.permitId)).status).toBe("open")
      },
    )

    it("refuses a device whose address or workspace no longer matches its account", async () => {
      const e = await enrolling()
      await owner`update authd.accounts set email = ${`moved-${e.email}`} where clerk_user_id = ${e.person}`
      expect(await acme(e.body())).toEqual({
        allow: false,
        outcome: "refused_device_mismatch",
      })
    })

    it("refuses a device that already has a key", async () => {
      const e = await enrolling()
      await owner`update authd.mail_devices set cert_key_sha256 = ${sha256(`pre/${e.deviceId}`)},
                         first_used_at = now(), last_used_at = now() where id = ${e.deviceId}`
      expect(await acme(e.body())).toEqual({
        allow: false,
        outcome: "refused_device_key_bound",
      })
    })

    it("refuses a device whose unused code has died, and never revives it", async () => {
      const e = await enrolling()
      await owner`update authd.mail_devices set created_at = now() - interval '11 minutes' where id = ${e.deviceId}`
      expect(await acme(e.body())).toEqual({
        allow: false,
        outcome: "refused_device_expired",
      })
      expect((await device(e.deviceId)).first_used_at).toBeNull()
    })

    it("refuses a permit for a non-Mac row, or a row whose serial is not the permit's", async () => {
      for (const [platform, serialOf, outcome] of [
        ["ios", (s: string) => s, "refused_device_not_macos"],
        ["macos", () => "C02NOTTHISONE", "refused_serial_mismatch"],
      ] as const) {
        const m = await mac({ platform })
        const nonce = `nonce-${label()}-0123456789`
        // Written directly: `createAcmePermit` refuses both, and the handler must too.
        await owner`update authd.mail_devices set serial = ${serialOf(m.serial)} where id = ${m.deviceId}`
        await owner`insert into authd.mail_device_cert_permits
                           (clerk_user_id, device_id, kind, serial, nonce_sha256, expires_at)
                    values (${m.person}, ${m.deviceId}, 'acme', ${m.serial}, ${sha256(nonce)},
                            now() + interval '10 minutes')`
        const key = freshKey()
        const decision = await acme(
          acmeBody({ serial: m.serial, nonce, spki: key.spki, now: new Date() }),
        )
        expect(decision).toEqual({ allow: false, outcome })
        expect((await device(m.deviceId)).cert_key_sha256).toBeNull()
      }
    })

    it("refuses a key another device already holds, as allow false and not a 500", async () => {
      const first = await enrolling()
      await acme(first.body())
      const second = await enrolling()
      expect(await acme(second.body(first.key))).toEqual({
        allow: false,
        outcome: "duplicate",
      })
      expect((await device(second.deviceId)).cert_key_sha256).toBeNull()
      expect((await permit(second.permitId)).status).toBe("open")
    })

    it("on a second key for an authorized permit, clears the bound key and its liveness rows, and expires the permit", async () => {
      const e = await enrolling()
      const firstBody = e.body()
      await acme(firstBody)
      await liveness(e.deviceId)
      const second = freshKey()
      expect(await acme(e.body(second))).toMatchObject({
        allow: false,
        outcome: "key_conflict_cleared",
        permitId: e.permitId,
      })
      const d = await device(e.deviceId)
      expect(d.cert_key_sha256).toBeNull()
      expect(d.binds).toBe(0)
      expect((await permit(e.permitId)).status).toBe("expired")
      // Neither key can come back through this permit.
      expect(await acme(firstBody)).toEqual({ allow: false, outcome: "no_permit" })
      expect(await acme(e.body(second))).toEqual({ allow: false, outcome: "no_permit" })
    })

    it("cannot be used to wipe a key without the nonce", async () => {
      const e = await enrolling()
      await acme(e.body())
      const intruder = freshKey()
      expect(await acme(e.body(intruder, "guessed-nonce-0123456789"))).toEqual({
        allow: false,
        outcome: "no_permit",
      })
      expect((await device(e.deviceId)).cert_key_sha256?.equals(e.key.sha)).toBe(true)
      expect((await permit(e.permitId)).status).toBe("authorized")
    })

    it("leaves a key the operator bound since alone", async () => {
      const e = await enrolling()
      await acme(e.body())
      const operatorKey = freshKey()
      await bind(e, operatorKey.sha, { replace: true })
      expect(await acme(e.body(freshKey()))).toMatchObject({
        allow: false,
        outcome: "key_conflict",
      })
      expect((await device(e.deviceId)).cert_key_sha256?.equals(operatorKey.sha)).toBe(
        true,
      )
    })

    it("past the permit's ten minutes, a second key is no permit: it clears nothing and changes nothing", async () => {
      const e = await enrolling()
      await acme(e.body())
      await liveness(e.deviceId)
      await owner`update authd.mail_device_cert_permits
                     set created_at = now() - interval '20 minutes', expires_at = now() - interval '1 second'
                   where id = ${e.permitId}`
      const before = await device(e.deviceId)
      expect(await acme(e.body(freshKey()))).toEqual({
        allow: false,
        outcome: "no_permit",
      })
      const after = await device(e.deviceId)
      expect(after.cert_key_sha256?.equals(e.key.sha)).toBe(true)
      expect(after).toEqual(before)
      expect(after.binds).toBe(1)
      expect((await permit(e.permitId)).status).toBe("authorized")
    })
  })

  describe("creating an ACME permit", () => {
    it("stores only the nonce's hash, open for ten minutes", async () => {
      const m = await mac()
      const opened = await createAcmePermit(db, { deviceId: m.deviceId })
      expect(opened.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/)
      const [row] = await owner<
        { nonce_sha256: Buffer; status: string; seconds: number }[]
      >`
        select nonce_sha256, status, extract(epoch from expires_at - created_at)::int as seconds
          from authd.mail_device_cert_permits where id = ${opened.permitId}`
      expect(row!.nonce_sha256.equals(sha256(opened.nonce))).toBe(true)
      expect(row!.status).toBe("open")
      expect(row!.seconds).toBe(600)
    })

    it("supersedes the same person's own open permit for the serial", async () => {
      const m = await mac()
      const first = await createAcmePermit(db, { deviceId: m.deviceId })
      const second = await createAcmePermit(db, { deviceId: m.deviceId })
      expect((await permit(first.permitId)).status).toBe("expired")
      expect((await permit(second.permitId)).status).toBe("open")
    })

    it("allows two people to hold live open ACME permits for the same serial concurrently (Review 1 M6)", async () => {
      const a = await mac()
      const b = await mac({ serial: a.serial })
      const aPermit = await createAcmePermit(db, { deviceId: a.deviceId })
      const bPermit = await createAcmePermit(db, { deviceId: b.deviceId })
      expect((await permit(aPermit.permitId)).status).toBe("open")
      expect((await permit(bPermit.permitId)).status).toBe("open")

      // Each person's nonce authorizes strictly their own device.
      const aKey = freshKey()
      const bKey = freshKey()
      expect(
        await acme(
          acmeBody({
            serial: a.serial,
            nonce: aPermit.nonce,
            spki: aKey.spki,
            now: new Date(),
          }),
        ),
      ).toEqual({ allow: true, outcome: "allowed" })
      expect(
        await acme(
          acmeBody({
            serial: b.serial,
            nonce: bPermit.nonce,
            spki: bKey.spki,
            now: new Date(),
          }),
        ),
      ).toEqual({ allow: true, outcome: "allowed" })
      expect((await device(a.deviceId)).cert_key_sha256?.equals(aKey.sha)).toBe(true)
      expect((await device(b.deviceId)).cert_key_sha256?.equals(bKey.sha)).toBe(true)
    })

    it("refuses a device with no serial, a non-Mac, a bound key, a dead code or a held account", async () => {
      expect(
        await failure(async () =>
          createAcmePermit(db, { deviceId: (await mac({ serial: null })).deviceId }),
        ),
      ).toBe("device_serial_missing")
      expect(
        await failure(async () =>
          createAcmePermit(db, {
            deviceId: (await mac({ platform: "ipados" })).deviceId,
          }),
        ),
      ).toBe("device_not_macos")
      expect(
        await failure(async () =>
          createAcmePermit(db, {
            deviceId: (await mac({ createdMinutesAgo: 11 })).deviceId,
          }),
        ),
      ).toBe("device_expired")
      const bound = await mac()
      await bind(bound, freshKey().sha)
      expect(
        await failure(() => createAcmePermit(db, { deviceId: bound.deviceId })),
      ).toBe("device_key_bound")
      const held = await mac()
      await owner`update authd.accounts set payment_hold_at = now() where clerk_user_id = ${held.person}`
      expect(
        await failure(() => createAcmePermit(db, { deviceId: held.deviceId })),
      ).toBe("payment_hold")
      expect(
        await failure(() => createAcmePermit(db, { deviceId: crypto.randomUUID() })),
      ).toBe("device_not_found")
    })
  })

  describe("SCEP", () => {
    /** A person with an attested enrollment and an open SCEP permit for `serial`. */
    async function scepPermit() {
      const m = await mac()
      const tag = label()
      const [acct] = await owner<{ credential_epoch: string | number }[]>`
        select credential_epoch from authd.accounts where clerk_user_id = ${m.person}`
      const [enrollRow] = await owner<{ id: string }[]>`
        insert into authd.mail_device_enrollments
               (clerk_user_id, email, expected_epoch, token_sha256, status, serial,
                product, os_version, udid_sha256, apple_signer_sha256, platform,
                created_by, expires_at)
        values (${m.person}, ${m.email}, ${Number(acct!.credential_epoch)},
                ${sha256(`enroll-tok/${tag}`)}, 'attested', ${m.serial},
                'Mac14,2', '24D70', ${sha256(`udid/${tag}`)},
                ${sha256(`signer/${tag}`)}, 'macos', 'test',
                now() + interval '10 minutes')
        returning id::text`
      const challenge = `challenge-${tag}-0123456789abcdef`
      const [row] = await owner<{ id: string }[]>`
        insert into authd.mail_device_cert_permits
               (clerk_user_id, enrollment_id, kind, serial, challenge_hash, expires_at)
        values (${m.person}, ${enrollRow!.id}, 'scep', ${m.serial}, ${sha256(challenge)},
                now() + interval '10 minutes')
        returning id::text`
      const cert = throwawayCertificate(`/CN=${m.serial}`)
      const csrKey = new (await import("node:crypto")).X509Certificate(
        cert.certPem,
      ).publicKey.export({
        type: "spki",
        format: "der",
      })
      return {
        ...m,
        enrollmentId: enrollRow!.id,
        permitId: row!.id,
        challenge,
        cert,
        csrKey,
        transactionId: `txn-${label()}`,
      }
    }
    const challengeBody = (
      s: Awaited<ReturnType<typeof scepPermit>>,
      over: Partial<Parameters<typeof scepChallengeBody>[0]> = {},
    ) =>
      scepChallengeBody({
        challenge: s.challenge,
        transactionId: s.transactionId,
        commonName: s.serial,
        spki: s.csrKey,
        now: new Date(),
        ...over,
      })
    const authorizeBody = (s: Awaited<ReturnType<typeof scepPermit>>) =>
      scepAuthorizeBody({ commonName: s.serial, spki: s.csrKey, now: new Date() })
    const notifyBody = (
      s: Awaited<ReturnType<typeof scepPermit>>,
      der: Buffer | null = s.cert.der,
    ) => scepNotifyBody({ transactionId: s.transactionId, der, now: new Date() })
    const now = () => new Date()

    it("runs challenge, authorize and notify, each idempotent on step-ca's retry", async () => {
      const s = await scepPermit()
      expect(await hooks["scep-challenge"](challengeBody(s), now())).toEqual({
        allow: true,
        outcome: "allowed",
      })
      let p = await permit(s.permitId)
      expect(p.status).toBe("challenged")
      expect(p.transaction_id).toBe(s.transactionId)
      expect(p.key_sha256?.equals(s.cert.spkiSha)).toBe(true)
      expect(await hooks["scep-challenge"](challengeBody(s), now())).toEqual({
        allow: true,
        outcome: "allowed_retry",
      })

      expect(await hooks["scep-authorize"](authorizeBody(s), now())).toEqual({
        allow: true,
        outcome: "allowed",
      })
      expect((await permit(s.permitId)).status).toBe("authorized")
      expect(await hooks["scep-authorize"](authorizeBody(s), now())).toEqual({
        allow: true,
        outcome: "allowed_retry",
      })

      expect(await hooks["scep-notify"](notifyBody(s, null), now())).toEqual({
        allow: false,
        outcome: "notify_failure",
      })
      expect((await permit(s.permitId)).status).toBe("authorized")
      expect(await hooks["scep-notify"](notifyBody(s), now())).toEqual({
        allow: true,
        outcome: "notified",
      })
      p = await permit(s.permitId)
      expect(p.status).toBe("notified")
      expect(p.issued_cert_sha256?.equals(sha256(s.cert.der))).toBe(true)
      expect(await hooks["scep-notify"](notifyBody(s), now())).toEqual({
        allow: true,
        outcome: "allowed_retry",
      })
    })

    it("refuses a wrong challenge, a CN other than the serial, and a retry with another transaction id", async () => {
      const s = await scepPermit()
      expect(
        await hooks["scep-challenge"](
          challengeBody(s, { challenge: "wrong-challenge" }),
          now(),
        ),
      ).toEqual({
        allow: false,
        outcome: "no_permit",
      })
      expect(
        await hooks["scep-challenge"](
          challengeBody(s, { commonName: "C02OTHER" }),
          now(),
        ),
      ).toEqual({
        allow: false,
        outcome: "no_permit",
      })
      expect((await permit(s.permitId)).status).toBe("open")
      await hooks["scep-challenge"](challengeBody(s), now())
      expect(
        await hooks["scep-challenge"](
          challengeBody(s, { transactionId: "txn-other" }),
          now(),
        ),
      ).toEqual({
        allow: false,
        outcome: "no_permit",
      })
      expect(
        await hooks["scep-challenge"](
          challengeBody(s, { spki: freshKey().spki }),
          now(),
        ),
      ).toEqual({
        allow: false,
        outcome: "no_permit",
      })
    })

    it("answers a transaction id another active enrollment holds with allow false, never a 500", async () => {
      const a = await scepPermit()
      const b = await scepPermit()
      await hooks["scep-challenge"](challengeBody(a), now())
      expect(
        await hooks["scep-challenge"](
          challengeBody(b, { transactionId: a.transactionId }),
          now(),
        ),
      ).toEqual({
        allow: false,
        outcome: "duplicate",
      })
      expect((await permit(b.permitId)).status).toBe("open")
    })

    it("refuses a held account or moved epoch at challenge, authorize and notify, marking the enrollment refused", async () => {
      const s1 = await scepPermit()
      await owner`update authd.accounts set suspended_at = now() where clerk_user_id = ${s1.person}`
      expect(await hooks["scep-challenge"](challengeBody(s1), now())).toEqual({
        allow: false,
        outcome: "refused_mailbox_suspended",
      })
      const [e1] = await owner<{ status: string; refusal: string | null }[]>`
        select status, refusal from authd.mail_device_enrollments where id = ${s1.enrollmentId}`
      expect(e1).toEqual({ status: "refused", refusal: "mailbox_suspended" })
      expect((await permit(s1.permitId)).status).toBe("expired")

      const s2 = await scepPermit()
      expect(await hooks["scep-challenge"](challengeBody(s2), now())).toEqual({
        allow: true,
        outcome: "allowed",
      })
      await owner`update authd.accounts set locked = true where clerk_user_id = ${s2.person}`
      expect(await hooks["scep-authorize"](authorizeBody(s2), now())).toEqual({
        allow: false,
        outcome: "refused_account_locked",
      })
      const [e2] = await owner<{ status: string; refusal: string | null }[]>`
        select status, refusal from authd.mail_device_enrollments where id = ${s2.enrollmentId}`
      expect(e2).toEqual({ status: "refused", refusal: "account_locked" })
      expect((await permit(s2.permitId)).status).toBe("expired")

      // Notify (and retry) also gate on the enrollment's expected_epoch.
      const s3 = await scepPermit()
      await hooks["scep-challenge"](challengeBody(s3), now())
      await hooks["scep-authorize"](authorizeBody(s3), now())
      await owner`update authd.accounts set credential_epoch = credential_epoch + 1
                   where clerk_user_id = ${s3.person}`
      expect(await hooks["scep-notify"](notifyBody(s3), now())).toEqual({
        allow: false,
        outcome: "refused_epoch_mismatch",
      })
      const [e3] = await owner<{ status: string; refusal: string | null }[]>`
        select status, refusal from authd.mail_device_enrollments where id = ${s3.enrollmentId}`
      expect(e3).toEqual({ status: "refused", refusal: "epoch_mismatch" })
      expect((await permit(s3.permitId)).status).toBe("expired")

      // Retry after a hold placed between first notify and retry also refuses.
      const s4 = await scepPermit()
      await hooks["scep-challenge"](challengeBody(s4), now())
      await hooks["scep-authorize"](authorizeBody(s4), now())
      expect(await hooks["scep-notify"](notifyBody(s4), now())).toEqual({
        allow: true,
        outcome: "notified",
      })
      await owner`update authd.accounts set suspended_at = now() where clerk_user_id = ${s4.person}`
      expect(await hooks["scep-notify"](notifyBody(s4), now())).toEqual({
        allow: false,
        outcome: "refused_mailbox_suspended",
      })
    })

    it("refuses authorize before the challenge, after expiry, and notify for another transaction", async () => {
      const s = await scepPermit()
      expect(await hooks["scep-authorize"](authorizeBody(s), now())).toEqual({
        allow: false,
        outcome: "no_permit",
      })
      await hooks["scep-challenge"](challengeBody(s), now())
      expect(
        await hooks["scep-notify"](
          scepNotifyBody({
            transactionId: s.transactionId,
            der: s.cert.der,
            now: now(),
          }),
          now(),
        ),
      ).toEqual({ allow: false, outcome: "no_permit" })
      await owner`update authd.mail_device_cert_permits
                     set created_at = now() - interval '20 minutes', expires_at = now() - interval '1 second'
                   where id = ${s.permitId}`
      expect(await hooks["scep-authorize"](authorizeBody(s), now())).toEqual({
        allow: false,
        outcome: "no_permit",
      })
      expect(await hooks["scep-challenge"](challengeBody(s), now())).toEqual({
        allow: false,
        outcome: "no_permit",
      })
    })
  })

  describe("the operator's bind-key and unbind-key", () => {
    it("binds, claims the first use and drops liveness rows; unbinds and drops them again", async () => {
      const m = await mac()
      await liveness(m.deviceId)
      const key = freshKey()
      await bind(m, key.sha)
      let d = await device(m.deviceId)
      expect(d.cert_key_sha256?.equals(key.sha)).toBe(true)
      expect(d.first_used_at).not.toBeNull()
      expect(d.binds).toBe(0)

      await liveness(m.deviceId, "2001:db8::/64")
      expect(await unbindKey(db, { deviceId: m.deviceId })).toBe(true)
      d = await device(m.deviceId)
      expect(d.cert_key_sha256).toBeNull()
      expect(d.binds).toBe(0)
      expect(await unbindKey(db, { deviceId: m.deviceId })).toBe(false)
    })

    it("refuses a non-Mac, a dead code (without reviving it), a key in use and a missing device", async () => {
      const ios = await mac({ platform: "ios" })
      expect(await failure(() => bind(ios, freshKey().sha))).toBe("device_not_macos")
      const dead = await mac({ createdMinutesAgo: 11 })
      expect(await failure(() => bind(dead, freshKey().sha))).toBe("device_expired")
      expect((await device(dead.deviceId)).first_used_at).toBeNull()

      const key = freshKey()
      await bind(await mac(), key.sha)
      const other = await mac()
      expect(await failure(() => bind(other, key.sha))).toBe("key_in_use")
      expect((await device(other.deviceId)).cert_key_sha256).toBeNull()
      expect(
        await failure(() =>
          bind({ deviceId: crypto.randomUUID(), serial: "X" }, key.sha),
        ),
      ).toBe("device_not_found")
      expect(await failure(() => unbindKey(db, { deviceId: "not-a-uuid" }))).toBe(
        "device_not_found",
      )
    })

    it("keeps a used device's own clocks when it binds", async () => {
      const m = await mac({ used: true })
      await owner`update authd.mail_devices set first_used_at = now() - interval '3 days',
                         last_used_at = now() - interval '2 days' where id = ${m.deviceId}`
      const before = await device(m.deviceId)
      await bind(m, freshKey().sha)
      const after = await device(m.deviceId)
      expect(after.first_used_at).toEqual(before.first_used_at)
      expect(after.last_used_at).toEqual(before.last_used_at)
    })

    it("refuses a row that already has a key, unless --replace", async () => {
      const m = await mac()
      const first = freshKey()
      await bind(m, first.sha)
      await liveness(m.deviceId)
      expect(await failure(() => bind(m, freshKey().sha))).toBe("device_key_bound")
      expect((await device(m.deviceId)).cert_key_sha256?.equals(first.sha)).toBe(true)
      expect((await device(m.deviceId)).binds).toBe(1)

      const second = freshKey()
      await bind(m, second.sha, { replace: true })
      const d = await device(m.deviceId)
      expect(d.cert_key_sha256?.equals(second.sha)).toBe(true)
      expect(d.binds).toBe(0)
    })

    it("refuses a certificate whose CN is not the row's serial, and checks none when the row has no serial", async () => {
      const m = await mac()
      expect(
        await failure(() => bind(m, freshKey().sha, { commonName: "C02OTHER" })),
      ).toBe("serial_mismatch")
      expect(await failure(() => bind(m, freshKey().sha, { commonName: null }))).toBe(
        "serial_mismatch",
      )
      expect((await device(m.deviceId)).cert_key_sha256).toBeNull()

      const unnamed = await mac({ serial: null })
      await bind(unnamed, freshKey().sha, { commonName: "anything" })
      expect((await device(unnamed.deviceId)).cert_key_sha256).not.toBeNull()
    })

    it.each([
      ["suspended", "suspended_at = now()", "mailbox_suspended"],
      ["on payment hold", "payment_hold_at = now()", "payment_hold"],
      ["banned", "banned = true", "account_banned"],
      ["inactive", "active = false", "account_inactive"],
    ] as const)(
      "runs the account gate: refuses an account that is %s",
      async (_l, set, code) => {
        const m = await mac()
        await owner.unsafe(
          `update authd.accounts set ${set} where clerk_user_id = $1`,
          [m.person],
        )
        expect(await failure(() => bind(m, freshKey().sha))).toBe(code)
        expect((await device(m.deviceId)).cert_key_sha256).toBeNull()
      },
    )

    it("refuses a row whose workspace is no longer its account's", async () => {
      const m = await mac()
      const tenant = crypto.randomUUID()
      tenants.push(tenant)
      await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id)
                  values (${tenant}, ${`cah-${label()}`}, 'cah', ${m.person})`
      await owner`update authd.accounts set tenant_id = ${tenant} where clerk_user_id = ${m.person}`
      expect(await failure(() => bind(m, freshKey().sha))).toBe("tenant_mismatch")
      expect((await device(m.deviceId)).cert_key_sha256).toBeNull()
    })
  })

  describe("retention", () => {
    it("deletes permits only a day past expiry, in batches", async () => {
      const m = await mac()
      const [enr] = await owner<{ id: string }[]>`
        insert into authd.mail_device_enrollments
               (clerk_user_id, email, expected_epoch, token_sha256, status,
                created_by, expires_at)
        values (${m.person}, ${m.email}, 1, ${sha256(`prune-enr/${label()}`)}, 'expired',
                'test', now() + interval '10 minutes')
        returning id::text`
      const ids: string[] = []
      for (const age of ["25 hours", "26 hours", "27 hours", "23 hours"]) {
        const [row] = await owner<{ id: string }[]>`
          insert into authd.mail_device_cert_permits
                 (clerk_user_id, enrollment_id, kind, status, serial, challenge_hash, created_at, expires_at)
          values (${m.person}, ${enr!.id}, 'scep', 'expired', ${m.serial}, ${sha256(`prune/${label()}`)},
                  now() - ${age}::interval - interval '10 minutes', now() - ${age}::interval)
          returning id::text`
        ids.push(row!.id)
      }
      const pruned = await pruneCertPermits(db, { batchSize: 2 })
      expect(pruned).toBeGreaterThanOrEqual(3)
      const [left] = await owner<{ ids: string[] }[]>`
        select coalesce(array_agg(id::text), '{}') as ids from authd.mail_device_cert_permits
         where id = any(${`{${ids.join(",")}}`}::uuid[])`
      expect(left!.ids).toEqual([ids[3]!])
    })

    it("deletes liveness rows only past a day, and keeps one authd refreshed", async () => {
      const m = await mac()
      await liveness(m.deviceId, "192.0.2.1/32")
      await liveness(m.deviceId, "192.0.2.2/32")
      await owner`update authd.mail_device_cert_binds set bound_at = now() - interval '25 hours'
                   where device_id = ${m.deviceId}`
      await owner`update authd.mail_device_cert_binds set bound_at = now()
                   where device_id = ${m.deviceId} and addr = '192.0.2.2/32'`
      expect(await pruneCertBinds(db, { batchSize: 1 })).toBeGreaterThanOrEqual(1)
      expect((await device(m.deviceId)).binds).toBe(1)
    })
  })

  describe("the lock order under races", () => {
    const ROUNDS = 12

    it("step-ca's retry racing the first call: both allowed, one key bound, no deadlock", async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const e = await enrolling()
        const body = e.body()
        const decisions = await Promise.all([acme(body), acme(body)])
        expect(decisions.every((d) => d.allow)).toBe(true)
        expect(decisions.map((d) => d.outcome).sort()).toEqual([
          "allowed",
          "allowed_retry",
        ])
        expect((await device(e.deviceId)).cert_key_sha256?.equals(e.key.sha)).toBe(true)
        expect((await permit(e.permitId)).status).toBe("authorized")
      }
    })

    it("two hooks for one serial with different keys: at most one allowed, and the row ends without a key", async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const e = await enrolling()
        const decisions = await Promise.all([
          acme(e.body(freshKey())),
          acme(e.body(freshKey())),
        ])
        expect(decisions.filter((d) => d.allow)).toHaveLength(1)
        expect(decisions.filter((d) => !d.allow)[0]?.outcome).toBe(
          "key_conflict_cleared",
        )
        expect((await device(e.deviceId)).cert_key_sha256).toBeNull()
        expect((await permit(e.permitId)).status).toBe("expired")
      }
    })

    it("two permits created at once for one Mac: one open permit, the other superseded", async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const m = await mac()
        const opened = await Promise.all([
          createAcmePermit(db, { deviceId: m.deviceId }),
          createAcmePermit(db, { deviceId: m.deviceId }),
        ])
        const states = await Promise.all(opened.map((o) => permit(o.permitId)))
        expect(states.map((s) => s.status).sort()).toEqual(["expired", "open"])
      }
    })

    it("unbind-key racing AUTHORIZING (and its retry): never a deadlock, always a consistent row", async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const e = await enrolling()
        await liveness(e.deviceId)
        const body = e.body()
        const [first, unbound, retry] = await Promise.all([
          acme(body),
          unbindKey(db, { deviceId: e.deviceId }),
          acme(body),
        ])
        expect(typeof unbound).toBe("boolean")
        const d = await device(e.deviceId)
        const p = await permit(e.permitId)
        expect(p.status).toBe("authorized")
        expect(d.binds).toBe(0)
        // Either the unbind came last (no key), or the bind did (its own key);
        // never another key, and never a key without a first use.
        if (d.cert_key_sha256) {
          expect(d.cert_key_sha256.equals(e.key.sha)).toBe(true)
        }
        expect(d.first_used_at).not.toBeNull()
        expect(first.allow || retry.allow).toBe(true)
      }
    })

    it("an account lock held elsewhere (a revocation in flight) makes the hook wait, then see its result", async () => {
      const e = await enrolling()
      const body = e.body()
      const holder = await owner.reserve()
      try {
        await holder`begin`
        await holder`select 1 from authd.accounts where clerk_user_id = ${e.person} for no key update`
        await holder`update authd.accounts set suspended_at = now() where clerk_user_id = ${e.person}`
        const pending = acme(body)
        await Bun.sleep(150)
        await holder`commit`
        expect(await pending).toEqual({
          allow: false,
          outcome: "refused_mailbox_suspended",
        })
      } finally {
        holder.release()
      }
    })

    it("a lock held past the deadline ends the transaction inside Postgres, not later", async () => {
      const e = await enrolling()
      const holder = await owner.reserve()
      try {
        await holder`begin`
        await holder`select 1 from authd.accounts where clerk_user_id = ${e.person} for update`
        const started = Date.now()
        // Either limit may fire first: both are set to the time left.
        expect(["55P03", "57014"]).toContain(
          await hookFailure(acme(e.body(), deadlineFromNow(800))),
        )
        expect(Date.now() - started).toBeLessThan(1500)
      } finally {
        await holder`rollback`
        holder.release()
      }
      expect((await device(e.deviceId)).cert_key_sha256).toBeNull()
    })

    it("several waits share one deadline: each under a lock limit of its own, together past it, commit nothing", async () => {
      const e = await enrolling()
      const accountHolder = await owner.reserve()
      const deviceHolder = await owner.reserve()
      try {
        await accountHolder`begin`
        await accountHolder`select 1 from authd.accounts where clerk_user_id = ${e.person} for update`
        await deviceHolder`begin`
        await deviceHolder`select 1 from authd.mail_devices where id = ${e.deviceId} for update`
        const started = Date.now()
        let endedAt = 0
        const pending = hookFailure(acme(e.body(), deadlineFromNow(1000))).finally(
          () => {
            endedAt = Date.now()
          },
        )
        // 600 ms on the account and 600 more on the device: each far under the
        // old 2 s per statement, together past the 1 s deadline.
        await Bun.sleep(600)
        await accountHolder`commit`
        await Bun.sleep(600)
        await deviceHolder`commit`
        expect(["55P03", "57014"]).toContain(await pending)
        // It ended at the deadline, while the device lock was still held.
        expect(endedAt - started).toBeLessThan(1150)
      } finally {
        accountHolder.release()
        deviceHolder.release()
      }
      expect((await device(e.deviceId)).cert_key_sha256).toBeNull()
      expect((await permit(e.permitId)).status).toBe("open")
    })

    it("a handler that waits past its deadline for a pooled connection commits nothing", async () => {
      const e = await enrolling()
      const one = postgres(API_URL!, { max: 1, onnotice: () => {} })
      try {
        const busy = drizzle({ client: one }) as unknown as Database
        const slow = withDeadlines(
          createHookHandlers({
            db: busy,
            intermediateNotAfter: INTERMEDIATE_NOT_AFTER,
          }),
        )
        // The pool's only connection is busy for 700 ms, past the 500 ms deadline.
        // `.execute()` sends it now; a postgres.js query otherwise waits to be awaited.
        const hog = one`select pg_sleep(0.7)`.execute()
        await Bun.sleep(50)
        const outcome = await hookFailure(
          slow["acme-authorize"](e.body(), new Date(), deadlineFromNow(500)),
        )
        await hog
        expect(outcome).toBe("deadline")
      } finally {
        await one.end({ timeout: 5 })
      }
      expect((await device(e.deviceId)).cert_key_sha256).toBeNull()
      expect((await permit(e.permitId)).status).toBe("open")
    })

    it("a handler whose last statement ends after the deadline rolls back before it commits", async () => {
      const e = await enrolling()
      const deadline = deadlineFromNow(60_000)
      const dialect = new PgDialect()
      const realNow = Date.now
      let late = false
      // The permit's last write runs inside its limit; only then does the clock
      // pass the deadline, as a slow reply on the way back would.
      const watched = {
        transaction: (run: (tx: unknown) => Promise<unknown>) =>
          db.transaction((tx) =>
            run({
              execute: async (query: SQL) => {
                const result = await tx.execute(query)
                if (
                  dialect.sqlToQuery(query).sql.includes("set status = 'authorized'")
                ) {
                  late = true
                }
                return result
              },
            }),
          ),
      } as unknown as Database
      const handlers = withDeadlines(
        createHookHandlers({
          db: watched,
          intermediateNotAfter: INTERMEDIATE_NOT_AFTER,
        }),
      )
      try {
        Date.now = () => (late ? deadline.getTime() + 1 : realNow())
        expect(
          await hookFailure(handlers["acme-authorize"](e.body(), new Date(), deadline)),
        ).toBe("deadline")
      } finally {
        Date.now = realNow
      }
      expect(late).toBe(true)
      expect((await device(e.deviceId)).cert_key_sha256).toBeNull()
      expect((await permit(e.permitId)).status).toBe("open")
    })
  })
})
