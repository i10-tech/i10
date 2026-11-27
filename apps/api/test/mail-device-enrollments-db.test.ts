import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createPrivateKey } from "node:crypto"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { createEnrolldHandlers } from "../src/ca-hooks/enrolld.js"
import { createHookHandlers } from "../src/ca-hooks/handlers.js"
import { HANDLER_DEADLINE_MS } from "../src/ca-hooks/listener.js"
import type { Database } from "../src/db/client.js"
import { decryptCmsEnvelopedData } from "../src/mail-devices/cms.js"
import { parseDeviceCode, parseMailDeviceCodeKeys } from "../src/mail-devices/code.js"
import {
  attestEnrollment,
  cancelEnrollment,
  createEnrollment,
  finishEnrollment,
  getEnrollment,
  peekEnrollment,
  readMailboxTenant,
} from "../src/mail-devices/enrollments.js"
import { HookDeadlineExceeded, sha256 } from "../src/mail-devices/permits.js"
import { pruneMailDeviceEnrollments } from "../src/mail-devices/prune.js"
import { raiseEpochAndEndDevices, revoke } from "../src/mail-devices/store.js"
import {
  acmeBody,
  freshKey,
  scepAuthorizeBody,
  scepChallengeBody,
  scepNotifyBody,
} from "./support/ca-hooks.js"
import { createTestDeviceCa, type TestDeviceCa } from "./support/device-pki.js"

/**
 * End-to-end Postgres tests for `authd.mail_device_enrollments` and the full
 * Apple OTA enrollment lifecycle (#383 PR 4,
 * docs/research/mail-device-binding.md section 12 + Review 1 rules):
 *   - table grants (`authd` and `mailfront` have none; `i10_api` has DML)
 *   - every named CHECK, unique index, ON DELETE SET NULL, and account cascade
 *   - every store function: create, get, cancel, peek, attest, finish
 *   - full iOS + macOS flow through SCEP hooks, sealing, OpenSSL decrypt & ACME bind
 *   - repeat finish replay, M2 key-only matching, and refusal after revocation/expiry
 *   - concurrency races (revocation racing attest/finish/SCEP, double finish, double attest)
 *   - retention prune (`pruneMailDeviceEnrollments`)
 *   - measured per-request query counts (db-guard)
 *
 * Runs in CI under `bun run test:db` (never skips).
 */
const URL = process.env.TEMPLATES_TEST_DATABASE_URL
const API_URL = URL?.replace(/\/\/[^@]+@/, "//i10_api:i10_api@")
const suite = URL ? describe : describe.skip

const TEST_KEYS = parseMailDeviceCodeKeys(
  "1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=,7:gIGCg4SFhoeIiYqLjI2Oj5CRkpOUlZaXmJmam5ydnp+goaKjpKWmp6ipqqusra6v",
)
const INTERMEDIATE_NOT_AFTER = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000)

let owner: ReturnType<typeof postgres>
let api: ReturnType<typeof postgres>
let db: Database
let pki: TestDeviceCa
let hooks: ReturnType<typeof createHookHandlers>

const sfx = crypto.randomUUID().slice(0, 8)
const people: string[] = []
const tenants: string[] = []
let seq = 0
const tag = () => `${sfx}${(seq++).toString(36)}`
const deadlineFromNow = (ms = HANDLER_DEADLINE_MS) => new Date(Date.now() + ms)
const signerHash = (label: string) => sha256(`apple-signer/${sfx}/${label}`)

/** Captures Postgres constraint name or message without `expect(...).rejects` (hangs under bun 1.4.2). */
async function broken(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run()
    return null
  } catch (error) {
    const e = error as {
      constraint_name?: string
      cause?: { constraint_name?: string }
      message: string
    }
    return e.constraint_name ?? e.cause?.constraint_name ?? e.message
  }
}

async function failureCode(run: Promise<unknown>): Promise<string> {
  return run.then(
    () => "returned",
    (error: unknown) =>
      error instanceof HookDeadlineExceeded
        ? "deadline"
        : String(
            (error as { code?: string; cause?: { code?: string } })?.cause?.code ??
              (error as { code?: string })?.code ??
              error,
          ),
  )
}

async function createTenantAndPerson(options: { nullTenant?: boolean } = {}) {
  const t = tag()
  const person = `user_enr_${t}`
  people.push(person)
  let tenantId: string | null = null
  let domain = `i10-${sfx}.test`
  if (!options.nullTenant) {
    tenantId = crypto.randomUUID()
    tenants.push(tenantId)
    domain = `enr-${t}.test`
    await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id)
                values (${tenantId}, ${`enr-${t}`}, ${`Enr ${t}`}, ${person})`
    await owner`insert into core.domains (tenant_id, name, hosts_mailboxes, verified_at, status)
                values (${tenantId}, ${domain}, true, now(), 'verified')`
  }
  const email = `u-${t}@${domain}`
  await owner`insert into authd.accounts (clerk_user_id, email, active, tenant_id)
              values (${person}, ${email}, true, ${tenantId})`
  return { person, email, tenantId, domain }
}

/** What the console route does: read the mailbox's workspace, then create under it. */
async function createFor(on: Database, clerkUserId: string, hasCodeKeys: boolean) {
  const mailbox = await readMailboxTenant(on, clerkUserId)
  return createEnrollment(on, {
    clerkUserId,
    tenantId: mailbox?.tenantId ?? null,
    hasCodeKeys,
  })
}

function tokenFromUrl(url: string): string {
  const parts = url.split("/")
  return parts[parts.length - 1]!
}

function extractEncryptedCmsDer(profileXml: string): Buffer {
  const m = /<key>EncryptedPayloadContent<\/key>\s*<data>([^<]+)<\/data>/.exec(
    profileXml,
  )
  if (!m?.[1]) throw new Error("missing EncryptedPayloadContent")
  return Buffer.from(m[1], "base64")
}

function finishDeps() {
  return {
    keys: TEST_KEYS,
    deviceCaBundle: () => pki.bundle,
    imapHost: "mail.i10.tech",
    imapPort: 993,
    smtpHost: "mail.i10.tech",
    smtpPort: 465,
    organization: "i10",
  }
}

/** Runs create -> attest -> SCEP challenge -> SCEP authorize (+ optional notify) and returns leaf + handles. */
async function reachPhase4(options: {
  person: string
  product?: string
  version?: string
  serial?: string
  udid?: string
  deviceName?: string | null
  runNotify?: boolean
}) {
  const created = await createFor(db, options.person, true)
  if (!created.ok) throw new Error(`create failed: ${created.code}`)
  const token = tokenFromUrl(created.url)
  const serial = options.serial ?? `C02${tag().toUpperCase()}`
  const udid = options.udid ?? `UDID-${tag()}`
  const product = options.product ?? "iPhone17,2"
  const version = options.version ?? "22A3354"
  const deviceName =
    options.deviceName === undefined ? "Ada's Device" : options.deviceName

  const attested = await attestEnrollment(
    db,
    {
      token,
      udid,
      serial,
      product,
      version,
      deviceName,
      model: product,
      appleSignerSha256: signerHash(serial),
    },
    deadlineFromNow(),
  )
  if (attested.outcome !== "scep") {
    throw new Error(`attest failed: ${attested.reason}`)
  }

  const leaf = pki.issueLeaf({ subject: `/CN=${serial}` })
  const txnId = `txn-${tag()}`
  const now = new Date()

  const ch = await hooks["scep-challenge"](
    scepChallengeBody({
      challenge: attested.challenge,
      transactionId: txnId,
      commonName: serial,
      spki: leaf.spkiDer,
      now,
    }),
    now,
    deadlineFromNow(),
  )
  if (!ch.allow) throw new Error(`scep-challenge refused: ${ch.outcome}`)

  const authz = await hooks["scep-authorize"](
    scepAuthorizeBody({ commonName: serial, spki: leaf.spkiDer, now }),
    now,
    deadlineFromNow(),
  )
  if (!authz.allow) throw new Error(`scep-authorize refused: ${authz.outcome}`)

  if (options.runNotify !== false) {
    const notif = await hooks["scep-notify"](
      scepNotifyBody({ transactionId: txnId, der: leaf.der, now }),
      now,
      deadlineFromNow(),
    )
    if (!notif.allow) throw new Error(`scep-notify refused: ${notif.outcome}`)
  }

  return {
    enrollmentId: created.id,
    token,
    serial,
    udid,
    challenge: attested.challenge,
    leaf,
    txnId,
  }
}

suite("mail device enrollments against Postgres", () => {
  beforeAll(async () => {
    owner = postgres(URL!, { max: 4, onnotice: () => {} })
    api = postgres(API_URL!, { max: 10, onnotice: () => {} })
    db = drizzle({ client: api }) as unknown as Database
    pki = createTestDeviceCa()
    hooks = createHookHandlers({ db, intermediateNotAfter: INTERMEDIATE_NOT_AFTER })
  })

  afterAll(async () => {
    try {
      if (people.length > 0) {
        await owner`delete from authd.accounts where clerk_user_id = any(${`{${people.join(",")}}`}::text[])`
      }
      if (tenants.length > 0) {
        await owner`delete from core.tenants where id = any(${`{${tenants.join(",")}}`}::uuid[])`
      }
    } finally {
      pki.cleanup()
      await api.end({ timeout: 5 })
      await owner.end({ timeout: 5 })
    }
  })

  describe("grants, CHECK constraints, unique indexes, and FK cascades", () => {
    it("revokes all privileges on authd.mail_device_enrollments from authd and mailfront while keeping i10_api DML", async () => {
      for (const role of ["authd", "mailfront", "pdns", "stalwart"]) {
        for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
          const [row] = await owner<{ has: boolean }[]>`
            select has_table_privilege(${role}, 'authd.mail_device_enrollments', ${priv}) as has`
          expect({ role, priv, has: row!.has }).toEqual({ role, priv, has: false })
        }
      }
      for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        const [row] = await owner<{ has: boolean }[]>`
          select has_table_privilege('i10_api', 'authd.mail_device_enrollments', ${priv}) as has`
        expect({ priv, has: row!.has }).toEqual({ priv, has: true })
      }
    })

    it("enforces every named CHECK and partial unique index on authd.mail_device_enrollments", async () => {
      const { person, email } = await createTenantAndPerson()
      const [row] = await api<{ id: string }[]>`
        insert into authd.mail_device_enrollments
               (clerk_user_id, email, expected_epoch, token_sha256, status, created_by, expires_at)
        values (${person}, ${email}, 1, ${sha256(`chk/${tag()}`)}, 'open', ${person},
                now() + interval '15 minutes')
        returning id::text`
      const id = row!.id

      // Partial unique index: at most one live (open or attested) enrollment per person.
      expect(
        await broken(
          () => api`
            insert into authd.mail_device_enrollments
                   (clerk_user_id, email, expected_epoch, token_sha256, status, created_by, expires_at)
            values (${person}, ${email}, 1, ${sha256(`chk-dup/${tag()}`)}, 'open', ${person},
                    now() + interval '15 minutes')`,
        ),
      ).toBe("mail_device_enrollments_live_account_unique")

      const set = (expr: string) => () =>
        api.unsafe(`update authd.mail_device_enrollments set ${expr} where id = $1`, [
          id,
        ])
      const short = `'\\x${"01".repeat(31)}'`
      const h32 = `'\\x${"0a".repeat(32)}'`

      const cases: [string, () => Promise<unknown>, string][] = [
        [
          "uppercase email",
          set(`email = 'UPPER@TEST'`),
          "mail_device_enrollments_email_lowercase",
        ],
        [
          "invalid status",
          set(`status = 'bogus'`),
          "mail_device_enrollments_status_check",
        ],
        [
          "refused without reason",
          set(`status = 'refused'`),
          "mail_device_enrollments_refusal_state",
        ],
        [
          "open with refusal",
          set(`refusal = 'bad'`),
          "mail_device_enrollments_refusal_state",
        ],
        [
          "invalid platform",
          set(`platform = 'android'`),
          "mail_device_enrollments_platform_check",
        ],
        ["empty serial", set(`serial = ''`), "mail_device_enrollments_serial_check"],
        [
          "short token hash",
          set(`token_sha256 = ${short}`),
          "mail_device_enrollments_hash_lengths",
        ],
        [
          "short udid hash",
          set(`udid_sha256 = ${short}`),
          "mail_device_enrollments_hash_lengths",
        ],
        [
          "attested missing fields",
          set(`status = 'attested'`),
          "mail_device_enrollments_attested_state",
        ],
        [
          "sealed without sealed_profile",
          set(
            `status = 'sealed', serial = 'S1', product = 'iPhone17,2', os_version = '22A1',
             udid_sha256 = ${h32}, apple_signer_sha256 = ${h32}, platform = 'ios'`,
          ),
          "mail_device_enrollments_sealed_profile_state",
        ],
        [
          "open with sealed_profile",
          set(`sealed_profile = ${h32}`),
          "mail_device_enrollments_sealed_profile_state",
        ],
        [
          "expiry <= created_at",
          set(`expires_at = created_at`),
          "mail_device_enrollments_expiry_check",
        ],
      ]
      for (const [what, run, constraint] of cases) {
        expect({ what, broke: await broken(run) }).toEqual({ what, broke: constraint })
      }
    })

    it("device revoke sets device_id = null while keeping sealed; account delete cascades enrollments & permits", async () => {
      const { person } = await createTenantAndPerson()
      const flow = await reachPhase4({ person })
      const finished = await finishEnrollment(
        db,
        finishDeps(),
        { certDer: flow.leaf.der, udid: flow.udid },
        deadlineFromNow(),
      )
      expect(finished.outcome).toBe("sealed")
      if (finished.outcome !== "sealed") return

      const deviceId = finished.notice!.deviceId
      expect(
        await revoke(db, { deviceId, scope: { kind: "own", clerkUserId: person } }),
      ).not.toBeNull()

      const view = await getEnrollment(db, {
        id: flow.enrollmentId,
        clerkUserId: person,
      })
      expect(view?.status).toBe("sealed")
      expect(view?.deviceId).toBeNull()

      // Account deletion cascades enrollment and permits.
      await owner`delete from authd.accounts where clerk_user_id = ${person}`
      const leftEnroll =
        await owner`select 1 from authd.mail_device_enrollments where id = ${flow.enrollmentId}`
      const leftPermits =
        await owner`select 1 from authd.mail_device_cert_permits where enrollment_id = ${flow.enrollmentId}`
      expect(leftEnroll).toHaveLength(0)
      expect(leftPermits).toHaveLength(0)
    })
  })

  describe("store lifecycle: create, get, cancel, peek, attest, finish", () => {
    it("creates, supersedes prior live enrollment + SCEP permits, enforces tenant/owner isolation on get & cancel", async () => {
      const a = await createTenantAndPerson()
      const b = await createTenantAndPerson()
      const i10User = await createTenantAndPerson({ nullTenant: true })

      // keys_not_configured -> 503
      expect(await createFor(db, a.person, false)).toEqual({
        ok: false,
        status: 503,
        code: "keys_not_configured",
      })

      // no_mailbox -> 409
      expect(await createFor(db, "user_nonexistent_xyz", true)).toEqual({
        ok: false,
        status: 409,
        code: "no_mailbox",
      })

      // The mailbox moved workspace after the route ran the old one's policies:
      // refused under the account lock, and nothing is created.
      const moved = await createEnrollment(db, {
        clerkUserId: a.person,
        tenantId: null,
        hasCodeKeys: true,
      })
      expect(moved).toEqual({ ok: false, status: 409, code: "tenant_mismatch" })
      const [left] =
        await owner`select count(*)::int as n from authd.mail_device_enrollments
                                 where clerk_user_id = ${a.person}`
      expect(left).toEqual({ n: 0 })

      // Null-tenant (i10.tech) user can enroll and poll.
      const sys = await createFor(db, i10User.person, true)
      expect(sys.ok).toBe(true)
      if (sys.ok) {
        expect(
          await getEnrollment(db, { id: sys.id, clerkUserId: i10User.person }),
        ).toMatchObject({
          id: sys.id,
          status: "open",
          needsMailSetup: false,
        })
      }

      // Create & attest first enrollment for `a`, opening a SCEP permit.
      const first = await createFor(db, a.person, true)
      expect(first.ok).toBe(true)
      if (!first.ok) return
      const tok1 = tokenFromUrl(first.url)
      expect(tok1).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(await peekEnrollment(db, tok1, deadlineFromNow())).toEqual({ live: true })

      const att = await attestEnrollment(
        db,
        {
          token: tok1,
          udid: "UDID-1",
          serial: `S1${tag().toUpperCase()}`,
          product: "iPhone17,2",
          version: "22A3354",
          deviceName: "Ada's iPhone",
          model: "iPhone17,2",
          appleSignerSha256: signerHash("att1"),
        },
        deadlineFromNow(),
      )
      expect(att.outcome).toBe("scep")

      // Cross-tenant / other person GET & DELETE return null / not_found (404 at route).
      expect(
        await getEnrollment(db, { id: first.id, clerkUserId: b.person }),
      ).toBeNull()
      expect(await cancelEnrollment(db, { id: first.id, clerkUserId: b.person })).toBe(
        "not_found",
      )

      // Creating a second enrollment cancels the first AND expires its SCEP permit.
      const second = await createFor(db, a.person, true)
      expect(second.ok).toBe(true)
      if (!second.ok) return
      expect(
        await getEnrollment(db, { id: first.id, clerkUserId: a.person }),
      ).toMatchObject({
        status: "cancelled",
      })
      const [firstPermit] = await owner<{ status: string }[]>`
        select status from authd.mail_device_cert_permits where enrollment_id = ${first.id}`
      expect(firstPermit?.status).toBe("expired")
      expect(await peekEnrollment(db, tok1, deadlineFromNow())).toEqual({ live: false })

      // Cancel second enrollment -> cancelled, peek false.
      const tok2 = tokenFromUrl(second.url)
      expect(await cancelEnrollment(db, { id: second.id, clerkUserId: a.person })).toBe(
        "cancelled",
      )
      expect(await peekEnrollment(db, tok2, deadlineFromNow())).toEqual({ live: false })
      expect(
        await getEnrollment(db, { id: second.id, clerkUserId: a.person }),
      ).toMatchObject({
        status: "cancelled",
      })

      // Expired open enrollment reads as `expired` on GET and `live: false` on peek.
      const third = await createFor(db, a.person, true)
      expect(third.ok).toBe(true)
      if (!third.ok) return
      await owner`update authd.mail_device_enrollments
                     set created_at = now() - interval '20 minutes',
                         expires_at = now() - interval '1 minute'
                   where id = ${third.id}`
      expect(
        await getEnrollment(db, { id: third.id, clerkUserId: a.person }),
      ).toMatchObject({
        status: "expired",
      })
      expect(
        await peekEnrollment(db, tokenFromUrl(third.url), deadlineFromNow()),
      ).toEqual({
        live: false,
      })
    })

    it("handles attest retries (expiring old SCEP permit, capping at 30m), mismatch refusals, and platform refusals", async () => {
      const { person } = await createTenantAndPerson()
      const created = await createFor(db, person, true)
      if (!created.ok) throw new Error(created.code)
      const token = tokenFromUrl(created.url)
      const serial = `C02${tag().toUpperCase()}`
      const req = {
        token,
        udid: "UDID-RETRY-1",
        serial,
        product: "Mac14,2",
        version: "24D70",
        deviceName: "Ada MacBook",
        model: "Mac14,2",
        appleSignerSha256: signerHash("retry"),
      }

      const first = await attestEnrollment(db, req, deadlineFromNow())
      expect(first.outcome).toBe("scep")

      // Retry with different serial, UDID, or signer is refused without disturbing the live permit.
      expect(
        await attestEnrollment(db, { ...req, serial: "C02OTHER" }, deadlineFromNow()),
      ).toEqual({ outcome: "refused", reason: "attest_mismatch" })
      expect(
        await attestEnrollment(db, { ...req, udid: "UDID-OTHER" }, deadlineFromNow()),
      ).toEqual({ outcome: "refused", reason: "attest_mismatch" })
      expect(
        await attestEnrollment(
          db,
          { ...req, appleSignerSha256: signerHash("other-signer") },
          deadlineFromNow(),
        ),
      ).toEqual({ outcome: "refused", reason: "attest_mismatch" })

      // Backdate created_at by 25 minutes so retry hits the 30-minute hard ceiling (only 5m left).
      await owner`update authd.mail_device_enrollments
                     set created_at = now() - interval '25 minutes'
                   where id = ${created.id}`
      const retry = await attestEnrollment(db, req, deadlineFromNow())
      expect(retry.outcome).toBe("scep")
      if (first.outcome === "scep" && retry.outcome === "scep") {
        expect(retry.challenge).not.toBe(first.challenge)
      }

      const permits = await owner<{ status: string; secs_left: number }[]>`
        select status, extract(epoch from expires_at - now())::int as secs_left
          from authd.mail_device_cert_permits
         where enrollment_id = ${created.id}
         order by created_at asc`
      expect(permits.map((p) => p.status)).toEqual(["expired", "open"])
      expect(permits[1]!.secs_left).toBeLessThanOrEqual(305)
      expect(permits[1]!.secs_left).toBeGreaterThan(240)

      // Platform refusal marks enrollment `refused` with the refusal word.
      const intel = await createFor(db, person, true)
      if (!intel.ok) throw new Error(intel.code)
      expect(
        await attestEnrollment(
          db,
          {
            ...req,
            token: tokenFromUrl(intel.url),
            product: "MacBookPro16,1",
            version: "24D70",
          },
          deadlineFromNow(),
        ),
      ).toEqual({ outcome: "refused", reason: "mac_not_apple_silicon" })
      expect(
        await getEnrollment(db, { id: intel.id, clerkUserId: person }),
      ).toMatchObject({
        status: "refused",
        refusal: "mac_not_apple_silicon",
        model: "MacBookPro16,1",
      })
    })

    it("runs full Mac flow: phase 4 finish mints device + ACME permit in one tx, seals profile, replays identically, and ACME hook binds using decrypted nonce", async () => {
      const { person, email } = await createTenantAndPerson()
      const flow = await reachPhase4({
        person,
        product: "Mac14,2",
        version: "24D70",
        deviceName: "Ada's MacBook Air",
      })

      const finished = await finishEnrollment(
        db,
        finishDeps(),
        { certDer: flow.leaf.der, udid: flow.udid },
        deadlineFromNow(),
      )
      expect(finished.outcome).toBe("sealed")
      if (finished.outcome !== "sealed") return
      expect(finished.replayed).toBe(false)
      expect(finished.notice).toMatchObject({
        email,
        platform: "macos",
        model: "Mac14,2",
        serialLast4: flow.serial.slice(-4),
      })

      // Console GET shows sealed + needsMailSetup = true; DELETE returns already_sealed.
      const view = await getEnrollment(db, {
        id: flow.enrollmentId,
        clerkUserId: person,
      })
      expect(view).toMatchObject({
        id: flow.enrollmentId,
        status: "sealed",
        platform: "macos",
        model: "Mac14,2",
        deviceName: "Ada's MacBook Air",
        deviceId: finished.notice!.deviceId,
        needsMailSetup: true,
      })
      expect(
        await cancelEnrollment(db, { id: flow.enrollmentId, clerkUserId: person }),
      ).toBe("already_sealed")

      // Decrypt sealed profile with OpenSSL AND node:crypto, extract code & ACME nonce.
      const cmsDer = extractEncryptedCmsDer(finished.profile.toString("utf8"))
      const innerOpenssl = pki.decryptCmsWithOpenssl(cmsDer, flow.leaf).toString("utf8")
      const innerNode = decryptCmsEnvelopedData(
        cmsDer,
        createPrivateKey(flow.leaf.keyPem),
      ).plaintext.toString("utf8")
      expect(innerOpenssl).toBe(innerNode)

      const codeMatch = /<key>IncomingPassword<\/key>\s*<string>([^<]+)<\/string>/.exec(
        innerOpenssl,
      )
      const parsedCode = parseDeviceCode(codeMatch![1]!)
      expect(parsedCode?.id).toBe(finished.notice!.deviceId)

      const nonceMatch = /<string>OU<\/string>\s*<string>([^<]+)<\/string>/.exec(
        innerOpenssl,
      )
      expect(nonceMatch?.[1]).toBeTruthy()

      // Step-ca ACME AUTHORIZING succeeds with the decrypted OU nonce and binds the Mac key!
      const macKey = freshKey()
      const acmeDecision = await hooks["acme-authorize"](
        acmeBody({
          serial: flow.serial,
          nonce: nonceMatch![1]!,
          spki: macKey.spki,
          now: new Date(),
        }),
        new Date(),
        deadlineFromNow(),
      )
      expect(acmeDecision).toEqual({ allow: true, outcome: "allowed" })

      // Repeat finish from the same key returns the EXACT same sealed bytes and mints nothing.
      const replay = await finishEnrollment(
        db,
        finishDeps(),
        { certDer: flow.leaf.der, udid: flow.udid },
        deadlineFromNow(),
      )
      expect(replay.outcome).toBe("sealed")
      if (replay.outcome === "sealed") {
        expect(replay.replayed).toBe(true)
        expect(replay.notice).toBeUndefined()
        expect(replay.profile.equals(finished.profile)).toBe(true)
      }
      const [devCount] = await owner<{ n: number }[]>`
        select count(*)::int as n from authd.mail_devices where clerk_user_id = ${person}`
      expect(devCount!.n).toBe(1)

      // Repeat finish with wrong UDID is refused.
      expect(
        await finishEnrollment(
          db,
          finishDeps(),
          { certDer: flow.leaf.der, udid: "WRONG-UDID" },
          deadlineFromNow(),
        ),
      ).toEqual({ outcome: "refused", reason: "udid_mismatch" })

      // Repeat finish after expiry is refused.
      await owner`update authd.mail_device_enrollments
                     set created_at = now() - interval '20 minutes',
                         expires_at = now() - interval '1 minute'
                   where id = ${flow.enrollmentId}`
      expect(
        await finishEnrollment(
          db,
          finishDeps(),
          { certDer: flow.leaf.der, udid: flow.udid },
          deadlineFromNow(),
        ),
      ).toEqual({ outcome: "refused", reason: "enrollment_not_live" })
    })

    it("M2: matches finish by key only (works without NOTIFYING, and with a second cert for the same key)", async () => {
      // 1. Works when NOTIFYING never ran (`authorized` state).
      const a = await createTenantAndPerson()
      const flowA = await reachPhase4({ person: a.person, runNotify: false })
      const resA = await finishEnrollment(
        db,
        finishDeps(),
        { certDer: flowA.leaf.der, udid: null },
        deadlineFromNow(),
      )
      expect(resA.outcome).toBe("sealed")

      // 2. Works when NOTIFYING recorded cert 1, then step-ca signed cert 2 for the SAME key.
      const b = await createTenantAndPerson()
      const flowB = await reachPhase4({ person: b.person, runNotify: true })
      const secondCertSameKey = pki.issueLeaf({
        subject: `/CN=${flowB.serial}`,
        existingKeyPath: flowB.leaf.keyPath,
      })
      expect(secondCertSameKey.keySha256.equals(flowB.leaf.keySha256)).toBe(true)
      expect(secondCertSameKey.certSha256.equals(flowB.leaf.certSha256)).toBe(false)

      const resB = await finishEnrollment(
        db,
        finishDeps(),
        { certDer: secondCertSameKey.der, udid: flowB.udid },
        deadlineFromNow(),
      )
      expect(resB.outcome).toBe("sealed")
    })

    it("M2: a key from a superseded SCEP permit never gets the sealed profile back", async () => {
      const { person } = await createTenantAndPerson()
      const product = "iPhone17,2"
      const version = "22A3354"
      const flow = await reachPhase4({ person, product, version })

      // The device retries phase 2: the first permit (already authorized for
      // flow.leaf) is expired and a second one opens; the device enrolls again.
      const retry = await attestEnrollment(
        db,
        {
          token: flow.token,
          udid: flow.udid,
          serial: flow.serial,
          product,
          version,
          deviceName: "Ada's Device",
          model: product,
          appleSignerSha256: signerHash(flow.serial),
        },
        deadlineFromNow(),
      )
      if (retry.outcome !== "scep") throw new Error(`retry failed: ${retry.reason}`)
      const second = pki.issueLeaf({ subject: `/CN=${flow.serial}` })
      const now = new Date()
      const txnId = `txn-${tag()}`
      const ch = await hooks["scep-challenge"](
        scepChallengeBody({
          challenge: retry.challenge,
          transactionId: txnId,
          commonName: flow.serial,
          spki: second.spkiDer,
          now,
        }),
        now,
        deadlineFromNow(),
      )
      expect(ch.allow).toBe(true)
      const authz = await hooks["scep-authorize"](
        scepAuthorizeBody({ commonName: flow.serial, spki: second.spkiDer, now }),
        now,
        deadlineFromNow(),
      )
      expect(authz.allow).toBe(true)

      const sealed = await finishEnrollment(
        db,
        finishDeps(),
        { certDer: second.der, udid: flow.udid },
        deadlineFromNow(),
      )
      expect(sealed.outcome).toBe("sealed")

      const stale = await finishEnrollment(
        db,
        finishDeps(),
        { certDer: flow.leaf.der, udid: flow.udid },
        deadlineFromNow(),
      )
      expect(stale).toEqual({ outcome: "refused", reason: "no_permit" })
    })

    it("enrolld/attest cuts a long device name to 128 characters instead of refusing it", async () => {
      const { person } = await createTenantAndPerson()
      const created = await createFor(db, person, true)
      if (!created.ok) throw new Error(created.code)
      const handlers = createEnrolldHandlers({
        db,
        keys: TEST_KEYS,
        deviceCaBundle: () => pki.bundle,
        imapHost: "mail.i10.tech",
        imapPort: 993,
        smtpHost: "mail.i10.tech",
        smtpPort: 465,
        organization: "i10",
        log: { info: () => {}, warn: () => {}, error: () => {} },
      })
      const serial = `C02L${tag().toUpperCase()}`
      const res = await handlers.attest(
        {
          token: tokenFromUrl(created.url),
          udid: `UDID-${tag()}`,
          serial,
          product: "iPhone17,2",
          version: "22A3354",
          deviceName: "Ada's iPhone ".repeat(4) + "é".repeat(150),
          model: null,
          appleSignerSha256: signerHash(serial).toString("hex"),
        },
        new Date(),
        deadlineFromNow(),
      )
      expect(res.body.outcome).toBe("scep")
      const [row] = await owner`select device_name from authd.mail_device_enrollments
                                where id = ${created.id}`
      expect(Array.from(row!.device_name as string)).toHaveLength(128)
      expect(row!.device_name).toStartWith("Ada's iPhone Ada's")
    })

    it("enrolld/finish handler sends notice after commit and still returns sealed if notice throws", async () => {
      const { person, email } = await createTenantAndPerson()
      const flow = await reachPhase4({ person })
      const errors: Record<string, unknown>[] = []
      let noticeCalled = 0
      const handlers = createEnrolldHandlers({
        db,
        keys: TEST_KEYS,
        deviceCaBundle: () => pki.bundle,
        imapHost: "mail.i10.tech",
        imapPort: 993,
        smtpHost: "mail.i10.tech",
        smtpPort: 465,
        organization: "i10",
        notifyEnrolled: async (payload) => {
          noticeCalled++
          expect(payload.email).toBe(email)
          throw new Error("simulated SMTP/queue outage")
        },
        log: {
          info: () => {},
          warn: () => {},
          error: (fields) => errors.push(fields),
        },
      })

      const res = await handlers.finish(
        { certDer: flow.leaf.der.toString("base64"), udid: flow.udid },
        new Date(),
        deadlineFromNow(),
      )
      expect(res.outcome).toBe("sealed")
      expect(res.body.outcome).toBe("sealed")
      expect(typeof res.body.profile).toBe("string")
      // The notice runs after the answer; let it settle before reading its effects.
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(noticeCalled).toBe(1)
      expect(errors).toEqual([
        { hook: "enrolld/finish", outcome: "notice_failed", errorName: "Error" },
      ])

      // Replay does NOT re-send the notice.
      const replay = await handlers.finish(
        { certDer: flow.leaf.der.toString("base64"), udid: flow.udid },
        new Date(),
        deadlineFromNow(),
      )
      expect(replay.outcome).toBe("sealed_replay")
      expect(noticeCalled).toBe(1)
    })

    it("enrolld/finish answers without waiting for a notice that never settles", async () => {
      const { person } = await createTenantAndPerson()
      const flow = await reachPhase4({ person })
      const handlers = createEnrolldHandlers({
        db,
        keys: TEST_KEYS,
        deviceCaBundle: () => pki.bundle,
        imapHost: "mail.i10.tech",
        imapPort: 993,
        smtpHost: "mail.i10.tech",
        smtpPort: 465,
        organization: "i10",
        notifyEnrolled: () => new Promise<void>(() => {}),
        log: { info: () => {}, warn: () => {}, error: () => {} },
      })
      const res = await handlers.finish(
        { certDer: flow.leaf.der.toString("base64"), udid: flow.udid },
        new Date(),
        deadlineFromNow(),
      )
      expect(res.outcome).toBe("sealed")
    })
  })

  describe("concurrency races and Postgres deadlines", () => {
    const ROUNDS = 8

    it("two concurrent finish calls for one enrollment: zero deadlocks, one mint, identical bytes", async () => {
      for (let i = 0; i < ROUNDS; i++) {
        const { person } = await createTenantAndPerson()
        const flow = await reachPhase4({ person })
        const [a, b] = await Promise.all([
          finishEnrollment(
            db,
            finishDeps(),
            { certDer: flow.leaf.der, udid: flow.udid },
            deadlineFromNow(),
          ),
          finishEnrollment(
            db,
            finishDeps(),
            { certDer: flow.leaf.der, udid: flow.udid },
            deadlineFromNow(),
          ),
        ])
        expect(a.outcome).toBe("sealed")
        expect(b.outcome).toBe("sealed")
        if (a.outcome === "sealed" && b.outcome === "sealed") {
          expect([a.replayed, b.replayed].sort()).toEqual([false, true])
          expect(a.profile.equals(b.profile)).toBe(true)
        }
        const [cnt] = await owner<{ n: number }[]>`
          select count(*)::int as n from authd.mail_devices where clerk_user_id = ${person}`
        expect(cnt!.n).toBe(1)
      }
    })

    it("revocation racing finish: never deadlocks and never leaves a surviving device", async () => {
      for (let i = 0; i < ROUNDS; i++) {
        const { person, tenantId } = await createTenantAndPerson()
        const flow = await reachPhase4({ person })
        const [fin, rev] = await Promise.all([
          finishEnrollment(
            db,
            finishDeps(),
            { certDer: flow.leaf.der, udid: flow.udid },
            deadlineFromNow(),
          ),
          raiseEpochAndEndDevices(db, { tenantId: tenantId!, clerkUserId: person }),
        ])
        expect(typeof rev.devicesEnded).toBe("number")
        if (fin.outcome === "refused") {
          expect(fin.reason).toBe("epoch_mismatch")
        }
        // Either revocation ran first (finish refused) or finish ran first (revocation deleted it):
        // either way, ZERO devices survive.
        const [cnt] = await owner<{ n: number }[]>`
          select count(*)::int as n from authd.mail_devices where clerk_user_id = ${person}`
        expect(cnt!.n).toBe(0)
      }
    })

    it("revocation racing attest and SCEP hooks: zero deadlocks, consistent state", async () => {
      for (let i = 0; i < ROUNDS; i++) {
        const { person, tenantId } = await createTenantAndPerson()
        const created = await createFor(db, person, true)
        if (!created.ok) throw new Error(created.code)
        const token = tokenFromUrl(created.url)
        const serial = `C02R${tag().toUpperCase()}`
        const [att] = await Promise.all([
          attestEnrollment(
            db,
            {
              token,
              udid: `UDID-R-${i}`,
              serial,
              product: "iPhone17,2",
              version: "22A3354",
              deviceName: null,
              model: "iPhone17,2",
              appleSignerSha256: signerHash(`race-att-${i}`),
            },
            deadlineFromNow(),
          ),
          raiseEpochAndEndDevices(db, { tenantId: tenantId!, clerkUserId: person }),
        ])
        // If attest committed first, SCEP challenge MUST now refuse on epoch_mismatch.
        if (att.outcome === "scep") {
          const leaf = pki.issueLeaf({ subject: `/CN=${serial}` })
          const ch = await hooks["scep-challenge"](
            scepChallengeBody({
              challenge: att.challenge,
              transactionId: `txn-r-${tag()}`,
              commonName: serial,
              spki: leaf.spkiDer,
              now: new Date(),
            }),
            new Date(),
            deadlineFromNow(),
          )
          expect(ch).toEqual({ allow: false, outcome: "refused_epoch_mismatch" })
        } else {
          expect(att.reason).toBe("epoch_mismatch")
        }
      }

      // Revocation racing SCEP authorize directly.
      for (let i = 0; i < ROUNDS; i++) {
        const { person, tenantId } = await createTenantAndPerson()
        const created = await createFor(db, person, true)
        if (!created.ok) throw new Error(created.code)
        const serial = `C02S${tag().toUpperCase()}`
        const att = await attestEnrollment(
          db,
          {
            token: tokenFromUrl(created.url),
            udid: `UDID-S-${i}`,
            serial,
            product: "iPhone17,2",
            version: "22A3354",
            deviceName: null,
            model: "iPhone17,2",
            appleSignerSha256: signerHash(`race-scep-${i}`),
          },
          deadlineFromNow(),
        )
        if (att.outcome !== "scep") throw new Error(att.reason)
        const leaf = pki.issueLeaf({ subject: `/CN=${serial}` })
        await hooks["scep-challenge"](
          scepChallengeBody({
            challenge: att.challenge,
            transactionId: `txn-s-${tag()}`,
            commonName: serial,
            spki: leaf.spkiDer,
            now: new Date(),
          }),
          new Date(),
          deadlineFromNow(),
        )
        const [authz] = await Promise.all([
          hooks["scep-authorize"](
            scepAuthorizeBody({
              commonName: serial,
              spki: leaf.spkiDer,
              now: new Date(),
            }),
            new Date(),
            deadlineFromNow(),
          ),
          raiseEpochAndEndDevices(db, { tenantId: tenantId!, clerkUserId: person }),
        ])
        if (!authz.allow) {
          expect(authz.outcome).toBe("refused_epoch_mismatch")
        } else {
          // Authorize won before epoch raise -> finish MUST still refuse on epoch_mismatch.
          expect(
            await finishEnrollment(
              db,
              finishDeps(),
              { certDer: leaf.der, udid: `UDID-S-${i}` },
              deadlineFromNow(),
            ),
          ).toEqual({ outcome: "refused", reason: "epoch_mismatch" })
        }
      }
    })

    it("concurrent attest retries and concurrent createEnrollment: zero deadlocks, single live row", async () => {
      const { person } = await createTenantAndPerson()
      const created = await Promise.all([
        createFor(db, person, true),
        createFor(db, person, true),
      ])
      expect(created.every((c) => c.ok)).toBe(true)
      const [liveCount] = await owner<{ n: number }[]>`
        select count(*)::int as n from authd.mail_device_enrollments
         where clerk_user_id = ${person} and status in ('open', 'attested')`
      expect(liveCount!.n).toBe(1)

      const live = await owner<{ id: string }[]>`
        select id::text as id from authd.mail_device_enrollments
         where clerk_user_id = ${person} and status = 'open'`
      const winner = created.find((c) => c.ok && c.id === live[0]!.id)
      if (!winner || !winner.ok) throw new Error("missing live enrollment")
      const req = {
        token: tokenFromUrl(winner.url),
        udid: "UDID-CONC",
        serial: `C02C${tag().toUpperCase()}`,
        product: "iPhone17,2",
        version: "22A3354",
        deviceName: null,
        model: "iPhone17,2",
        appleSignerSha256: signerHash("conc"),
      }
      const [r1, r2] = await Promise.all([
        attestEnrollment(db, req, deadlineFromNow()),
        attestEnrollment(db, req, deadlineFromNow()),
      ])
      expect(r1.outcome).toBe("scep")
      expect(r2.outcome).toBe("scep")
      const [openPermits] = await owner<{ n: number }[]>`
        select count(*)::int as n from authd.mail_device_cert_permits
         where enrollment_id = ${winner.id} and status = 'open'`
      expect(openPermits!.n).toBe(1)
    })

    it("respects Postgres lock_timeout / statement_timeout deadline on finish", async () => {
      const { person } = await createTenantAndPerson()
      const flow = await reachPhase4({ person })
      const holder = await owner.reserve()
      try {
        await holder`begin`
        await holder`select 1 from authd.accounts where clerk_user_id = ${person} for update`
        const code = await failureCode(
          finishEnrollment(
            db,
            finishDeps(),
            { certDer: flow.leaf.der, udid: flow.udid },
            deadlineFromNow(600),
          ),
        )
        expect(["55P03", "57014"]).toContain(code)
      } finally {
        await holder`rollback`
        holder.release()
      }
      const [cnt] = await owner<{ n: number }[]>`
        select count(*)::int as n from authd.mail_devices where clerk_user_id = ${person}`
      expect(cnt!.n).toBe(0)
    })
  })

  describe("retention", () => {
    it("deletes enrollments a day past expiry in batches (cascading SCEP permits) and keeps newer rows", async () => {
      const { person, email } = await createTenantAndPerson()
      const ids: string[] = []
      const permitIds: string[] = []
      for (const age of ["25 hours", "26 hours", "27 hours", "23 hours"]) {
        const [e] = await owner<{ id: string }[]>`
          insert into authd.mail_device_enrollments
                 (clerk_user_id, email, expected_epoch, token_sha256, status,
                  created_by, created_at, expires_at)
          values (${person}, ${email}, 1, ${sha256(`ret/${tag()}`)}, 'expired', 'test',
                  now() - ${age}::interval - interval '15 minutes', now() - ${age}::interval)
          returning id::text`
        ids.push(e!.id)
        const [p] = await owner<{ id: string }[]>`
          insert into authd.mail_device_cert_permits
                 (clerk_user_id, enrollment_id, kind, status, serial, challenge_hash,
                  created_at, expires_at)
          values (${person}, ${e!.id}, 'scep', 'expired', 'C02RET', ${sha256(`retp/${tag()}`)},
                  now() - ${age}::interval - interval '15 minutes', now() - ${age}::interval)
          returning id::text`
        permitIds.push(p!.id)
      }

      const pruned = await pruneMailDeviceEnrollments(db, { batchSize: 2 })
      expect(pruned).toBeGreaterThanOrEqual(3)

      const [leftEnroll] = await owner<{ ids: string[] }[]>`
        select coalesce(array_agg(id::text), '{}') as ids from authd.mail_device_enrollments
         where id = any(${`{${ids.join(",")}}`}::uuid[])`
      expect(leftEnroll!.ids).toEqual([ids[3]!])

      const [leftPermits] = await owner<{ ids: string[] }[]>`
        select coalesce(array_agg(id::text), '{}') as ids from authd.mail_device_cert_permits
         where id = any(${`{${permitIds.join(",")}}`}::uuid[])`
      expect(leftPermits!.ids).toEqual([permitIds[3]!])
    })
  })

  describe("measured per-request query counts (db-guard)", () => {
    it("pins the statement count of each enrollment call (db-guard query counts)", async () => {
      const seen: string[] = []
      const countedSql = postgres(API_URL!, {
        max: 2,
        onnotice: () => {},
        debug: (_conn, query) => {
          const trimmed = query.trim().toLowerCase()
          if (
            trimmed === "begin" ||
            trimmed === "commit" ||
            trimmed === "rollback" ||
            trimmed.startsWith("select set_config(")
          ) {
            return
          }
          seen.push(trimmed)
        },
      })
      const countedDb = drizzle({ client: countedSql }) as unknown as Database
      try {
        // Warm postgres.js's one-time pg_type catalog bootstrap query before measuring.
        await countedSql`select 1`
        const measure = async <T>(fn: () => Promise<T>) => {
          seen.length = 0
          const value = await fn()
          return { value, queries: seen.length }
        }

        const { person } = await createTenantAndPerson()
        const c1 = await measure(() => createFor(countedDb, person, true))
        const c1Val = c1.value
        if (!c1Val.ok) throw new Error(c1Val.code)
        // Fresh create: readMailboxTenant, then lockGateAccount, update(cancel 0
        // rows), insert = 4 SQL statements.
        expect(c1.queries).toBe(4)

        const g1 = await measure(() =>
          getEnrollment(countedDb, { id: c1Val.id, clerkUserId: person }),
        )
        expect(g1.queries).toBe(1)

        const p1 = await measure(() =>
          peekEnrollment(countedDb, tokenFromUrl(c1Val.url), deadlineFromNow()),
        )
        expect(p1.queries).toBe(1)

        const serial = `C02Q${tag().toUpperCase()}`
        const a1 = await measure(() =>
          attestEnrollment(
            countedDb,
            {
              token: tokenFromUrl(c1Val.url),
              udid: "UDID-QC",
              serial,
              product: "Mac14,2",
              version: "24D70",
              deviceName: "QC Mac",
              model: "Mac14,2",
              appleSignerSha256: signerHash("qc"),
            },
            deadlineFromNow(),
          ),
        )
        if (a1.value.outcome !== "scep") throw new Error(a1.value.reason)
        // Attest: unlocked read, lockAccount, lockEnrollment, update enrollment,
        // expire old permits, insert scep permit = 6 SQL statements.
        expect(a1.queries).toBe(6)

        // Superseding create also expires the prior enrollment's permits = 5 SQL statements.
        const c2 = await measure(() => createFor(countedDb, person, true))
        const c2Val = c2.value
        if (!c2Val.ok) throw new Error(c2Val.code)
        expect(c2.queries).toBe(5)

        const d1 = await measure(() =>
          cancelEnrollment(countedDb, { id: c2Val.id, clerkUserId: person }),
        )
        // Cancel: unlocked read, lockAccount, lockEnrollment, update enrollment, expire permits = 5 SQL statements.
        expect(d1.value).toBe("cancelled")
        expect(d1.queries).toBe(5)

        // Finish (iOS vs Mac) and repeat finish
        const flowIos = await reachPhase4({
          person,
          product: "iPhone17,2",
          version: "22A3354",
        })
        const finIos = await measure(() =>
          finishEnrollment(
            countedDb,
            finishDeps(),
            { certDer: flowIos.leaf.der, udid: flowIos.udid },
            deadlineFromNow(),
          ),
        )
        expect(finIos.value.outcome).toBe("sealed")
        expect(finIos.queries).toBe(8)

        const finReplay = await measure(() =>
          finishEnrollment(
            countedDb,
            finishDeps(),
            { certDer: flowIos.leaf.der, udid: flowIos.udid },
            deadlineFromNow(),
          ),
        )
        expect(finReplay.value.outcome).toBe("sealed")
        expect(finReplay.queries).toBe(5)

        const flowMac = await reachPhase4({
          person,
          product: "Mac14,2",
          version: "24D70",
        })
        const finMac = await measure(() =>
          finishEnrollment(
            countedDb,
            finishDeps(),
            { certDer: flowMac.leaf.der, udid: flowMac.udid },
            deadlineFromNow(),
          ),
        )
        expect(finMac.value.outcome).toBe("sealed")
        expect(finMac.queries).toBe(13)
      } finally {
        await countedSql.end({ timeout: 5 })
      }
    })
  })
})
