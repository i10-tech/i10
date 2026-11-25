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
  setDeviceKey,
  type LockedDevice,
  type MintGateAccount,
} from "./store.js"

/**
 * Certificate permits (#383 PR 3): the device CA's only way to issue
 * (docs/research/mail-device-binding.md section 11, "Certificate permits" and
 * "Revision 5 rules"). Every API read or write of
 * `authd.mail_device_cert_permits` goes through this module.
 *
 * ⚠ LOCK ORDER, after PR 2's (store.ts): read the permit WITHOUT a lock, then
 * lock `authd.accounts` (`FOR NO KEY UPDATE`), then `authd.mail_devices`, then
 * the permit, and re-check it under the lock. A revocation takes accounts, then
 * devices, then (by cascade) the permit, so the two can never wait on each
 * other in a cycle. Nothing here calls the network, so no lock waits on one.
 *
 * ⚠ EVERY RETRY RE-RUNS EVERY CHECK. step-ca retries a webhook once on a 5xx or
 * a transport error, with the same body. A retry is recognised by the key the
 * first call claimed, and is allowed only when the account, the device and the
 * permit would still pass the first call's checks.
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

interface PermitRow {
  id: string
  clerk_user_id: string
  device_id: string | null
  kind: string
  status: string
  serial: string
  key_sha256: Buffer | null
  transaction_id: string | null
  /** `expires_at > now()`, by the server's clock. */
  live: boolean
}

const PERMIT_COLUMNS = sql`
  id::text, clerk_user_id, device_id::text as device_id, kind, status, serial,
  key_sha256, transaction_id, (expires_at > now()) as live`

type Tx = Pick<Database, "execute">

/**
 * ⚠ BOUNDED INSIDE POSTGRES, NOT ONLY BY THE LISTENER'S TIMER. A handler the
 * listener has already answered must not commit later behind a lock queue.
 * `set_config(..., true)` is transaction-local, so PgBouncer never carries it
 * to the next client.
 */
async function bounded(tx: Tx) {
  await tx.execute(sql`
    select set_config('lock_timeout', '2s', true),
           set_config('statement_timeout', '4s', true)`)
}

async function lockPermit(tx: Tx, id: string): Promise<PermitRow | null> {
  const [row] = (await tx.execute(sql`
    select ${PERMIT_COLUMNS} from authd.mail_device_cert_permits
     where id = ${id}
       for no key update`)) as unknown as PermitRow[]
  return row ?? null
}

const sameBytes = (a: Buffer | null, b: Buffer) =>
  a !== null && a.length === b.length && timingSafeEqual(a, b)

/** Runs one handler transaction; a unique violation is a refusal, never a 500. */
async function decide(
  db: Pick<Database, "transaction">,
  run: (tx: Tx) => Promise<HookDecision>,
): Promise<HookDecision> {
  try {
    return await db.transaction(async (tx) => {
      await bounded(tx)
      return run(tx)
    })
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
 * What a permit found by its nonce means for this request. `conflict` is an
 * authorized permit asked for a different key: either a real Mac arriving after
 * someone who knew its nonce, or a second order from the same profile.
 */
function acmeMode(permit: PermitRow, req: AcmeAuthorizeRequest): AcmeMode | null {
  if (permit.kind !== "acme" || !permit.device_id || permit.serial !== req.serial) {
    return null
  }
  if (permit.status === "open") return permit.live ? "first" : null
  if (permit.status !== "authorized") return null
  if (!sameBytes(permit.key_sha256, req.keySha256)) return "conflict"
  return permit.live ? "retry" : null
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
): Promise<HookDecision> {
  return decide(db, async (tx) => {
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
 * Creates an ACME permit for a Mac (the operator script until PR 4) and returns
 * its nonce, once. Only its SHA-256 is stored.
 *
 * Locks the account, then the device, and only then expires the serial's open
 * permits that have run out, and this person's own open one, so a retried
 * enrollment is never blocked for ten minutes. Another person's live permit for
 * the same serial is refused (`permit_conflict`), never replaced: one Mac
 * cannot be in two people's enrollments at once.
 */
export async function createAcmePermit(
  db: Pick<Database, "transaction">,
  input: { deviceId: string },
): Promise<{ permitId: string; nonce: string; expiresAt: Date }> {
  const nonce = randomBytes(16).toString("base64url")
  const nonceSha256 = sha256(nonce)
  try {
    return await db.transaction(async (tx) => {
      const owner = await deviceOwner(tx, input.deviceId)
      if (!owner) {
        throw new MailDeviceError(
          "device_not_found",
          `No mail device ${input.deviceId}.`,
        )
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
         where kind = 'acme' and status = 'open' and serial = ${device.serial}
           and (expires_at <= now() or clerk_user_id = ${owner})`)
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
    })
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
  if (permit.kind !== "scep" || !permit.live || permit.serial !== req.commonName) {
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

/** Locks the account a SCEP permit names (it has no device), then the permit. */
async function lockScepPermit(tx: Tx, seen: PermitRow) {
  const [account] = await lockGateAccount(tx, seen.clerk_user_id)
  const permit = await lockPermit(tx, seen.id)
  const refusal = bindRefusal(account, account?.tenant_id ?? null)
  return {
    permit: permit?.clerk_user_id === seen.clerk_user_id ? permit : null,
    refusal,
  }
}

/**
 * SCEP `SCEPCHALLENGE`: an open permit found by the challenge's hash, for the
 * CSR's CN, whose account passes the gate, becomes `challenged` with the
 * transaction id and the CSR key. A transaction id another active enrollment
 * holds is a unique violation, answered `allow: false`.
 */
export async function challengeScep(
  db: Pick<Database, "transaction">,
  req: ScepChallengeRequest,
): Promise<HookDecision> {
  return decide(db, async (tx) => {
    const [seen] = (await tx.execute(sql`
      select ${PERMIT_COLUMNS} from authd.mail_device_cert_permits
       where challenge_hash = ${req.challengeSha256} and kind = 'scep'`)) as unknown as PermitRow[]
    if (!seen || !scepChallengeMode(seen, req)) return refuse("no_permit")

    // Decided on the locked row, as `authorizeAcme` is.
    const { permit, refusal } = await lockScepPermit(tx, seen)
    const mode = permit ? scepChallengeMode(permit, req) : null
    if (!permit || !mode) return refuse("permit_changed")
    if (refusal) return refuse(`refused_${refusal.code}`)
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
  if (permit.kind !== "scep" || !permit.live || permit.serial !== req.commonName) {
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
): Promise<HookDecision> {
  return decide(db, async (tx) => {
    const [seen] = (await tx.execute(sql`
      select ${PERMIT_COLUMNS} from authd.mail_device_cert_permits
       where key_sha256 = ${req.keySha256} and kind = 'scep'`)) as unknown as PermitRow[]
    if (!seen || !scepAuthorizeMode(seen, req)) return refuse("no_permit")

    const { permit, refusal } = await lockScepPermit(tx, seen)
    const mode = permit ? scepAuthorizeMode(permit, req) : null
    if (!permit || !mode) return refuse("permit_changed")
    if (refusal) return refuse(`refused_${refusal.code}`)
    if (mode === "retry") return { allow: true, outcome: "allowed_retry" }

    await tx.execute(sql`
      update authd.mail_device_cert_permits set status = 'authorized', updated_at = now()
       where id = ${permit.id} and status = 'challenged'`)
    return { allow: true, outcome: "allowed" }
  })
}

/**
 * SCEP `NOTIFYING` (success): records the issued certificate's hash on the
 * authorized permit with this transaction id and key. One indexed UPDATE that
 * locks only the permit, so it cannot join a cycle. step-ca discards the answer
 * either way (`scep/api/api.go`), so this is a record, not a gate.
 */
export async function notifyScep(
  db: Pick<Database, "transaction">,
  req: { transactionId: string; keySha256: Buffer; certSha256: Buffer },
): Promise<HookDecision> {
  return decide(db, async (tx) => {
    const updated = (await tx.execute(sql`
      update authd.mail_device_cert_permits
         set status = 'notified', issued_cert_sha256 = ${req.certSha256}, updated_at = now()
       where key_sha256 = ${req.keySha256} and transaction_id = ${req.transactionId}
         and kind = 'scep' and status = 'authorized' and expires_at > now()
      returning id`)) as unknown as { id: string }[]
    if (updated.length > 0) return { allow: true, outcome: "notified" }
    // step-ca's retry after we committed: the same certificate, already recorded.
    const [again] = (await tx.execute(sql`
      select 1 as one from authd.mail_device_cert_permits
       where key_sha256 = ${req.keySha256} and transaction_id = ${req.transactionId}
         and kind = 'scep' and status = 'notified'
         and issued_cert_sha256 = ${req.certSha256}`)) as unknown as unknown[]
    return again ? { allow: true, outcome: "allowed_retry" } : refuse("no_permit")
  })
}

export function sha256(value: string | Uint8Array): Buffer {
  return new Bun.CryptoHasher("sha256").update(value).digest() as Buffer
}
