import { randomBytes, timingSafeEqual } from "node:crypto"
import { sql } from "drizzle-orm"
import type { Database } from "../db/client.js"
import { MailDeviceError } from "./code.js"
import {
  bindRefusal,
  clearDeviceKey,
  deviceKeyRefusal,
  deviceOwner,
  isUniqueViolation,
  lockDevice,
  lockGateAccount,
  mintRefusal,
  setDeviceKey,
  type LockedDevice,
  type MintGateAccount,
} from "./store.js"

/**
 * Certificate permits (#383 PR 3, PR 4): the device CA's only way to issue
 * (docs/research/mail-device-binding.md sections 11 & 12). Every API read or
 * write of `authd.mail_device_cert_permits` goes through this module (plus
 * `enrollments.ts` for SCEP permit creation and expiry).
 *
 * ⚠ LOCK ORDER (Review 1 L3): read the permit WITHOUT a lock, then lock
 * `authd.accounts` (`FOR NO KEY UPDATE`), then `authd.mail_device_enrollments`
 * (for SCEP), then `authd.mail_devices` (for ACME), then the permit, and
 * re-check it under the lock. A revocation takes accounts, then devices, then
 * (by cascade) permits, so the two can never wait on each other in a cycle.
 * Nothing here calls the network, so no lock waits on one.
 *
 * ⚠ EVERY RETRY RE-RUNS EVERY CHECK. step-ca retries a webhook once on a 5xx or
 * a transport error, with the same body. A retry is recognised by the key the
 * first call claimed, and is allowed only when the account, the enrollment or
 * device, and the permit would still pass the first call's checks.
 *
 * ⚠ A REFUSAL IS AN ANSWER, NOT AN ERROR. Anything we do not recognise is
 * `allow: false`; only our own faults throw, and the listener answers those
 * with a 5xx, which step-ca also refuses on.
 */

/** Why a hook was allowed or refused: fixed words, safe to log. */
export type HookOutcome =
  | "allowed"
  | "allowed_retry"
  | "no_permit"
  | "permit_changed"
  | "duplicate"
  | "key_conflict"
  | "key_conflict_cleared"
  | "notified"
  | "notify_failure"
  | "bad_body"
  | "bad_template"
  | `refused_${MailDeviceError["code"]}`

export interface HookDecision {
  allow: boolean
  outcome: HookOutcome
  /** Ours, never the caller's: set only where an operator must find the permit. */
  permitId?: string
}

export const ACME_PERMIT_LIFETIME_MS = 10 * 60 * 1000

const refuse = (outcome: HookOutcome): HookDecision => ({ allow: false, outcome })

export interface PermitRow {
  id: string
  clerk_user_id: string
  device_id: string | null
  enrollment_id: string | null
  kind: string
  status: string
  serial: string
  key_sha256: Buffer | null
  transaction_id: string | null
  issued_cert_sha256: Buffer | null
  /** `expires_at > now()`, by the server's clock. */
  live: boolean
}

export const PERMIT_COLUMNS = sql`
  id::text, clerk_user_id, device_id::text as device_id,
  enrollment_id::text as enrollment_id, kind, status, serial,
  key_sha256, transaction_id, issued_cert_sha256, (expires_at > now()) as live`

export type PermitTx = Pick<Database, "execute">

/** The handler's deadline passed before it could commit; nothing was written. */
export class HookDeadlineExceeded extends Error {
  constructor() {
    super("ca hook deadline exceeded")
  }
}

/** Milliseconds left before `deadline`, or a throw when none are. */
export function timeLeft(deadline: Date): number {
  const left = deadline.getTime() - Date.now()
  if (left <= 0) throw new HookDeadlineExceeded()
  return left
}

/**
 * ⚠ ONE DEADLINE FOR THE WHOLE HANDLER, BOUNDED INSIDE POSTGRES. A handler the
 * listener has already answered must never commit later: the key would be
 * bound and the permit authorized while step-ca issued nothing. So before
 * every statement, `lock_timeout` and `statement_timeout` are set to the time
 * left (at least 1 ms: 0 means no limit), and the waits share one budget
 * instead of each getting its own. The deadline starts when the listener read
 * the request, so the wait for a pooled connection counts against it too.
 *
 * `set_config(..., true)` is transaction-local, so PgBouncer never carries it
 * to the next client.
 */
export function budgeted(tx: PermitTx, deadline: Date): PermitTx {
  const execute = async (query: Parameters<PermitTx["execute"]>[0]) => {
    const ms = String(Math.max(1, Math.floor(timeLeft(deadline))))
    await tx.execute(sql`
      select set_config('lock_timeout', ${ms}, true),
             set_config('statement_timeout', ${ms}, true)`)
    return tx.execute(query)
  }
  return { execute } as unknown as PermitTx
}

export async function lockPermit(tx: PermitTx, id: string): Promise<PermitRow | null> {
  const [row] = (await tx.execute(sql`
    select ${PERMIT_COLUMNS} from authd.mail_device_cert_permits
     where id = ${id}
       for no key update`)) as unknown as PermitRow[]
  return row ?? null
}

export const sameBytes = (a: Buffer | null, b: Buffer) =>
  a !== null && a.length === b.length && timingSafeEqual(a, b)

/**
 * Runs one transaction inside `deadline` (see `budgeted`), checking the clock
 * again before commit so a late handler rolls back instead of committing after
 * its caller was answered. Reused by `decide` and `enrollments.ts`.
 */
export async function runWithDeadline<T>(
  db: Pick<Database, "transaction">,
  deadline: Date,
  run: (tx: PermitTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const result = await run(budgeted(tx, deadline))
    timeLeft(deadline)
    return result
  })
}

/**
 * Runs one handler transaction inside `deadline` (see `budgeted`); a unique
 * violation is a refusal, never a 500.
 */
export async function decide(
  db: Pick<Database, "transaction">,
  deadline: Date,
  run: (tx: PermitTx) => Promise<HookDecision>,
): Promise<HookDecision> {
  try {
    return await runWithDeadline(db, deadline, run)
  } catch (error) {
    if (isUniqueViolation(error)) return refuse("duplicate")
    throw error
  }
}

/** The account gate, then the device rules, for a locked device. */
function bindGate(
  account: MintGateAccount | undefined,
  device: LockedDevice | null,
  expect: { key: Buffer | null; serial: string },
): MailDeviceError | null {
  if (!device) return new MailDeviceError("device_not_found", "Mail device not found.")
  return (
    bindRefusal(account, device.tenant_id) ?? deviceKeyRefusal(device, account!, expect)
  )
}

// ── ACME AUTHORIZING ─────────────────────────────────────────────────────────

export interface AcmeAuthorizeRequest {
  /** step-ca's attested `permanentIdentifier`: the Mac's serial. */
  serial: string
  /** SHA-256 of the certificate's one `OU`, the per-permit nonce. */
  nonceSha256: Buffer
  /** SHA-256 of the certificate's SubjectPublicKeyInfo DER. */
  keySha256: Buffer
}

type AcmeMode = "first" | "retry" | "conflict"

/**
 * What a permit found by its nonce means for this request. `conflict` is a
 * live authorized permit asked for a different key: either a real Mac arriving after
 * someone who knew its nonce, or a second order from the same profile.
 */
function acmeMode(permit: PermitRow, req: AcmeAuthorizeRequest): AcmeMode | null {
  if (permit.kind !== "acme" || !permit.device_id || permit.serial !== req.serial) {
    return null
  }
  if (permit.status === "open") return permit.live ? "first" : null
  if (permit.status !== "authorized") return null
  // ⚠ ONLY WHILE THE PERMIT LIVES. Past `expires_at` a second key is no
  // permit at all: it changes nothing and clears nothing.
  if (!permit.live) return null
  return sameBytes(permit.key_sha256, req.keySha256) ? "retry" : "conflict"
}

/**
 * ACME `AUTHORIZING`, after the listener checked the template: binds the
 * certificate key to the permit's Mac and claims the device's first use.
 *
 * The permit is found by its nonce's unique index; the nonce is a secret only
 * the device's encrypted profile, step-ca and the API see, so nothing here can
 * be reached, and no key wiped, without it.
 */
export async function authorizeAcme(
  db: Pick<Database, "transaction">,
  req: AcmeAuthorizeRequest,
  deadline: Date,
): Promise<HookDecision> {
  return decide(db, deadline, async (tx) => {
    const [seen] = (await tx.execute(sql`
      select ${PERMIT_COLUMNS} from authd.mail_device_cert_permits
       where nonce_sha256 = ${req.nonceSha256} and kind = 'acme'`)) as unknown as PermitRow[]
    if (!seen || !acmeMode(seen, req)) return refuse("no_permit")

    const [account] = await lockGateAccount(tx, seen.clerk_user_id)
    const device = await lockDevice(tx, seen.device_id!)
    const permit = await lockPermit(tx, seen.id)
    // ⚠ DECIDED ON THE LOCKED ROW. The unlocked read only chose which rows to
    // lock: step-ca's retry racing the first call finds the permit authorized
    // here, with its own key, and is a retry rather than a refusal.
    const mode =
      permit?.clerk_user_id === seen.clerk_user_id &&
      permit.device_id === seen.device_id
        ? acmeMode(permit, req)
        : null
    if (!permit || !mode) return refuse("permit_changed")

    if (mode === "conflict") {
      // ⚠ ONLY THE KEY THIS PERMIT BOUND. An operator's later `bind-key` is not
      // this permit's to undo.
      const cleared =
        device !== null &&
        permit.key_sha256 !== null &&
        sameBytes(device.cert_key_sha256, permit.key_sha256) &&
        (await clearDeviceKey(tx, device.id))
      await tx.execute(sql`
        update authd.mail_device_cert_permits set status = 'expired', updated_at = now()
         where id = ${permit.id} and status = 'authorized'`)
      return {
        allow: false,
        outcome: cleared ? "key_conflict_cleared" : "key_conflict",
        permitId: permit.id,
      }
    }

    const refusal = bindGate(account, device, {
      key: mode === "first" ? null : req.keySha256,
      serial: permit.serial,
    })
    if (refusal) return refuse(`refused_${refusal.code}`)
    if (mode === "retry") return { allow: true, outcome: "allowed_retry" }

    await setDeviceKey(tx, device!.id, req.keySha256)
    await tx.execute(sql`
      update authd.mail_device_cert_permits
         set status = 'authorized', key_sha256 = ${req.keySha256}, updated_at = now()
       where id = ${permit.id} and status = 'open'`)
    return { allow: true, outcome: "allowed" }
  })
}

/**
 * Creates an ACME permit for a Mac inside a caller-owned transaction (#383 PR 4)
 * and returns its nonce, once. Only its SHA-256 is stored.
 *
 * Locks the account, then the device, and only then expires this person's own
 * open ACME permit for the serial, so a retried enrollment is never blocked for
 * ten minutes. Another person's live permit for the same serial is allowed
 * (Review 1 M6: the unique index is per `(serial, clerk_user_id)` and the ACME
 * hook looks up by nonce).
 */
export async function createAcmePermitInTx(
  tx: PermitTx,
  input: { deviceId: string },
): Promise<{ permitId: string; nonce: string; expiresAt: Date }> {
  const nonce = randomBytes(16).toString("base64url")
  const nonceSha256 = sha256(nonce)
  const owner = await deviceOwner(tx, input.deviceId)
  if (!owner) {
    throw new MailDeviceError("device_not_found", `No mail device ${input.deviceId}.`)
  }
  const [account] = await lockGateAccount(tx, owner)
  const device = await lockDevice(tx, input.deviceId)
  if (!device?.serial) {
    throw new MailDeviceError(
      "device_serial_missing",
      "An ACME permit needs the device's serial (mint with --serial).",
    )
  }
  const refusal = bindGate(account, device, { key: null, serial: device.serial })
  if (refusal) throw refusal

  await tx.execute(sql`
    update authd.mail_device_cert_permits set status = 'expired', updated_at = now()
     where kind = 'acme' and status = 'open'
       and serial = ${device.serial} and clerk_user_id = ${owner}`)
  const [row] = (await tx.execute(sql`
    insert into authd.mail_device_cert_permits
           (clerk_user_id, device_id, kind, serial, nonce_sha256, expires_at)
    values (${owner}, ${device.id}, 'acme', ${device.serial}, ${nonceSha256},
            now() + make_interval(secs => ${ACME_PERMIT_LIFETIME_MS / 1000}))
    returning id::text, expires_at`)) as unknown as {
    id: string
    expires_at: Date
  }[]
  return { permitId: row!.id, nonce, expiresAt: new Date(row!.expires_at) }
}

/**
 * Creates an ACME permit for a Mac (the operator script until PR 4) and returns
 * its nonce, once. Thin wrapper over `createAcmePermitInTx`.
 */
export async function createAcmePermit(
  db: Pick<Database, "transaction">,
  input: { deviceId: string },
): Promise<{ permitId: string; nonce: string; expiresAt: Date }> {
  try {
    return await db.transaction((tx) => createAcmePermitInTx(tx, input))
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new MailDeviceError(
        "permit_conflict",
        "Another enrollment holds a live permit for this serial.",
      )
    }
    throw error
  }
}

// ── SCEP ─────────────────────────────────────────────────────────────────────

export interface ScepChallengeRequest {
  /** SHA-256 of the challenge string exactly as the device sent it. */
  challengeSha256: Buffer
  /** The client's choice (step-ca `scep/api/api.go`), 1 to 255 bytes. */
  transactionId: string
  /** The CSR's subject CN. */
  commonName: string
  /** SHA-256 of the CSR's SubjectPublicKeyInfo DER. */
  keySha256: Buffer
}

function scepChallengeMode(permit: PermitRow, req: ScepChallengeRequest) {
  if (
    permit.kind !== "scep" ||
    !permit.enrollment_id ||
    !permit.live ||
    permit.serial !== req.commonName
  ) {
    return null
  }
  if (permit.status === "open") return "first" as const
  if (
    permit.status === "challenged" &&
    permit.transaction_id === req.transactionId &&
    sameBytes(permit.key_sha256, req.keySha256)
  ) {
    return "retry" as const
  }
  return null
}

interface EnrollmentGateRow {
  id: string
  clerk_user_id: string
  email: string
  tenant_id: string | null
  expected_epoch: string | number
  status: string
  live: boolean
}

/**
 * Locks in global order (Review 1 L3): `authd.accounts`, then
 * `authd.mail_device_enrollments`, then `authd.mail_device_cert_permits`.
 *
 * Refuses unless the enrollment is `attested` and unexpired, and computes
 * `mintRefusal` plus the account email check against the enrollment's
 * workspace and `expected_epoch`. Callers check the permit mode first and then
 * call `refuseScepEnrollment` when `refusal` is non-null, so a stale/mismatched
 * hook never marks a live enrollment refused.
 */
async function lockScepPermit(tx: PermitTx, seen: PermitRow) {
  const [account] = await lockGateAccount(tx, seen.clerk_user_id)
  const [enrollment] = seen.enrollment_id
    ? ((await tx.execute(sql`
        select id::text, clerk_user_id, email, tenant_id::text as tenant_id,
               expected_epoch, status, (expires_at > now()) as live
          from authd.mail_device_enrollments
         where id = ${seen.enrollment_id}
           for no key update`)) as unknown as EnrollmentGateRow[])
    : []
  const permit = await lockPermit(tx, seen.id)
  const matchedPermit =
    permit?.clerk_user_id === seen.clerk_user_id &&
    permit.enrollment_id === seen.enrollment_id
      ? permit
      : null
  if (
    !matchedPermit ||
    !enrollment ||
    enrollment.clerk_user_id !== matchedPermit.clerk_user_id ||
    enrollment.status !== "attested" ||
    !enrollment.live
  ) {
    return { permit: null, enrollmentId: null, refusal: null }
  }

  let refusal = mintRefusal(account, {
    tenantId: enrollment.tenant_id,
    expectedEpoch: Number(enrollment.expected_epoch),
  })
  if (!refusal && account!.email.toLowerCase() !== enrollment.email) {
    refusal = new MailDeviceError("email_mismatch", "Account email changed.")
  }
  return { permit: matchedPermit, enrollmentId: enrollment.id, refusal }
}

const ENROLLMENT_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Builds the single-statement UPDATE that expires every live permit belonging
 * to one or more cancelled enrollments, binding the validated UUIDs as one
 * `uuid[]` parameter (never interpolating a JS array into `sql`). Exported so
 * tests can pin the rendered SQL with one-element and two-element cases.
 */
export function expirePermitsForEnrollmentsSql(enrollmentIds: readonly string[]) {
  for (const id of enrollmentIds) {
    if (!ENROLLMENT_UUID.test(id)) {
      throw new Error("expirePermitsForEnrollmentsSql: invalid enrollment id")
    }
  }
  const literal = `{${enrollmentIds.join(",")}}`
  return sql`
    update authd.mail_device_cert_permits
       set status = 'expired', updated_at = now()
     where enrollment_id = any(${literal}::uuid[])
       and status in ('open', 'challenged', 'authorized', 'notified')`
}

/**
 * Marks a live `attested` enrollment `refused` with `code` and expires its
 * live SCEP permits in the same transaction (Review 1 smaller rules: SCEP hook
 * refusals are shown on the console right away instead of waiting for expiry).
 * Called only while holding `accounts -> enrollments -> permit` locks.
 */
async function refuseScepEnrollment(
  tx: PermitTx,
  enrollmentId: string,
  code: MailDeviceError["code"],
): Promise<HookDecision> {
  await tx.execute(sql`
    update authd.mail_device_enrollments
       set status = 'refused', refusal = ${code}, updated_at = now()
     where id = ${enrollmentId} and status = 'attested'`)
  await tx.execute(expirePermitsForEnrollmentsSql([enrollmentId]))
  return refuse(`refused_${code}`)
}

/**
 * SCEP `SCEPCHALLENGE`: an open permit found by the challenge's hash, for the
 * CSR's CN, whose enrollment is `attested` and unexpired and whose account passes
 * `mintRefusal`, becomes `challenged` with the transaction id and the CSR key.
 * A transaction id another active enrollment holds is a unique violation,
 * answered `allow: false`.
 */
export async function challengeScep(
  db: Pick<Database, "transaction">,
  req: ScepChallengeRequest,
  deadline: Date,
): Promise<HookDecision> {
  return decide(db, deadline, async (tx) => {
    const [seen] = (await tx.execute(sql`
      select ${PERMIT_COLUMNS} from authd.mail_device_cert_permits
       where challenge_hash = ${req.challengeSha256} and kind = 'scep'`)) as unknown as PermitRow[]
    if (!seen || !scepChallengeMode(seen, req)) return refuse("no_permit")

    // Decided on the locked rows, as `authorizeAcme` is.
    const { permit, enrollmentId, refusal } = await lockScepPermit(tx, seen)
    const mode = permit ? scepChallengeMode(permit, req) : null
    if (!permit || !enrollmentId || !mode) return refuse("permit_changed")
    if (refusal) return refuseScepEnrollment(tx, enrollmentId, refusal.code)
    if (mode === "retry") return { allow: true, outcome: "allowed_retry" }

    await tx.execute(sql`
      update authd.mail_device_cert_permits
         set status = 'challenged', transaction_id = ${req.transactionId},
             key_sha256 = ${req.keySha256}, updated_at = now()
       where id = ${permit.id} and status = 'open'`)
    return { allow: true, outcome: "allowed" }
  })
}

export interface ScepAuthorizeRequest {
  /** The template's subject CN, already checked against the rest of the template. */
  commonName: string
  keySha256: Buffer
}

function scepAuthorizeMode(permit: PermitRow, req: ScepAuthorizeRequest) {
  if (
    permit.kind !== "scep" ||
    !permit.enrollment_id ||
    !permit.live ||
    permit.serial !== req.commonName
  ) {
    return null
  }
  if (permit.status === "challenged") return "first" as const
  if (permit.status === "authorized") return "retry" as const
  return null
}

/**
 * SCEP `AUTHORIZING`: no transaction id reaches this hook, so the permit is
 * found by the key `SCEPCHALLENGE` claimed (its own unique index).
 */
export async function authorizeScep(
  db: Pick<Database, "transaction">,
  req: ScepAuthorizeRequest,
  deadline: Date,
): Promise<HookDecision> {
  return decide(db, deadline, async (tx) => {
    const [seen] = (await tx.execute(sql`
      select ${PERMIT_COLUMNS} from authd.mail_device_cert_permits
       where key_sha256 = ${req.keySha256} and kind = 'scep'`)) as unknown as PermitRow[]
    if (!seen || !scepAuthorizeMode(seen, req)) return refuse("no_permit")

    const { permit, enrollmentId, refusal } = await lockScepPermit(tx, seen)
    const mode = permit ? scepAuthorizeMode(permit, req) : null
    if (!permit || !enrollmentId || !mode) return refuse("permit_changed")
    if (refusal) return refuseScepEnrollment(tx, enrollmentId, refusal.code)
    if (mode === "retry") return { allow: true, outcome: "allowed_retry" }

    await tx.execute(sql`
      update authd.mail_device_cert_permits set status = 'authorized', updated_at = now()
       where id = ${permit.id} and status = 'challenged'`)
    return { allow: true, outcome: "allowed" }
  })
}

function scepNotifyMode(
  permit: PermitRow,
  req: { transactionId: string; keySha256: Buffer; certSha256: Buffer },
) {
  if (
    permit.kind !== "scep" ||
    !permit.enrollment_id ||
    !permit.live ||
    permit.transaction_id !== req.transactionId ||
    !sameBytes(permit.key_sha256, req.keySha256)
  ) {
    return null
  }
  if (permit.status === "authorized") return "first" as const
  if (
    permit.status === "notified" &&
    sameBytes(permit.issued_cert_sha256, req.certSha256)
  ) {
    return "retry" as const
  }
  return null
}

/**
 * SCEP `NOTIFYING` (success): records the issued certificate's hash on the
 * authorized permit with this transaction id and key, gating on the permit's
 * enrollment (account, enrollment, permit lock order) on the first call and on
 * every retry.
 */
export async function notifyScep(
  db: Pick<Database, "transaction">,
  req: { transactionId: string; keySha256: Buffer; certSha256: Buffer },
  deadline: Date,
): Promise<HookDecision> {
  return decide(db, deadline, async (tx) => {
    const [seen] = (await tx.execute(sql`
      select ${PERMIT_COLUMNS} from authd.mail_device_cert_permits
       where key_sha256 = ${req.keySha256} and kind = 'scep'`)) as unknown as PermitRow[]
    if (!seen || !scepNotifyMode(seen, req)) return refuse("no_permit")

    const { permit, enrollmentId, refusal } = await lockScepPermit(tx, seen)
    const mode = permit ? scepNotifyMode(permit, req) : null
    if (!permit || !enrollmentId || !mode) return refuse("permit_changed")
    if (refusal) return refuseScepEnrollment(tx, enrollmentId, refusal.code)
    if (mode === "retry") return { allow: true, outcome: "allowed_retry" }

    await tx.execute(sql`
      update authd.mail_device_cert_permits
         set status = 'notified', issued_cert_sha256 = ${req.certSha256}, updated_at = now()
       where id = ${permit.id} and status = 'authorized'`)
    return { allow: true, outcome: "notified" }
  })
}

export function sha256(value: string | Uint8Array): Buffer {
  return new Bun.CryptoHasher("sha256").update(value).digest() as Buffer
}
