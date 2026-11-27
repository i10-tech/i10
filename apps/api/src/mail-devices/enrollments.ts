import { randomBytes } from "node:crypto"
import { sql } from "drizzle-orm"
import type { Database } from "../db/client.js"
import { MailDeviceError, type MailDeviceCodeKeys } from "./code.js"
import { verifyPhase4Certificate, type DeviceCaBundle } from "./cms.js"
import {
  createAcmePermitInTx,
  expirePermitsForEnrollmentsSql,
  lockPermit,
  PERMIT_COLUMNS,
  runWithDeadline,
  sameBytes,
  sha256,
  type PermitRow,
  type PermitTx,
} from "./permits.js"
import { classifyApplePlatform } from "./platform.js"
import {
  buildSealedMobileConfig,
  DEFAULT_ACME_DIRECTORY_URL,
} from "./sealed-profile.js"
import {
  lockGateAccount,
  mintInTx,
  mintRefusal,
  type MailDevicePlatform,
} from "./store.js"

/**
 * The one store for `authd.mail_device_enrollments` (#383 PR 4,
 * docs/research/mail-device-binding.md section 12 + Review 1 rules).
 *
 * ⚠ LOCK ORDER EVERYWHERE (Review 1 L3):
 *   1. `authd.accounts` (`FOR NO KEY UPDATE`)
 *   2. `authd.mail_device_enrollments` (`FOR NO KEY UPDATE`)
 *   3. `authd.mail_devices` (insert in `finish`)
 *   4. `authd.mail_device_cert_permits` (update/insert)
 *   5. `authd.mail_device_cert_binds` (never touched here)
 *
 * Every call that starts from an enrollment id, a link token, or a SCEP key
 * first reads unlocked to learn `clerk_user_id`, then locks in the global order
 * and re-checks every invariant under the locks. Nothing here calls the network
 * while holding a database lock: the post-seal notice email runs strictly AFTER
 * the transaction commits.
 */

/** How long a freshly created enrollment may wait for phase 2 attest (Review 1 M4). */
export const ENROLLMENT_ATTEST_WINDOW_MS = 15 * 60 * 1000
/** SCEP step lifetime after attest (matches the SCEP permit's own life). */
export const ENROLLMENT_SCEP_WINDOW_MS = 10 * 60 * 1000
/** Hard ceiling on enrollment life from creation, whatever the attest retries (Review 1 M4). */
export const ENROLLMENT_MAX_LIFETIME_MS = 30 * 60 * 1000
export const DEFAULT_ENROLL_BASE_URL = "https://ca.i10.tech"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

export type AttestResult =
  | { outcome: "scep"; serial: string; challenge: string }
  | { outcome: "refused"; reason: string }

export interface EnrolledNoticePayload {
  email: string
  deviceId: string
  platform: MailDevicePlatform
  model: string
  serialLast4: string
}

export type FinishResult =
  | {
      outcome: "sealed"
      profile: Buffer
      replayed: boolean
      notice?: EnrolledNoticePayload
    }
  | { outcome: "refused"; reason: string }

interface LockedEnrollmentRow {
  id: string
  clerk_user_id: string
  email: string
  tenant_id: string | null
  expected_epoch: string | number
  status: EnrollmentStatus
  refusal: string | null
  serial: string | null
  product: string | null
  os_version: string | null
  device_name: string | null
  udid_sha256: Buffer | null
  apple_signer_sha256: Buffer | null
  platform: string | null
  device_id: string | null
  sealed_profile: Buffer | null
  created_by: string
  created_at: Date | string
  expires_at: Date | string
  live: boolean
  under_cap: boolean
}

async function lockEnrollment(
  tx: PermitTx,
  id: string,
): Promise<LockedEnrollmentRow | null> {
  const [row] = (await tx.execute(sql`
    select id::text,
           clerk_user_id,
           email,
           tenant_id::text as tenant_id,
           expected_epoch,
           status,
           refusal,
           serial,
           product,
           os_version,
           device_name,
           udid_sha256,
           apple_signer_sha256,
           platform,
           device_id::text as device_id,
           sealed_profile,
           created_by,
           created_at,
           expires_at,
           (expires_at > now()) as live,
           (created_at + make_interval(secs => ${ENROLLMENT_MAX_LIFETIME_MS / 1000}) > now()) as under_cap
      from authd.mail_device_enrollments
     where id = ${id}
       for no key update`)) as unknown as LockedEnrollmentRow[]
  return row ?? null
}

/**
 * The workspace of the person's own mailbox, read before an enrollment starts
 * so the route can run that workspace's console policies on the session; null
 * when the person has no mailbox. `tenantId` is null for an i10.tech mailbox.
 */
export async function readMailboxTenant(
  db: Pick<Database, "execute">,
  clerkUserId: string,
): Promise<{ tenantId: string | null } | null> {
  const [row] = (await db.execute(sql`
    select tenant_id::text as tenant_id
      from authd.accounts
     where clerk_user_id = ${clerkUserId}`)) as unknown as {
    tenant_id: string | null
  }[]
  return row ? { tenantId: row.tenant_id } : null
}

/**
 * Starts a new enrollment for the signed-in person's own mailbox
 * (`POST /console/mail-devices/enrollments`).
 *
 * Workspace-optional (Review 1): the console session may have any workspace
 * open, or none. ⚠ `tenantId` IS THE MAILBOX'S WORKSPACE WHOSE POLICIES THE
 * ROUTE ALREADY RAN ON THE SESSION (`readMailboxTenant`, null for an i10.tech
 * mailbox). The gate can call Clerk, so it runs before this transaction, and
 * `mintRefusal` refuses `tenant_mismatch` when the mailbox moved in between.
 * Locks the account, cancels any existing `open`/`attested` enrollment (and
 * expires its SCEP permits), and inserts the new row with a 15-minute attest
 * window.
 */
export async function createEnrollment(
  db: Pick<Database, "transaction">,
  input: {
    clerkUserId: string
    tenantId: string | null
    createdBy?: string
    hasCodeKeys: boolean
    enrollBaseUrl?: string
  },
): Promise<CreateEnrollmentResult> {
  if (!input.hasCodeKeys) {
    return { ok: false, status: 503, code: "keys_not_configured" }
  }

  const baseUrl = (input.enrollBaseUrl ?? DEFAULT_ENROLL_BASE_URL).replace(/\/$/, "")
  const token = randomBytes(32).toString("base64url")
  const tokenSha256 = sha256(token)

  return db.transaction(async (tx) => {
    const [account] = await lockGateAccount(tx, input.clerkUserId)
    if (!account) {
      return { ok: false, status: 409, code: "no_mailbox" }
    }
    const expectedEpoch = Number(account.credential_epoch)
    const refusal = mintRefusal(account, {
      tenantId: input.tenantId,
      expectedEpoch,
    })
    if (refusal) {
      return { ok: false, status: 409, code: refusal.code }
    }

    // Lock order: accounts (held) -> enrollments -> permits.
    // Partial unique index guarantees at most one live enrollment per person.
    const cancelled = (await tx.execute(sql`
      update authd.mail_device_enrollments
         set status = 'cancelled', updated_at = now()
       where clerk_user_id = ${account.clerk_user_id}
         and status in ('open', 'attested')
      returning id::text as id`)) as unknown as { id: string }[]

    if (cancelled.length > 0) {
      await tx.execute(expirePermitsForEnrollmentsSql(cancelled.map((row) => row.id)))
    }

    const [created] = (await tx.execute(sql`
      insert into authd.mail_device_enrollments (
        clerk_user_id, email, tenant_id, expected_epoch, token_sha256,
        status, created_by, expires_at
      )
      values (
        ${account.clerk_user_id},
        ${account.email.toLowerCase()},
        ${account.tenant_id ?? null}::uuid,
        ${expectedEpoch},
        ${tokenSha256},
        'open',
        ${input.createdBy ?? account.clerk_user_id},
        now() + make_interval(secs => ${ENROLLMENT_ATTEST_WINDOW_MS / 1000})
      )
      returning id::text as id, expires_at`)) as unknown as {
      id: string
      expires_at: Date | string
    }[]

    return {
      ok: true,
      id: created!.id,
      url: `${baseUrl}/enroll/apple/${token}`,
      expiresAt: new Date(created!.expires_at),
    }
  })
}

/**
 * Reads one enrollment for the signed-in person
 * (`GET /console/mail-devices/enrollments/:id`). Never reads `sealed_profile`
 * or `token_sha256`. Returns null when missing or owned by someone else.
 */
export async function getEnrollment(
  db: Pick<Database, "execute">,
  input: { id: string; clerkUserId: string },
): Promise<EnrollmentView | null> {
  if (!UUID.test(input.id)) return null
  const [row] = (await db.execute(sql`
    select id::text as id,
           status,
           expires_at,
           refusal,
           platform,
           product,
           device_name,
           device_id::text as device_id,
           (expires_at <= now()) as past_expiry
      from authd.mail_device_enrollments
     where id = ${input.id}
       and clerk_user_id = ${input.clerkUserId}`)) as unknown as {
    id: string
    status: EnrollmentStatus
    expires_at: Date | string
    refusal: string | null
    platform: string | null
    product: string | null
    device_name: string | null
    device_id: string | null
    past_expiry: boolean
  }[]
  if (!row) return null

  const effectiveStatus: EnrollmentStatus =
    (row.status === "open" || row.status === "attested") && row.past_expiry
      ? "expired"
      : row.status

  return {
    id: row.id,
    status: effectiveStatus,
    expiresAt: new Date(row.expires_at),
    refusal: row.refusal,
    platform: row.platform as MailDevicePlatform | null,
    model: row.product,
    deviceName: row.device_name,
    deviceId: row.device_id,
    needsMailSetup: row.status === "sealed" && row.platform === "macos",
  }
}

/**
 * Cancels an `open` or `attested` enrollment (and expires its SCEP permits).
 * Returns `already_sealed` for a sealed enrollment (Review 1 -> HTTP 409) and
 * `not_found` when missing or owned by another person (HTTP 404).
 */
export async function cancelEnrollment(
  db: Pick<Database, "transaction">,
  input: { id: string; clerkUserId: string },
): Promise<CancelEnrollmentOutcome> {
  if (!UUID.test(input.id)) return "not_found"
  return db.transaction(async (tx) => {
    const [seen] = (await tx.execute(sql`
      select id::text as id, clerk_user_id
        from authd.mail_device_enrollments
       where id = ${input.id}
         and clerk_user_id = ${input.clerkUserId}`)) as unknown as {
      id: string
      clerk_user_id: string
    }[]
    if (!seen) return "not_found"

    // Lock order: accounts -> enrollments -> permits.
    await tx.execute(sql`
      select 1 from authd.accounts
       where clerk_user_id = ${seen.clerk_user_id}
         for no key update`)
    const enrollment = await lockEnrollment(tx, seen.id)
    if (!enrollment || enrollment.clerk_user_id !== input.clerkUserId) {
      return "not_found"
    }
    if (enrollment.status === "sealed") {
      return "already_sealed"
    }
    if (enrollment.status === "open" || enrollment.status === "attested") {
      await tx.execute(sql`
        update authd.mail_device_enrollments
           set status = 'cancelled', updated_at = now()
         where id = ${enrollment.id}
           and status in ('open', 'attested')`)
      await tx.execute(expirePermitsForEnrollmentsSql([enrollment.id]))
    }
    return "cancelled"
  })
}

/**
 * Read-only phase 1 liveness check (`POST /enrolld/peek`), bounded inside
 * Postgres by `deadline`. True while the enrollment is `open` or `attested`
 * and unexpired.
 */
export async function peekEnrollment(
  db: Pick<Database, "transaction">,
  token: string,
  deadline: Date,
): Promise<{ live: boolean }> {
  const tokenSha256 = sha256(token)
  return runWithDeadline(db, deadline, async (tx) => {
    const [row] = (await tx.execute(sql`
      select (status in ('open', 'attested') and expires_at > now()) as live
        from authd.mail_device_enrollments
       where token_sha256 = ${tokenSha256}`)) as unknown as { live: boolean }[]
    return { live: Boolean(row?.live) }
  })
}

export interface AttestRequest {
  token: string
  udid: string
  serial: string
  product: string
  version: string
  deviceName: string | null
  model: string | null
  appleSignerSha256: Buffer
}

/**
 * Phase 2 attestation (`POST /enrolld/attest`): binds serial, UDID hash and
 * Apple signer hash on first call (or verifies exact match on retry), runs
 * `mintRefusal` against the enrollment's workspace and `expected_epoch`, checks
 * platform rules, expires any earlier live SCEP permits for the enrollment, and
 * creates one fresh SCEP permit whose expiry is capped at `created_at + 30 min`
 * (Review 1 M4).
 */
export async function attestEnrollment(
  db: Pick<Database, "transaction">,
  req: AttestRequest,
  deadline: Date,
): Promise<AttestResult> {
  const tokenSha256 = sha256(req.token)
  const udidSha256 = sha256(req.udid)

  return runWithDeadline(db, deadline, async (tx) => {
    const [seen] = (await tx.execute(sql`
      select id::text as id, clerk_user_id, status, (expires_at > now()) as live
        from authd.mail_device_enrollments
       where token_sha256 = ${tokenSha256}`)) as unknown as {
      id: string
      clerk_user_id: string
      status: EnrollmentStatus
      live: boolean
    }[]
    if (!seen) return { outcome: "refused", reason: "enrollment_not_found" }
    if ((seen.status !== "open" && seen.status !== "attested") || !seen.live) {
      return { outcome: "refused", reason: "enrollment_not_live" }
    }

    // Lock order: accounts -> enrollments -> permits.
    const [account] = await lockGateAccount(tx, seen.clerk_user_id)
    const enrollment = await lockEnrollment(tx, seen.id)
    if (!enrollment || enrollment.clerk_user_id !== seen.clerk_user_id) {
      return { outcome: "refused", reason: "enrollment_not_found" }
    }
    if (enrollment.status !== "open" && enrollment.status !== "attested") {
      return { outcome: "refused", reason: "enrollment_not_live" }
    }
    if (!enrollment.live || !enrollment.under_cap) {
      return { outcome: "refused", reason: "enrollment_expired" }
    }

    const isRetry = enrollment.status === "attested"
    if (isRetry) {
      if (
        enrollment.serial !== req.serial ||
        !sameBytes(enrollment.udid_sha256, udidSha256) ||
        !sameBytes(enrollment.apple_signer_sha256, req.appleSignerSha256)
      ) {
        return { outcome: "refused", reason: "attest_mismatch" }
      }
    }

    let gateRefusal = mintRefusal(account, {
      tenantId: enrollment.tenant_id,
      expectedEpoch: Number(enrollment.expected_epoch),
    })
    if (!gateRefusal && account!.email.toLowerCase() !== enrollment.email) {
      gateRefusal = new MailDeviceError("email_mismatch", "Account email changed.")
    }
    if (gateRefusal) {
      await tx.execute(sql`
        update authd.mail_device_enrollments
           set status = 'refused', refusal = ${gateRefusal.code}, updated_at = now()
         where id = ${enrollment.id}
           and status in ('open', 'attested')`)
      if (isRetry) {
        await tx.execute(expirePermitsForEnrollmentsSql([enrollment.id]))
      }
      return { outcome: "refused", reason: gateRefusal.code }
    }

    const classified = classifyApplePlatform(req.product, req.version)
    if (!classified.ok) {
      await tx.execute(sql`
        update authd.mail_device_enrollments
           set status = 'refused',
               refusal = ${classified.refusal},
               serial = coalesce(serial, ${req.serial}),
               product = coalesce(product, ${req.product}),
               os_version = coalesce(os_version, ${req.version}),
               device_name = coalesce(device_name, ${req.deviceName}),
               udid_sha256 = coalesce(udid_sha256, ${udidSha256}),
               apple_signer_sha256 = coalesce(apple_signer_sha256, ${req.appleSignerSha256}),
               updated_at = now()
         where id = ${enrollment.id}
           and status in ('open', 'attested')`)
      if (isRetry) {
        await tx.execute(expirePermitsForEnrollmentsSql([enrollment.id]))
      }
      return { outcome: "refused", reason: classified.refusal }
    }

    // Move expiry to attest + 10 min, capped at created_at + 30 min (Review 1 M4).
    const [updated] = (await tx.execute(sql`
      update authd.mail_device_enrollments
         set status = 'attested',
             serial = ${req.serial},
             product = ${req.product},
             os_version = ${req.version},
             device_name = ${req.deviceName},
             udid_sha256 = ${udidSha256},
             apple_signer_sha256 = ${req.appleSignerSha256},
             platform = ${classified.platform},
             expires_at = least(
               now() + make_interval(secs => ${ENROLLMENT_SCEP_WINDOW_MS / 1000}),
               created_at + make_interval(secs => ${ENROLLMENT_MAX_LIFETIME_MS / 1000})
             ),
             updated_at = now()
       where id = ${enrollment.id}
         and status in ('open', 'attested')
      returning expires_at::text as expires_at_text, (expires_at > now()) as still_live`)) as unknown as {
      expires_at_text: string
      still_live: boolean
    }[]

    if (!updated?.still_live) {
      return { outcome: "refused", reason: "enrollment_expired" }
    }

    // Expire every live permit of this enrollment (all SCEP: the CHECK ties
    // enrollment_id to kind) before opening the new one.
    await tx.execute(expirePermitsForEnrollmentsSql([enrollment.id]))

    const challenge = randomBytes(32).toString("base64url")
    const challengeHash = sha256(challenge)
    await tx.execute(sql`
      insert into authd.mail_device_cert_permits (
        clerk_user_id, enrollment_id, kind, serial, challenge_hash, expires_at
      )
      values (
        ${enrollment.clerk_user_id},
        ${enrollment.id},
        'scep',
        ${req.serial},
        ${challengeHash},
        ${updated.expires_at_text}::timestamptz
      )`)

    return { outcome: "scep", serial: req.serial, challenge }
  })
}

export interface FinishDeps {
  keys: MailDeviceCodeKeys | null | undefined
  deviceCaBundle: () => DeviceCaBundle | null
  imapHost: string
  imapPort: number
  smtpHost: string
  smtpPort: number
  organization: string
  acmeDirectoryUrl?: string
  now?: () => Date
}

export interface FinishRequest {
  certDer: Buffer
  udid: string | null
}

/** Internal rollback sentinel when the permit state lapsed after minting. */
class FinishRefusalRollback extends Error {
  constructor(readonly reason: string) {
    super(reason)
  }
}

/**
 * Phase 4 finish (`POST /enrolld/finish`, Review 1 rules M1, M2, M3, L1, L3):
 *   1. Verifies the phase 4 certificate DER against the mounted device CA root
 *      and intermediate BEFORE touching Postgres.
 *   2. Matches the SCEP permit by key hash only (never `issued_cert_sha256`).
 *   3. Locks in global order: `accounts`, `enrollments`, then (insert)
 *      `mail_devices`, then `mail_device_cert_permits`.
 *   4. On a repeat finish from the same key while `sealed` and unexpired,
 *      returns the stored `sealed_profile` bytes without minting again.
 *   5. Otherwise mints the device (`mintInTx`), creates the ACME permit on
 *      `macos` (`createAcmePermitInTx`), expires the SCEP permit, encrypts the
 *      profile to the verified certificate, and stores `sealed_profile` on the
 *      enrollment row - all in ONE transaction.
 */
export async function finishEnrollment(
  db: Pick<Database, "transaction">,
  deps: FinishDeps,
  req: FinishRequest,
  deadline: Date,
): Promise<FinishResult> {
  const bundle = deps.deviceCaBundle()
  if (!bundle) {
    throw new Error("device CA bundle is not mounted")
  }
  if (!deps.keys || !deps.keys.keys.has(deps.keys.currentKid)) {
    throw new MailDeviceError(
      "keys_not_configured",
      "MAIL_DEVICE_CODE_KEYS is not configured.",
    )
  }

  const now = (deps.now ?? (() => new Date()))()
  const checked = verifyPhase4Certificate(req.certDer, bundle, now)
  if (!checked.ok) {
    return { outcome: "refused", reason: checked.reason }
  }
  const { verified } = checked
  const udidSha256 = req.udid !== null ? sha256(req.udid) : null

  try {
    return await runWithDeadline(db, deadline, async (tx) => {
      // Match the SCEP permit by key only (M2): never filter by issued_cert_sha256,
      // and include expired permits so a repeat finish for a sealed row finds it.
      const [seen] = (await tx.execute(sql`
        select ${PERMIT_COLUMNS} from authd.mail_device_cert_permits
         where key_sha256 = ${verified.keySha256} and kind = 'scep'`)) as unknown as PermitRow[]
      if (!seen || !seen.enrollment_id) {
        return { outcome: "refused", reason: "no_permit" }
      }
      if (seen.serial !== verified.commonName) {
        return { outcome: "refused", reason: "serial_mismatch" }
      }

      // Lock order: accounts -> enrollments -> devices -> permits.
      const [account] = await lockGateAccount(tx, seen.clerk_user_id)
      const enrollment = await lockEnrollment(tx, seen.enrollment_id)
      if (!enrollment || enrollment.clerk_user_id !== seen.clerk_user_id) {
        return { outcome: "refused", reason: "no_permit" }
      }

      // ── Idempotent repeat finish (Review 1 M2) ─────────────────────────────
      if (enrollment.status === "sealed") {
        if (!enrollment.live || !enrollment.sealed_profile || !enrollment.device_id) {
          return { outcome: "refused", reason: "enrollment_not_live" }
        }
        if (enrollment.serial !== verified.commonName) {
          return { outcome: "refused", reason: "serial_mismatch" }
        }
        if (udidSha256 && !sameBytes(enrollment.udid_sha256, udidSha256)) {
          return { outcome: "refused", reason: "udid_mismatch" }
        }
        const gateRefusal = mintRefusal(account, {
          tenantId: enrollment.tenant_id,
          expectedEpoch: Number(enrollment.expected_epoch),
        })
        if (gateRefusal) {
          return { outcome: "refused", reason: gateRefusal.code }
        }
        if (account!.email.toLowerCase() !== enrollment.email) {
          return { outcome: "refused", reason: "email_mismatch" }
        }

        // Lock permit (accounts -> enrollments -> permits) and ensure this key
        // belongs to the latest SCEP permit of the enrollment (not a superseded one).
        const permit = await lockPermit(tx, seen.id)
        if (
          !permit ||
          permit.enrollment_id !== enrollment.id ||
          !sameBytes(permit.key_sha256, verified.keySha256)
        ) {
          return { outcome: "refused", reason: "no_permit" }
        }
        const [latest] = (await tx.execute(sql`
          select id::text as id from authd.mail_device_cert_permits
           where enrollment_id = ${enrollment.id}
             and kind = 'scep'
           order by created_at desc, id desc
           limit 1`)) as unknown as { id: string }[]
        if (latest?.id !== permit.id) {
          return { outcome: "refused", reason: "no_permit" }
        }
        return {
          outcome: "sealed",
          profile: Buffer.from(enrollment.sealed_profile),
          replayed: true,
        }
      }

      // ── First finish on an attested enrollment ─────────────────────────────
      if (enrollment.status !== "attested" || !enrollment.live) {
        return { outcome: "refused", reason: "enrollment_not_live" }
      }
      if (enrollment.serial !== verified.commonName) {
        return { outcome: "refused", reason: "serial_mismatch" }
      }
      if (udidSha256 && !sameBytes(enrollment.udid_sha256, udidSha256)) {
        return { outcome: "refused", reason: "udid_mismatch" }
      }

      let gateRefusal = mintRefusal(account, {
        tenantId: enrollment.tenant_id,
        expectedEpoch: Number(enrollment.expected_epoch),
      })
      if (!gateRefusal && account!.email.toLowerCase() !== enrollment.email) {
        gateRefusal = new MailDeviceError("email_mismatch", "Account email changed.")
      }
      if (gateRefusal) {
        await tx.execute(sql`
          update authd.mail_device_enrollments
             set status = 'refused', refusal = ${gateRefusal.code}, updated_at = now()
           where id = ${enrollment.id} and status = 'attested'`)
        await tx.execute(expirePermitsForEnrollmentsSql([enrollment.id]))
        return { outcome: "refused", reason: gateRefusal.code }
      }

      // Check the SCEP permit unlocked BEFORE inserting into `mail_devices` so
      // we preserve strict lock order (`mail_devices` before `mail_device_cert_permits`).
      // Nothing can change it under us: attest retries, cancels and every SCEP
      // hook (`lockScepPermit`) take the account and enrollment locks first,
      // and this transaction holds both.
      const [currentPermit] = (await tx.execute(sql`
        select ${PERMIT_COLUMNS} from authd.mail_device_cert_permits
         where id = ${seen.id}`)) as unknown as PermitRow[]
      if (
        !currentPermit ||
        currentPermit.enrollment_id !== enrollment.id ||
        currentPermit.kind !== "scep" ||
        (currentPermit.status !== "authorized" &&
          currentPermit.status !== "notified") ||
        !currentPermit.live ||
        currentPermit.serial !== verified.commonName ||
        !sameBytes(currentPermit.key_sha256, verified.keySha256)
      ) {
        return { outcome: "refused", reason: "no_permit" }
      }

      const platform = enrollment.platform as MailDevicePlatform
      const minted = await mintInTx(tx, deps.keys, {
        clerkUserId: enrollment.clerk_user_id,
        tenantId: enrollment.tenant_id,
        expectedEpoch: Number(enrollment.expected_epoch),
        platform,
        deviceName: enrollment.device_name,
        model: enrollment.product,
        serial: enrollment.serial,
        createdBy: enrollment.created_by,
      })

      let acmeNonce: string | undefined
      if (platform === "macos") {
        const acme = await createAcmePermitInTx(tx, { deviceId: minted.device.id })
        acmeNonce = acme.nonce
      }

      // Now lock & expire the SCEP permit (after `mail_devices` insert: lock order kept).
      const [expiredPermit] = (await tx.execute(sql`
        update authd.mail_device_cert_permits
           set status = 'expired', updated_at = now()
         where id = ${seen.id}
           and enrollment_id = ${enrollment.id}
           and status in ('authorized', 'notified')
           and expires_at > now()
        returning id`)) as unknown as { id: string }[]
      if (!expiredPermit) {
        // Permit lapsed at the exact boundary: roll back the minted device and ACME permit.
        throw new FinishRefusalRollback("no_permit")
      }

      const sealedProfile = buildSealedMobileConfig(
        {
          deviceId: minted.device.id,
          email: minted.device.email,
          platform,
          serial: enrollment.serial!,
          deviceCode: minted.code,
          acmeNonce,
          imapHost: deps.imapHost,
          imapPort: deps.imapPort,
          smtpHost: deps.smtpHost,
          smtpPort: deps.smtpPort,
          organization: deps.organization,
          acmeDirectoryUrl: deps.acmeDirectoryUrl ?? DEFAULT_ACME_DIRECTORY_URL,
        },
        {
          publicKey: verified.cert.publicKey,
          issuerDer: verified.issuerDer,
          serialNumberDer: verified.serialNumberDer,
        },
      )

      await tx.execute(sql`
        update authd.mail_device_enrollments
           set status = 'sealed',
               device_id = ${minted.device.id}::uuid,
               sealed_profile = ${sealedProfile},
               updated_at = now()
         where id = ${enrollment.id}
           and status = 'attested'`)

      const serial = enrollment.serial!
      return {
        outcome: "sealed",
        profile: sealedProfile,
        replayed: false,
        notice: {
          email: minted.device.email,
          deviceId: minted.device.id,
          platform,
          model: enrollment.product ?? platform,
          serialLast4: serial.slice(-4),
        },
      }
    })
  } catch (error) {
    if (error instanceof FinishRefusalRollback) {
      return { outcome: "refused", reason: error.reason }
    }
    throw error
  }
}
