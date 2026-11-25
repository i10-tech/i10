import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm"
import { ts, type Database } from "../db/client.js"
import { accounts, mailDevices } from "../db/schema.js"
import { raiseConnectionCredentialEpochs } from "../projection/connection-epoch.js"
import { raiseCredentialEpoch } from "../projection/credential-epoch.js"
import { MailDeviceError, mintCode, type MailDeviceCodeKeys } from "./code.js"

/**
 * The one store for `authd.mail_devices` (#383).
 *
 * Every API read or write of `authd.mail_devices` goes through this module.
 * `authd` has no row-level security (authd and the mail front read across
 * workspaces), so the tenant filter in `mint`, `list`, `revoke` and `endFor`
 * IS the tenant boundary.
 *
 * Lock order across every revocation and mint:
 *   1. `authd.accounts` first
 *   2. `authd.mail_devices` second
 *
 * `mint` locks the account row (`FOR NO KEY UPDATE OF a`) and checks the gate
 * and `expectedEpoch` before inserting; every revocation writes `authd.accounts`
 * in the same transaction before calling `endFor`. So a mint either commits
 * first (and its device is deleted by the revocation) or waits on the account
 * lock and sees the hold or moved epoch and refuses.
 */

export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0]

export const MAIL_DEVICE_PLATFORMS = ["ios", "ipados", "macos"] as const
export type MailDevicePlatform = (typeof MAIL_DEVICE_PLATFORMS)[number]

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Public columns of one device row. Never carries `codeHash` or `codeKid`. */
export interface MailDeviceRow {
  id: string
  clerkUserId: string
  email: string
  tenantId: string | null
  platform: MailDevicePlatform
  deviceName: string | null
  model: string | null
  serial: string | null
  createdBy: string
  createdAt: Date
  firstUsedAt: Date | null
  lastUsedAt: Date | null
}

const deviceColumns = {
  id: mailDevices.id,
  clerkUserId: mailDevices.clerkUserId,
  email: mailDevices.email,
  tenantId: mailDevices.tenantId,
  platform: mailDevices.platform,
  deviceName: mailDevices.deviceName,
  model: mailDevices.model,
  serial: mailDevices.serial,
  createdBy: mailDevices.createdBy,
  createdAt: mailDevices.createdAt,
  firstUsedAt: mailDevices.firstUsedAt,
  lastUsedAt: mailDevices.lastUsedAt,
}

const toRow = (row: {
  id: string
  clerkUserId: string
  email: string
  tenantId: string | null
  platform: string
  deviceName: string | null
  model: string | null
  serial: string | null
  createdBy: string
  createdAt: Date
  firstUsedAt: Date | null
  lastUsedAt: Date | null
}): MailDeviceRow => ({
  ...row,
  platform: row.platform as MailDevicePlatform,
})

const tenantMatches = (tenantId: string | null) =>
  tenantId === null ? isNull(mailDevices.tenantId) : eq(mailDevices.tenantId, tenantId)

export interface MintInput {
  clerkUserId: string
  tenantId: string | null
  expectedEpoch: number
  platform: MailDevicePlatform
  deviceName?: string | null
  model?: string | null
  serial?: string | null
  createdBy: string
}

export interface MintResult {
  device: MailDeviceRow
  /** Returned once to the caller, never stored or logged. */
  code: string
}

export interface MintGateAccount {
  clerk_user_id: string
  email: string
  active: boolean
  tenant_id: string | null
  credential_epoch: string | number
  suspended: boolean
  payment_hold: boolean
  deleting: boolean
  banned: boolean
  locked: boolean
  domain_not_hosted: boolean
  managed: boolean
  managed_connection: string | null
  connection_inactive: boolean
  sso_required: boolean
  sso_exempt: boolean
}

interface AccountGateRow extends MintGateAccount {
  next_device_id: string
}

/**
 * Pure gate decision for `mint`: checks tenant boundary, active flag, expected
 * credential epoch, and every account/route hold in the same order as authd's
 * `gate.RowRefusal` and `gate.RouteOf`. Returns the `MailDeviceError` refusal,
 * or `null` when minting is allowed.
 */
export function mintRefusal(
  account: MintGateAccount | null | undefined,
  input: Pick<MintInput, "tenantId" | "expectedEpoch">,
): MailDeviceError | null {
  if (!account) {
    return new MailDeviceError("account_not_found", "Mailbox account not found.")
  }
  // Check workspace before revealing any hold or epoch state.
  if ((account.tenant_id ?? null) !== (input.tenantId ?? null)) {
    return new MailDeviceError(
      "tenant_mismatch",
      "Account does not belong to this workspace.",
    )
  }
  if (!account.active) {
    return new MailDeviceError("account_inactive", "Mailbox account is not active.")
  }
  if (Number(account.credential_epoch) !== input.expectedEpoch) {
    return new MailDeviceError(
      "epoch_mismatch",
      "Account credential epoch changed; re-authenticate and retry.",
    )
  }
  if (account.suspended) {
    return new MailDeviceError("mailbox_suspended", "Mailbox is suspended.")
  }
  if (account.deleting) {
    return new MailDeviceError("mailbox_deleting", "Mailbox is scheduled for deletion.")
  }
  if (account.payment_hold) {
    return new MailDeviceError("payment_hold", "Workspace is on payment hold.")
  }
  if (account.domain_not_hosted) {
    return new MailDeviceError("domain_not_hosted", "Domain is not hosting mailboxes.")
  }
  if (account.banned) {
    return new MailDeviceError("account_banned", "Account is banned.")
  }
  if (account.locked) {
    return new MailDeviceError("account_locked", "Account is locked.")
  }
  if (!account.managed && account.sso_required && !account.sso_exempt) {
    return new MailDeviceError(
      "sso_required",
      "SSO sign-in is required for this domain.",
    )
  }
  if (account.managed && !account.managed_connection) {
    return new MailDeviceError(
      "managed_no_connection",
      "Managed account has no SSO connection.",
    )
  }
  if (account.managed && account.connection_inactive) {
    return new MailDeviceError("connection_inactive", "SSO connection is not active.")
  }
  return null
}

/**
 * Mints one mail device code for an account, refusing when the key ring is
 * absent, the account is missing/inactive, its tenant or epoch moved, or any
 * gate hold applies.
 *
 * The device id is generated by Postgres (`uuidv7()`) inside the transaction,
 * never supplied by a caller, so a deleted device can never reappear under its
 * old id.
 */
export async function mint(
  db: Pick<Database, "transaction">,
  keys: MailDeviceCodeKeys | null | undefined,
  input: MintInput,
): Promise<MintResult> {
  if (!keys || !keys.keys.has(keys.currentKid)) {
    throw new MailDeviceError(
      "keys_not_configured",
      "MAIL_DEVICE_CODE_KEYS is not configured.",
    )
  }
  if (!(MAIL_DEVICE_PLATFORMS as readonly string[]).includes(input.platform)) {
    throw new MailDeviceError(
      "invalid_platform",
      `Unsupported mail device platform: ${String(input.platform)}`,
    )
  }

  return db.transaction(async (tx) => {
    // ⚠ LOCK `authd.accounts` FIRST (`FOR NO KEY UPDATE OF a`) so a concurrent
    // revocation either commits before us (and we see the hold or moved epoch
    // and refuse) or waits for us (and deletes the row we insert).
    const rows = (await tx.execute(sql`
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
             ) as sso_exempt,
             uuidv7()::text as next_device_id
        from authd.accounts a
        left join authd.managed_accounts m on m.clerk_user_id = a.clerk_user_id
        left join authd.passthrough_versions pv on pv.connection_id = m.connection_id
       where a.clerk_user_id = ${input.clerkUserId}
         for no key update of a
    `)) as unknown as AccountGateRow[]

    const account = rows[0]
    const refusal = mintRefusal(account, input)
    if (refusal) throw refusal

    const allowed = account!
    const minted = mintCode(keys, allowed.next_device_id)
    const [inserted] = await tx
      .insert(mailDevices)
      .values({
        id: allowed.next_device_id,
        clerkUserId: allowed.clerk_user_id,
        email: allowed.email.toLowerCase(),
        tenantId: allowed.tenant_id,
        platform: input.platform,
        deviceName: input.deviceName ?? null,
        model: input.model ?? null,
        serial: input.serial ?? null,
        codeHash: minted.codeHash,
        codeKid: minted.codeKid,
        createdBy: input.createdBy,
      })
      .returning(deviceColumns)

    return { device: toRow(inserted!), code: minted.code }
  })
}

/** Lists mail devices for one workspace, optionally narrowed to one person. */
export async function list(
  db: Pick<Database, "select">,
  input: { tenantId: string | null; clerkUserId?: string },
): Promise<MailDeviceRow[]> {
  const where = input.clerkUserId
    ? and(tenantMatches(input.tenantId), eq(mailDevices.clerkUserId, input.clerkUserId))
    : tenantMatches(input.tenantId)
  const rows = await db
    .select(deviceColumns)
    .from(mailDevices)
    .where(where)
    .orderBy(desc(mailDevices.createdAt), desc(mailDevices.id))
    .limit(500)
  return rows.map(toRow)
}

/** Revokes (deletes) one device within one workspace. Returns true when a row was deleted. */
export async function revoke(
  db: Pick<Database, "delete">,
  input: { tenantId: string | null; deviceId: string },
): Promise<boolean> {
  if (!UUID.test(input.deviceId)) return false
  const gone = await db
    .delete(mailDevices)
    .where(and(eq(mailDevices.id, input.deviceId), tenantMatches(input.tenantId)))
    .returning({ id: mailDevices.id })
  return gone.length > 0
}

const END_FOR_BATCH = 1000

export type EndForInput =
  | {
      tenantId: string
      clerkUserIds?: readonly string[]
      createdBefore?: Date
    }
  | {
      tenantId: null
      clerkUserIds: readonly string[]
      createdBefore?: Date
    }

/**
 * Deletes the devices of the named people in `tenantId` (or all of `tenantId`'s
 * devices when `clerkUserIds` is omitted for a non-null workspace), optionally
 * only rows created before `createdBefore`.
 *
 * `tenantId: null` (i10's own domain) always requires `clerkUserIds` so a
 * caller can never delete every null-tenant device platform-wide.
 *
 * Callers run this inside their own transaction, AFTER their write to
 * `authd.accounts` (lock order: accounts first, devices second).
 */
export async function endFor(
  tx: Pick<Database, "delete">,
  input: EndForInput,
): Promise<number> {
  const beforeClause = input.createdBefore
    ? sql`${mailDevices.createdAt} < ${ts(input.createdBefore)}`
    : undefined

  if (input.clerkUserIds === undefined) {
    if (input.tenantId === null) {
      throw new Error("endFor requires clerkUserIds when tenantId is null")
    }
    const gone = await tx
      .delete(mailDevices)
      .where(and(eq(mailDevices.tenantId, input.tenantId), beforeClause))
      .returning({ id: mailDevices.id })
    return gone.length
  }

  const ids = [...new Set(input.clerkUserIds)]
  if (ids.length === 0) return 0

  let deleted = 0
  for (let i = 0; i < ids.length; i += END_FOR_BATCH) {
    const slice = ids.slice(i, i + END_FOR_BATCH)
    const gone = await tx
      .delete(mailDevices)
      .where(
        and(
          tenantMatches(input.tenantId),
          inArray(mailDevices.clerkUserId, slice),
          beforeClause,
        ),
      )
      .returning({ id: mailDevices.id })
    deleted += gone.length
  }
  return deleted
}

/**
 * Reconciles a person's devices with the `authd.accounts` row just written by
 * the Clerk projection (`projection/writer.ts` `applyUser`), in the same
 * transaction:
 *   - when the user is banned, every device of theirs is deleted;
 *   - otherwise, any device whose `email` or `tenant_id` no longer matches the
 *     account row is deleted.
 */
export async function reconcileAccountDevices(
  tx: Pick<Database, "delete">,
  input: {
    clerkUserId: string
    email: string
    tenantId: string | null
    banned: boolean
  },
): Promise<number> {
  if (input.banned) {
    const gone = await tx
      .delete(mailDevices)
      .where(eq(mailDevices.clerkUserId, input.clerkUserId))
      .returning({ id: mailDevices.id })
    return gone.length
  }

  const email = input.email.toLowerCase()
  const tenantMismatch =
    input.tenantId === null
      ? sql`${mailDevices.tenantId} is not null`
      : sql`${mailDevices.tenantId} is distinct from ${input.tenantId}::uuid`

  const gone = await tx
    .delete(mailDevices)
    .where(
      and(
        eq(mailDevices.clerkUserId, input.clerkUserId),
        sql`(${mailDevices.email} <> ${email} or ${tenantMismatch})`,
      ),
    )
    .returning({ id: mailDevices.id })
  return gone.length
}

/**
 * Raises one person's `credential_epoch` and ends their mail devices in
 * `tenantId` in ONE transaction (lock order: accounts first, devices second).
 *
 * Used by Okta Universal Logout, user-wide OIDC back-channel logout, user-wide
 * SAML SLO, and device-revoking Okta event hook events.
 */
export async function raiseEpochAndEndDevices(
  db: Pick<Database, "transaction">,
  input: {
    tenantId: string
    clerkUserId: string
    createdBefore?: Date
  },
): Promise<{ devicesEnded: number }> {
  return db.transaction(async (tx) => {
    await raiseCredentialEpoch(tx, input.clerkUserId)
    const devicesEnded = await endFor(tx, {
      tenantId: input.tenantId,
      clerkUserIds: [input.clerkUserId],
      createdBefore: input.createdBefore,
    })
    return { devicesEnded }
  })
}

/**
 * Raises every managed account's `credential_epoch` on a connection and ends
 * their mail devices in `tenantId` in ONE transaction (accounts first, devices
 * second).
 *
 * Used by Okta `application.lifecycle.deactivate` when the event's AppInstance
 * target matches this connection's own Okta app.
 */
export async function raiseConnectionEpochAndEndDevices(
  db: Pick<Database, "transaction">,
  input: {
    tenantId: string
    connectionId: string
    createdBefore?: Date
  },
): Promise<{ accountsRaised: number; devicesEnded: number }> {
  return db.transaction(async (tx) => {
    const raised = await raiseConnectionCredentialEpochs(
      tx,
      input.connectionId,
    ).returning({ clerkUserId: accounts.clerkUserId })
    const clerkUserIds = raised.map((r) => r.clerkUserId)
    const devicesEnded = await endFor(tx, {
      tenantId: input.tenantId,
      clerkUserIds,
      createdBefore: input.createdBefore,
    })
    return { accountsRaised: clerkUserIds.length, devicesEnded }
  })
}

/**
 * Looks up an account by its primary email address (for the operator script).
 */
export async function accountByEmail(
  db: Pick<Database, "select">,
  email: string,
): Promise<{
  clerkUserId: string
  email: string
  tenantId: string | null
  credentialEpoch: number
  active: boolean
} | null> {
  const [row] = await db
    .select({
      clerkUserId: accounts.clerkUserId,
      email: accounts.email,
      tenantId: accounts.tenantId,
      credentialEpoch: accounts.credentialEpoch,
      active: accounts.active,
    })
    .from(accounts)
    .where(eq(accounts.email, email.trim().toLowerCase()))
    .limit(1)
  return row ?? null
}

/**
 * Reads a device row's `tenant_id` for the operator script's `revoke --id`.
 * Never exposed to HTTP routes: API routes always know their caller's tenant.
 */
export async function deviceTenantForOperator(
  db: Pick<Database, "select">,
  deviceId: string,
): Promise<{ exists: boolean; tenantId: string | null }> {
  if (!UUID.test(deviceId)) return { exists: false, tenantId: null }
  const [row] = await db
    .select({ tenantId: mailDevices.tenantId })
    .from(mailDevices)
    .where(eq(mailDevices.id, deviceId))
    .limit(1)
  return row
    ? { exists: true, tenantId: row.tenantId }
    : { exists: false, tenantId: null }
}
